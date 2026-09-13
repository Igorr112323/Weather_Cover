/**
 * Общая библиотека инструментов владельца лицензий.
 *
 * Ей пользуются scripts/license-tool.mjs (командная строка) и «Студия
 * лицензий» (scripts/license-studio) — чтобы закрытый ключ, файл открытых
 * ключей keys.cjs и журнал выдачи всегда обрабатывались одинаково.
 *
 * Здесь живёт всё, что связано с ВЫДАЧЕЙ кодов:
 *   • чтение закрытого ключа (secrets/license-key.json или переменная
 *     окружения AGRO_LICENSE_SECKEY — для CI-проверок);
 *   • выписывание кода: Ed25519-подпись нагрузки (привязанной к компьютеру
 *     или универсальной) и форматирование в текст «AGRO-…»;
 *   • чтение/запись electron/license/keys.cjs (открытые ключи + отзывы);
 *   • журнал выдачи secrets/ledger.csv.
 *
 * ЛИЦЕНЗИЯ БЕССРОЧНАЯ: в коде активации нет поля даты, и выписать код «до
 * такого-то числа» этой библиотекой невозможно. Дата появляется только в
 * журнале выдачи — для учёта, и на работу лицензии не влияет.
 *
 * Файловые операции принимаются параметрами (io), поэтому unit-тесты
 * проверяют всё без диска. Модуль используется только на машине владельца:
 * в сборку приложения он не попадает (scripts/ исключены из app.asar).
 */

import { createRequire } from "node:module";
import crypto from "node:crypto";

const require = createRequire(import.meta.url);
const core = require("../electron/license/core.cjs");

/* ── Ключи ───────────────────────────────────────────────────────────────── */

/** DER (PKCS#8) base64 → объект закрытого ключа Ed25519. */
export function privateKeyObject(base64) {
  return crypto.createPrivateKey({ key: Buffer.from(String(base64), "base64"), format: "der", type: "pkcs8" });
}

/** Открытый ключ (SPKI base64), выведенный из закрытого. */
export function publicBase64FromPrivate(base64) {
  return crypto
    .createPublicKey(privateKeyObject(base64))
    .export({ format: "der", type: "spki" })
    .toString("base64");
}

/**
 * Читает закрытые ключи: файл (по умолчанию secrets/license-key.json) или
 * переменные окружения AGRO_LICENSE_SECKEY / AGRO_LICENSE_KEY_ID / AGRO_LICENSE_PUBKEY.
 * @param {{secretFile?:string, env?:object, readFile?:(p:string)=>Promise<string>, existsSync?:(p:string)=>boolean}} options
 */
export async function readSecret(options = {}) {
  const env = options.env ?? process.env;
  const fromEnv = env.AGRO_LICENSE_SECKEY;
  if (fromEnv) {
    const keyId = Number(env.AGRO_LICENSE_KEY_ID ?? 1);
    return {
      keys: [
        {
          keyId,
          label: env.AGRO_LICENSE_KEY_LABEL ?? "env",
          privateKey: fromEnv,
          publicKey: env.AGRO_LICENSE_PUBKEY ?? publicBase64FromPrivate(fromEnv),
        },
      ],
    };
  }
  const secretFile = options.secretFile;
  if (typeof options.existsSync === "function" ? !options.existsSync(secretFile) : true) {
    const error = new Error(`Закрытый ключ не найден: ${secretFile}\nСначала выполните  npm run license:keygen  и сохраните файл в надёжном месте.`);
    error.code = "NO_SECRET";
    throw error;
  }
  let parsed;
  try {
    const text = await options.readFile(secretFile);
    parsed = JSON.parse(text);
  } catch (cause) {
    const error = new Error(`Файл закрытого ключа повреждён: ${cause.message}`);
    error.code = "BAD_SECRET";
    throw error;
  }
  const list = Array.isArray(parsed?.keys) ? parsed.keys : Array.isArray(parsed) ? parsed : [parsed];
  return { keys: list.filter((entry) => entry && typeof entry.privateKey === "string") };
}

/** Текущее содержимое keys.cjs: открытые ключи и отозванные серийники. */
export function readKeysModule(keysFile, io = {}) {
  const exists = io.existsSync ?? (() => false);
  if (!exists(keysFile)) return { keys: [], revokedSerials: [] };
  const loadModule =
    io.loadModule ??
    ((file) => {
      delete require.cache[require.resolve(file)];
      return require(file);
    });
  const loaded = loadModule(keysFile);
  return {
    keys: Array.isArray(loaded?.keys) ? loaded.keys : [],
    revokedSerials: Array.isArray(loaded?.revokedSerials) ? loaded.revokedSerials : [],
  };
}

