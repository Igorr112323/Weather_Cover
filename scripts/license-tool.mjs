#!/usr/bin/env node
/**
 * Генератор кодов активации — инструмент ВЛАДЕЛЬЦА приложения.
 *
 * Запускается на машине разработчика, в сборку не попадает. Здесь живёт работа
 * с закрытым ключом Ed25519: в приложение уходит только открытый ключ
 * (electron/license/keys.cjs), поэтому выдать себе код из установленного
 * приложения невозможно.
 *
 * Команды:
 *   keygen [--key-id N] [--label TEXT]     создать ключевую пару и обновить keys.cjs
 *   issue  [--count N] [--bind ID] [--key-id N] [--out FILE] [--note TEXT] [--no-ledger]
 *                                          выписать бессрочные коды активации
 *   verify [--machine ID] <код|файл> …      разобрать код и показать, что в нём
 *   revoke <серийник> …                     отозвать лицензию (обновляет keys.cjs)
 *   keys                                    показать открытые ключи и отзывы
 *   fingerprint <короткий или полный id>    отпечаток компьютера для --bind
 *
 * Файлы (оба в .gitignore, в репозиторий не попадают):
 *   secrets/license-key.json   закрытый ключ — единственное, что нужно беречь
 *   secrets/ledger.csv         журнал выданных кодов (серийник → кому выдан)
 *
 * Дат в кодах нет: лицензия бессрочная, и аргумента «действует до» у issue нет
 * намеренно — выдать код со сроком этим инструментом нельзя.
 */

import { createRequire } from "node:module";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const core = require("../electron/license/core.cjs");

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const KEYS_FILE = path.join(ROOT, "electron", "license", "keys.cjs");
const SECRET_FILE = process.env.AGRO_LICENSE_KEY_FILE
  ? path.resolve(process.env.AGRO_LICENSE_KEY_FILE)
  : path.join(ROOT, "secrets", "license-key.json");
const LEDGER_FILE = path.join(ROOT, "secrets", "ledger.csv");

const USAGE = `АгроПрогноз — инструмент владельца лицензий.

  npm run license:keygen                       создать закрытый ключ (один раз)
  npm run license:issue -- --count 5           выписать 5 бессрочных кодов
  npm run license:issue -- --bind ZZG5-9ZKT    код, привязанный к компьютеру
  npm run license:issue -- --out codes.txt     коды в файл (и запись в журнал)
  node scripts/license-tool.mjs verify <код>   разобрать код
  node scripts/license-tool.mjs revoke <серийник>   отозвать лицензию
  node scripts/license-tool.mjs keys           открытые ключи и отзывы

Закрытый ключ: ${rel(SECRET_FILE)} — в репозиторий не попадает, без него новые
коды выписать нельзя. Дат в кодах нет: лицензия бессрочная.`;

/* ── Аргументы ───────────────────────────────────────────────────────────── */

function parseArgs(argv) {
  const [command = "", ...rest] = argv;
  const flags = {};
  const positional = [];
  for (let index = 0; index < rest.length; index += 1) {
    const item = rest[index];
    if (item.startsWith("--")) {
      const name = item.slice(2);
      const next = rest[index + 1];
      if (next === undefined || next.startsWith("--")) flags[name] = true;
      else {
        flags[name] = next;
        index += 1;
      }
    } else positional.push(item);
  }
  return { command, flags, positional };
}

function rel(target) {
  return path.relative(ROOT, target) || ".";
}

function fail(message) {
  console.error(`\n✘ ${message}\n`);
  process.exit(1);
}

/* ── Ключи ───────────────────────────────────────────────────────────────── */

function privateKeyObject(base64) {
  return crypto.createPrivateKey({ key: Buffer.from(base64, "base64"), format: "der", type: "pkcs8" });
}

function publicBase64FromPrivate(base64) {
  return crypto
    .createPublicKey(privateKeyObject(base64))
    .export({ format: "der", type: "spki" })
    .toString("base64");
}

async function readSecret() {
  // Ключ из окружения — для CI и для работы без файла на диске.
  const fromEnv = process.env.AGRO_LICENSE_SECKEY;
  if (fromEnv) {
    const keyId = Number(process.env.AGRO_LICENSE_KEY_ID ?? 1);
    return {
      keys: [
        {
          keyId,
          label: process.env.AGRO_LICENSE_KEY_LABEL ?? "env",
          privateKey: fromEnv,
          publicKey: publicBase64FromPrivate(fromEnv),
        },
      ],
    };
  }
  if (!existsSync(SECRET_FILE)) {
    fail(`Закрытый ключ не найден: ${rel(SECRET_FILE)}\n  Сначала выполните  npm run license:keygen  и сохраните файл в надёжном месте.`);
  }
  try {
    const parsed = JSON.parse(await readFile(SECRET_FILE, "utf8"));
    const list = Array.isArray(parsed?.keys) ? parsed.keys : Array.isArray(parsed) ? parsed : [parsed];
    return { keys: list.filter((entry) => entry && typeof entry.privateKey === "string") };
  } catch (error) {
    fail(`Файл закрытого ключа повреждён: ${error.message}`);
  }
  return { keys: [] };
}

/** Текущее содержимое keys.cjs: открытые ключи и отозванные серийники. */
function readKeysModule() {
  if (!existsSync(KEYS_FILE)) return { keys: [], revokedSerials: [] };
  delete require.cache[require.resolve(KEYS_FILE)];
  const loaded = require(KEYS_FILE);
  return {
    keys: Array.isArray(loaded?.keys) ? loaded.keys : [],
    revokedSerials: Array.isArray(loaded?.revokedSerials) ? loaded.revokedSerials : [],
  };
}

async function writeKeysModule({ keys, revokedSerials }) {
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
  await writeFile(KEYS_FILE, body, "utf8");
}