/** Записывает keys.cjs в единственном известном формате (его читает сборка). */
export async function writeKeysModule(keysFile, { keys, revokedSerials }, io = {}) {
  const keyLines = keys.map(
    (entry) => `    { keyId: ${entry.keyId}, label: ${JSON.stringify(entry.label ?? "")}, publicKey:\n      "${entry.publicKey}" },`,
  );
  const revokedLines = revokedSerials.map((serial) => `    "${serial}",`);
  const body = `/**
 * Открытые ключи лицензий и список отозванных лицензий.
 *
 * Файл создаётся командой  npm run license:keygen  (scripts/license-tool.mjs)
 * и является единственной доверенной точкой проверки подписи в приложении.
 * Закрытого ключа здесь нет и быть не должно: он хранится у владельца
 * приложения в secrets/license-key.json (каталог в .gitignore).
 *
 * revokedSerials — серийные номера (hex, 16 символов) лицензий, которые
 * владелец отозвал: такой код перестанет активироваться в следующей сборке.
 */

"use strict";

module.exports = {
  keys: [
${keyLines.join("\n") || ""}
  ],
  revokedSerials: [
${revokedLines.join("\n") || ""}
  ],
};
`;
  await io.writeFile(keysFile, body, "utf8");
}

/* ── Выписывание кода ────────────────────────────────────────────────────── */

/**
 * Персональный код: отпечаток считается от короткого идентификатора
 * компьютера (то, что покупатель продиктовал с экрана активации).
 */
function bindPayload({ keyId, shortId, serial }) {
  const payload = core.buildPayload({ keyId, bound: true, serial });
  payload.set(core.fingerprintFromShortId(shortId), core.PAYLOAD_LENGTH - 4);
  return payload;
}

/**
 * Выписывает один код активации и самопроверяет его открытым ключом.
 *
 * @param {{privateKeyBase64?:string, privateKey?:import("node:crypto").KeyObject,
 *          keyId:number, bound?:boolean, shortId?:string, serial?:Uint8Array}} input
 * @returns {{code:string, serialHex:string, payload:Uint8Array}}
 */
export function buildLicenseCode(input) {
  const signer = input.privateKey ?? privateKeyObject(input.privateKeyBase64);
  const { keyId, bound = false, shortId = "" } = input;
  const payload = bound
    ? bindPayload({ keyId, shortId, serial: input.serial })
    : core.buildPayload({ keyId, serial: input.serial, bound: false });
  const signature = crypto.sign(null, Buffer.from(payload), signer);
  const bytes = Buffer.concat([Buffer.from(payload), Buffer.from(signature)]);
  return {
    payload,
    code: core.formatCode(bytes),
    serialHex: Buffer.from(payload.subarray(4, 4 + core.SERIAL_BYTES)).toString("hex"),
  };
}

/** Короткий код компьютера: любое написание или полный 64-hex идентификатор. */
export function normalizeMachineCode(raw) {
  const resolved = core.resolveBindTarget(raw);
  if (resolved.ok) return resolved;
  return { ok: false, message: resolved.message };
}

/* ── Журнал выдачи ───────────────────────────────────────────────────────── */

/**
 * Журнал выдачи — единственное место, где появляются даты: это учёт владельца
 * («когда и кому выписан код»), на работу лицензии он не влияет.
 *
 * Формат (после заголовка):
 *   issuedAt;serial;keyId;kind;shortId;code;name;phone;email;note;status;revokedAt;replaces
 *
 * kind     personal | universal
 * status   active | revoked
 * replaces серийник прежней лицензии, которую этот код заменил (перевыпуск
 *          после переустановки Windows), либо пусто
 *
 * Старый формат license-tool (serial;keyId;bound;shortId;code;note) читается
 * и при первой же записи переводится в новый.
 */
export const LEDGER_COLUMNS = Object.freeze([
  "issuedAt",
  "serial",
  "keyId",
  "kind",
  "shortId",
  "code",
  "name",
  "phone",
  "email",
  "note",
  "status",
  "revokedAt",
  "replaces",
]);

export const LEDGER_HEADER = LEDGER_COLUMNS.join(";");