async function commandKeygen(flags) {
  const existing = existsSync(SECRET_FILE) ? (await readSecret()).keys : [];
  const maxKeyId = existing.length ? Math.max(...existing.map((entry) => Number(entry.keyId) || 0)) : 0;
  const keyId = Number(flags["key-id"] ?? maxKeyId + 1);
  if (!Number.isInteger(keyId) || keyId < 1 || keyId > 255) fail("--key-id — целое число от 1 до 255");
  if (existing.some((entry) => entry.keyId === keyId)) fail(`Ключ с key-id=${keyId} уже есть в ${rel(SECRET_FILE)}`);

  const label = String(flags.label ?? (keyId === 1 ? "production" : `production-${keyId}`));
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
  const entry = {
    keyId,
    label,
    algorithm: "ed25519",
    privateKey: privateKey.export({ format: "der", type: "pkcs8" }).toString("base64"),
    publicKey: publicKey.export({ format: "der", type: "spki" }).toString("base64"),
  };

  await mkdir(path.dirname(SECRET_FILE), { recursive: true });
  await writeFile(SECRET_FILE, `${JSON.stringify({ keys: [...existing, entry] }, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });

  const published = readKeysModule();
  const keys = [
    ...published.keys.filter((item) => item.keyId !== keyId),
    { keyId, label, publicKey: entry.publicKey },
  ].sort((a, b) => a.keyId - b.keyId);
  await writeKeysModule({ keys, revokedSerials: published.revokedSerials });

  console.log(`\n✔ Ключ key-id=${keyId} (${label}) создан.`);
  console.log(`  Закрытый ключ: ${rel(SECRET_FILE)}  ← никому не передавать, в git не попадает`);
  console.log(`  Открытый ключ записан в ${rel(KEYS_FILE)} (его можно коммитить)`);
  console.log("\n  Сделайте резервную копию secrets/license-key.json вне репозитория:");
  console.log("  без неё выписать новые коды активации будет невозможно.\n");
}

async function commandIssue(flags) {
  const secret = await readSecret();
  if (!secret.keys.length) fail("Закрытый ключ не найден — выполните npm run license:keygen");

  const keyId = flags["key-id"] === undefined ? secret.keys[secret.keys.length - 1].keyId : Number(flags["key-id"]);
  const key = secret.keys.find((entry) => entry.keyId === keyId);
  if (!key) fail(`В ${rel(SECRET_FILE)} нет ключа с key-id=${keyId}`);

  const published = readKeysModule();
  if (!published.keys.some((entry) => entry.keyId === keyId)) {
    fail(`Открытый ключ key-id=${keyId} не добавлен в ${rel(KEYS_FILE)} — приложение такой код не примет`);
  }

  const count = Number(flags.count ?? 1);
  if (!Number.isInteger(count) || count < 1 || count > 1000) fail("--count — целое число от 1 до 1000");

  let bound = false;
  let shortId = "";
  if (typeof flags.bind === "string" && flags.bind.trim()) {
    const resolved = core.resolveBindTarget(flags.bind);
    if (!resolved.ok) fail(`--bind: ${resolved.message}`);
    bound = true;
    shortId = resolved.shortId;
  }

  const signer = privateKeyObject(key.privateKey);
  const rows = [];
  for (let index = 0; index < count; index += 1) {
    const payload = bound
      ? bindPayload({ keyId, shortId })
      : core.buildPayload({ keyId, bound: false });
    const signature = crypto.sign(null, Buffer.from(payload), signer);
    rows.push({
      serialHex: Buffer.from(payload.subarray(4, 4 + core.SERIAL_BYTES)).toString("hex"),
      code: core.formatCode(Buffer.concat([Buffer.from(payload), Buffer.from(signature)])),
      keyId,
      bound,
      shortId,
    });
  }

  if (flags.out) {
    const target = path.resolve(String(flags.out));
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, `${rows.map((row) => row.code).join("\n")}\n`, { encoding: "utf8", mode: 0o600 });
  }
  if (!flags["no-ledger"]) {
    const ledger = path.resolve(String(flags.ledger ?? LEDGER_FILE));
    await mkdir(path.dirname(ledger), { recursive: true });
    const header = existsSync(ledger) ? "" : "serial;keyId;bound;shortId;code;note\n";
    const note = String(flags.note ?? "").replace(/[\r\n;]/g, " ");
    const lines = rows.map((row) => `${row.serialHex};${row.keyId};${row.bound ? "yes" : "no"};${row.shortId};${row.code};${note}`);
    await appendFile(ledger, header + lines.join("\n") + "\n", { encoding: "utf8", mode: 0o600 });
    console.log(`Журнал: ${rel(ledger)}`);
  }
  if (flags.out) console.log(`Файл:   ${rel(path.resolve(String(flags.out)))}`);

  console.log(
    `\nВыписано кодов: ${rows.length} · ключ key-id=${keyId} · лицензия БЕССРОЧНАЯ` +
      (bound ? ` · привязка к компьютеру ${core.prettyShortId(shortId)}` : "") +
      "\n",
  );
  for (const row of rows) {
    console.log(`  Серийник ${core.prettySerial(row.serialHex)}`);
    console.log(`  ${row.code}\n`);
  }
  if (!flags.out) console.log("  Подсказка: --out codes.txt сохранит коды в файл, --note «Иванов» — пометку в журнал.\n");
}

/**
 * Персональный код: отпечаток считается от короткого идентификатора, поэтому
 * достаточно того, что пользователь продиктовал с экрана активации.
 */
function bindPayload({ keyId, shortId }) {
  const payload = core.buildPayload({ keyId, bound: true });
  payload.set(core.fingerprintFromShortId(shortId), core.PAYLOAD_LENGTH - 4);
  return payload;
}

async function commandVerify(positional, flags) {
  if (!positional.length) fail("Укажите код или путь к файлу с кодом");
  const published = readKeysModule();
  if (!published.keys.length) fail(`В ${rel(KEYS_FILE)} нет открытых ключей`);

  let machineId = "";
  let machineShortId = "";
  if (typeof flags.machine === "string" && flags.machine.trim()) {
    const resolved = core.resolveBindTarget(flags.machine);
    if (!resolved.ok) fail(`--machine: ${resolved.message}`);
    machineShortId = resolved.shortId;
  }

  for (const arg of positional) {
    const text = existsSync(arg) ? await readFile(arg, "utf8") : arg;
    const result = core.verifyCode({
      code: text,
      keys: published.keys,
      machineId,
      machineShortId,
      revokedSerials: published.revokedSerials,
    });
    console.log("");
    if (result.ok) {
      const license = result.license;
      console.log("✔ Код действителен (подпись совпала)");
      console.log(`  Продукт:  ${license.productName} (id=${license.productId})`);
      console.log(`  Серийник: ${license.serial}`);
      console.log(`  Ключ:     key-id=${license.keyId}`);
      console.log("  Срок:     бессрочно — дата в коде не кодируется и не проверяется");
      console.log(
        license.bound
          ? `  Привязка: к компьютеру, отпечаток ${license.fingerprintHex}${machineId ? " — совпал с --machine" : " — для сверки добавьте --machine <id>"}`
          : "  Привязка: нет, код работает на любом компьютере",
      );
    } else {
      console.log(`✘ Код не принят: ${result.reason}`);
      console.log(`  ${reasonText(result.reason)}`);
    }
  }
  console.log("");
}

function reasonText(reason) {
  const texts = {
    EMPTY: "Код пустой.",
    MALFORMED: "В коде посторонние символы или нарушена структура.",
    LENGTH: "Длина кода не соответствует формату.",
    VERSION: "Код выпущен для другой версии формата — нужен новый код.",
    PRODUCT: "Код от другого продукта.",
    UNKNOWN_KEY: "В приложении нет открытого ключа для этого кода.",
    SIGNATURE: "Подпись не совпадает: код изменён или выдуман.",
    REVOKED: "Лицензия отозвана владельцем приложения.",
    MACHINE_MISMATCH: "Код выписан для другого компьютера.",
    MACHINE_UNKNOWN: "Не удалось определить идентификатор этого компьютера.",
  };
  return texts[reason] ?? "Неизвестная причина.";
}

async function commandRevoke(serials) {
  if (!serials.length) fail("Укажите серийные номера (hex, как их печатают issue и verify)");
  const published = readKeysModule();
  const revoked = new Set(published.revokedSerials.map((value) => value.toLowerCase()));
  for (const raw of serials) {
    const clean = raw.replace(/[^0-9a-fA-F]/g, "").toLowerCase();
    if (clean.length !== core.SERIAL_BYTES * 2) fail(`Серийник «${raw}» не похож на ${core.SERIAL_BYTES * 2} hex-символов`);
    revoked.add(clean);
  }
  await writeKeysModule({ keys: published.keys, revokedSerials: [...revoked].sort() });
  console.log(`\n✔ Отозвано лицензий: ${revoked.size}. Обновлён ${rel(KEYS_FILE)}`);
  console.log("  Код с этим серийником перестанет активироваться в следующей сборке приложения.\n");
}

async function commandKeys() {
  const published = readKeysModule();
  console.log(`\n${rel(KEYS_FILE)}`);
  if (!published.keys.length) console.log("  (пусто — выполните npm run license:keygen)");
  for (const entry of published.keys) console.log(`  key-id=${entry.keyId} · ${entry.label || "-"} · ${entry.publicKey.slice(0, 20)}…`);
  console.log(`  Отозванных лицензий: ${published.revokedSerials.length}`);
  const secret = existsSync(SECRET_FILE) ? await readSecret() : { keys: [] };
  console.log(`  Закрытых ключей локально: ${secret.keys.length} (${rel(SECRET_FILE)})\n`);
}

function commandFingerprint(args) {
  if (!args.length) fail("Укажите идентификатор компьютера — тот, что показывает экран активации");
  console.log("");
  for (const arg of args) {
    const resolved = core.resolveBindTarget(arg);
    if (!resolved.ok) {
      console.log(`  ${arg}\n    ✘ ${resolved.message}\n`);
      continue;
    }
    console.log(`  ${arg}`);
    console.log(`    короткий id: ${core.prettyShortId(resolved.shortId)}`);
    console.log(`    отпечаток:   ${Buffer.from(core.fingerprintFromShortId(resolved.shortId)).toString("hex")}`);
    console.log(`    код:         license:issue -- --bind ${core.prettyShortId(resolved.shortId)}\n`);
  }
}

/* ── Запуск ──────────────────────────────────────────────────────────────── */

const { command, flags, positional } = parseArgs(process.argv.slice(2));

switch (command) {
  case "keygen":
    await commandKeygen(flags);
    break;
  case "issue":
    await commandIssue(flags);
    break;
  case "verify":
    await commandVerify(positional, flags);
    break;
  case "revoke":
    await commandRevoke(positional);
    break;
  case "keys":
    await commandKeys();
    break;
  case "fingerprint":
    commandFingerprint(positional);
    break;
  case "help":
  case "--help":
  case "-h":
  case "":
    console.log(`\n${USAGE}\n`);
    break;
  default:
    console.log(`\n${USAGE}\n`);
    fail(`Неизвестная команда «${command}»`);
}