/** Значение для CSV-ячейки: без переводов строк и точек с запятой. */
export function ledgerCell(value, maxLength = 200) {
  return String(value ?? "")
    .replace(/[\r\n;]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

function legacyRow(cells) {
  const [serial, keyId, bound, shortId, code, note = ""] = cells;
  return {
    issuedAt: "",
    serial: String(serial ?? "").toLowerCase(),
    keyId: Number(keyId) || 1,
    kind: bound === "yes" ? "personal" : "universal",
    shortId: String(shortId ?? ""),
    code: String(code ?? ""),
    name: "",
    phone: "",
    email: "",
    note,
    status: "active",
    revokedAt: "",
    replaces: "",
  };
}

/**
 * Разбирает журнал: новый формат (по заголовку), старый формат license-tool и
 * файл без заголовка.
 * @param {string} text
 */
export function parseLedger(text) {
  const lines = String(text ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (!lines.length) return [];

  const first = lines[0];
  if (first === LEDGER_HEADER || first.startsWith("issuedAt;")) {
    const header = first.split(";");
    return lines.slice(1).map((line) => {
      const cells = line.split(";");
      const row = {};
      header.forEach((column, index) => {
        row[column] = cells[index] ?? "";
      });
      // Обязательные поля приводятся к виду даже при ручной правке файла.
      row.serial = String(row.serial ?? "").toLowerCase();
      row.keyId = Number(row.keyId) || 1;
      row.status = row.status === "revoked" ? "revoked" : "active";
      return row;
    });
  }

  // Старый формат: serial;keyId;bound;shortId;code;note (с заголовком или без).
  return lines
    .filter((line) => !line.startsWith("serial;"))
    .map((line) => legacyRow(line.split(";")));
}

/** Записывает журнал целиком (новый формат, с заголовком). */
export function serializeLedger(rows) {
  const lines = (Array.isArray(rows) ? rows : []).map((row) =>
    LEDGER_COLUMNS.map((column) => ledgerCell(row[column] ?? "")).join(";"),
  );
  return [LEDGER_HEADER, ...lines].join("\n") + "\n";
}

/** Полная перезапись журнала (новый формат, атомарно). */
export async function saveLedger(ledgerFile, rows, io = {}) {
  const body = serializeLedger(rows);
  const tempFile = `${ledgerFile}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  await io.writeFile(tempFile, body, { encoding: "utf8", mode: 0o600 });
  await io.rename(tempFile, ledgerFile);
  return rows;
}

/**
 * Добавляет записи в журнал. Если файл был в старом формате — целиком
 * переводится в новый (старые строки сохраняются).
 *
 * @param {string} ledgerFile путь к secrets/ledger.csv
 * @param {Array<object>} rows новые записи
 * @param {{readFile?:Function, writeFile?:Function, rename?:Function, existsSync?:Function}} io
 */
export async function appendLedgerRows(ledgerFile, rows, io = {}) {
  const exists = io.existsSync ?? (() => false);
  let current = [];
  if (exists(ledgerFile)) {
    current = parseLedger(await io.readFile(ledgerFile, "utf8"));
  }
  return saveLedger(ledgerFile, [...current, ...rows], io);
}

/** Дата-время для журнала выдачи (только для учёта, не для лицензии). */
export function ledgerNow(now = undefined) {
  const date = now ? new Date(now) : new Date();
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/* ── Тексты для покупателя ───────────────────────────────────────────────── */

/** Текст сообщения покупателю о выданном коде. Дат и сроков в нём нет. */
export function buildBuyerMessage({ name = "", code, shortId = "", serialHex = "", universal = false } = {}) {
  const lines = [];
  lines.push(name ? `${name}, здравствуйте!` : "Здравствуйте!");
  lines.push("");
  lines.push("Ваш код активации «АгроПрогноз — Кукуруза» (лицензия бессрочная):");
  lines.push("");
  lines.push(code);
  lines.push("");
  if (universal) {
    lines.push("Код универсальный: работает на любом компьютере. Пожалуйста, не передавайте его дальше — он закреплён за вами.");
  } else {
    lines.push(`Код персональный: работает только на компьютере ${core.prettyShortId(shortId)}.`);
  }
  lines.push("Введите его на экране активации при первом запуске — дальше приложение открывается без кода. Пробелы и переносы строк при вводе не мешают.");
  lines.push(`Серийный номер лицензии: ${core.prettySerial(serialHex)} (назовите его при обращении в поддержку).`);
  return lines.join("\n");
}

/** Короткое сообщение для СМС: код и самая необходимая подсказка. */
export function buildBuyerSms({ code, shortId = "", universal = false } = {}) {
  const bind = universal ? "работает на любом компьютере" : `только для компьютера ${core.prettyShortId(shortId)}`;
  return `АгроПрогноз: код активации ${code} (${bind}). Лицензия бессрочная. Полная инструкция — в письме.`;
}

/** Содержимое файла .agrolic: человек читает шапку, приложение находит код. */
export function buildAgrolicContent({ name = "", shortId = "", serialHex = "", code, universal = false } = {}) {
  return [
    "АгроПрогноз — Кукуруза — файл лицензии",
    `Кому: ${name || "покупателю"}`,
    universal ? "Код компьютера: — (код универсальный)" : `Код компьютера: ${core.prettyShortId(shortId)}`,
    `Серийный номер: ${core.prettySerial(serialHex)}`,
    "Лицензия: бессрочная, без ограничения по дате",
    "",
    "Вставьте код ниже в поле «Код активации» или активируйте приложением этим файлом:",
    "",
    code,
    "",
  ].join("\n");
}

/** Имя файла .agrolic — по серийнику: каждый файл однозначно свой. */
export function agrolicFileName(serialHex) {
  return `agroprognoz-license-${String(serialHex ?? "").toLowerCase()}.agrolic`;
}
