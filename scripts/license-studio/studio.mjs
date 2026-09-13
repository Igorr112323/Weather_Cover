/**
 * Ядро «Студии лицензий» — программы владельца для выдачи кодов активации.
 *
 * Сценарий: покупатель присылает заявку (кнопка «Отправить заявку владельцу»
 * на экране активации), владелец вставляет код компьютера в форму, заполняет
 * имя/телефон/почту и получает персональный код, готовое сообщение и файл
 * .agrolic. Всё это — офлайн, на машине владельца: закрытый ключ не покидает
 * этот компьютер и не попадает ни в репозиторий, ни в CI, ни в сборку.
 *
 * ЛИЦЕНЗИЯ БЕССРОЧНАЯ: у выданного кода нет срока действия, поля «действует
 * до» в студии не существует. Дата появляется только в журнале выдачи
 * (secrets/ledger.csv) — для учёта, кому и когда выдан код.
 *
 * Вся логика — чистые функции с внедрённым файловым слоем (io), поэтому
 * unit-тесты (tests/license-studio.test.mjs) проверяют выдачу, перевыпуск,
 * отзыв и журнал без диска и без настоящего закрытого ключа.
 */

import { createRequire } from "node:module";
import { existsSync as fsExistsSync } from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

import {
  agrolicFileName,
  appendLedgerRows,
  buildAgrolicContent,
  buildBuyerMessage,
  buildBuyerSms,
  buildLicenseCode,
  ledgerCell,
  ledgerNow,
  normalizeMachineCode,
  parseLedger,
  privateKeyObject,
  readKeysModule,
  readSecret,
  saveLedger,
  writeKeysModule,
} from "../license-shared.mjs";
import { TEST_PHONE, deliveryCapabilities, sendEmail, sendSms, sendTelegram } from "./delivery.mjs";

const require = createRequire(import.meta.url);
const core = require("../../electron/license/core.cjs");

/** Ошибки, которые показываются формой как есть. */
export class StudioError extends Error {
  constructor(message, extra = {}) {
    super(message);
    this.name = "StudioError";
    this.extra = extra;
  }
}

/** Отказ с данными для формы: не исключение, а обычный ответ. */
function reject(message, extra = {}) {
  return { ok: false, message, ...extra };
}

/**
 * @param {object} options
 * @param {string} options.root корень репозитория
 * @param {object} [options.env] окружение (ключи доставки; по умолчанию process.env)
 * @param {object} [options.io] файловый слой для тестов: readFile, writeFile, rename, existsSync, loadModule
 * @param {() => (string|number)} [options.now] часы — ТОЛЬКО для журнала выдачи
 */
export function createStudio(options = {}) {
  const root = options.root;
  const env = options.env ?? process.env;
  const io = options.io ?? {};
  const now = options.now ?? (() => Date.now());

  const files = {
    secret: env.AGRO_LICENSE_KEY_FILE ? path.resolve(env.AGRO_LICENSE_KEY_FILE) : path.join(root, "secrets", "license-key.json"),
    keys: path.join(root, "electron", "license", "keys.cjs"),
    ledger: path.join(root, "secrets", "ledger.csv"),
  };

  // По умолчанию — настоящий файловый слой; тесты подменяют его через options.io.
  const readFile = io.readFile ?? ((file) => fsp.readFile(file, "utf8"));
  const writeFile = io.writeFile ?? ((file, body, opts) => fsp.writeFile(file, body, opts));
  const rename = io.rename ?? ((from, to) => fsp.rename(from, to));
  const existsSync = io.existsSync ?? fsExistsSync;
  const loadModule = io.loadModule ?? ((file) => {
    delete require.cache[require.resolve(file)];
    return require(file);
  });
  const fsIo = { readFile, writeFile, rename, existsSync, loadModule };

  /* ── Чтение состояния ─────────────────────────────────────────────────── */

  async function secret() {
    const found = await readSecret({ secretFile: files.secret, env, ...fsIo });
    if (!found.keys.length) throw new StudioError(`Закрытый ключ не найден: ${path.relative(root, files.secret)}`, { code: "NO_SECRET" });
    return found;
  }

  function published() {
    return readKeysModule(files.keys, fsIo);
  }

  async function loadLedger() {
    if (!existsSync(files.ledger)) return [];
    const rows = parseLedger(await readFile(files.ledger, "utf8"));
    // keys.cjs — источник правды об отзывах: даже старый журнал без колонки
    // статуса показывает отозванные коды как отозванные.
    const revoked = new Set(published().revokedSerials.map((value) => String(value).toLowerCase()));
    return rows.map((row) => (revoked.has(row.serial) ? { ...row, status: "revoked" } : row));
  }

  /** Состояние для формы: ключи, журнал, каналы доставки. */
  async function state() {
    const found = await secret();
    const keysModule = published();
    const ledger = await loadLedger();
    return {
      ok: true,
      permanent: true,
      terms: "Лицензия бессрочная: поле «действует до» не существует",
      productName: core.PRODUCT_NAME,
      keys: keysModule.keys.map((entry) => ({ keyId: entry.keyId, label: entry.label, publicKey: entry.publicKey })),
      keyIdsWithSecret: found.keys.map((entry) => entry.keyId),
      revokedCount: keysModule.revokedSerials.length,
      delivery: { ...deliveryCapabilities(env), testPhone: TEST_PHONE },
      ledger,
    };
  }

  /* ── Отзыв ────────────────────────────────────────────────────────────── */

  /** Отзывает серийник: keys.cjs (следующая сборка его не примет) + журнал. */
  async function revokeInternal(serialHex, reason = "") {
    const serial = String(serialHex ?? "").toLowerCase();
    const keysModule = published();
    const revoked = new Set(keysModule.revokedSerials.map((value) => String(value).toLowerCase()));
    revoked.add(serial);
    await writeKeysModule(files.keys, { keys: keysModule.keys, revokedSerials: [...revoked].sort() }, fsIo);

    const ledger = await loadLedger();
    let row = ledger.find((item) => item.serial === serial);
    if (row) {
      row.status = "revoked";
      row.revokedAt = ledgerNow(now());
      if (reason) row.note = ledgerCell(`${row.note ? `${row.note} ` : ""}[${reason}]`).slice(0, 200);
    } else {
      row = {
        issuedAt: "",
        serial,
        keyId: keysModule.keys[0]?.keyId ?? 1,
        kind: "unknown",
        shortId: "",
        code: "",
        name: "",
        phone: "",
        email: "",
        note: ledgerCell(reason),
        status: "revoked",
        revokedAt: ledgerNow(now()),
        replaces: "",
      };
      ledger.push(row);
    }
    await saveLedger(files.ledger, ledger, fsIo);
    return row;
  }

  /** Отзыв по серийнику из формы журнала. */
  async function revoke(rawSerial) {
    const serial = String(rawSerial ?? "").replace(/[^0-9a-fA-F]/g, "").toLowerCase();
    if (serial.length !== core.SERIAL_BYTES * 2) {
      return reject("Серийник — 16 hex-символов (виден в журнале и у покупателя)");
    }
    const row = await revokeInternal(serial, "отозван владельцем");
    return { ok: true, row };
  }

  /* ── Выдача ───────────────────────────────────────────────────────────── */

  /**
   * Выписывает код активации.
   *
   * @param {object} raw данные формы
   * @param {string} raw.machineCode код компьютера (короткий или полный id)
   * @param {string} raw.name имя покупателя (обязательно: это журнал выдачи)
   * @param {string} [raw.phone] телефон покупателя
   * @param {string} [raw.email] почта покупателя
   * @param {string} [raw.note] пометка
   * @param {boolean} [raw.universal] универсальный код — только с подтверждением
   * @param {boolean} [raw.confirmUniversal] подтверждение универсального кода
   * @param {boolean} [raw.force] перевыпуск: отозвать прежний код этого компьютера
   */
  async function issue(raw = {}) {
    const name = ledgerCell(raw.name, 80);
    if (!name) return reject("Укажите имя покупателя — по нему находится запись в журнале", { field: "name" });
    const phone = ledgerCell(raw.phone, 40);
    const email = ledgerCell(raw.email, 120);
    const note = ledgerCell(raw.note, 200);
    const universal = raw.universal === true;

    const found = await secret();
    const keyId = Number(raw.keyId ?? found.keys[found.keys.length - 1].keyId);
    const key = found.keys.find((entry) => entry.keyId === keyId);
    if (!key) return reject(`Нет закрытого ключа с key-id=${keyId}`, { field: "keyId" });

    const keysModule = published();
    if (!keysModule.keys.some((entry) => entry.keyId === keyId)) {
      return reject(`Открытый ключ key-id=${keyId} не добавлен в electron/license/keys.cjs — приложение такой код не примет`);
    }

    let shortId = "";
    if (universal) {
      if (String(raw.machineCode ?? "").trim()) {
        return reject("Универсальный код не привязывается к компьютеру — очистите поле «Код компьютера»", { field: "machineCode" });
      }
      if (raw.confirmUniversal !== true) {
        return reject(
          "Универсальный код работает на ЛЮБОМ компьютере: его можно передать дальше, и отозвать можно будет только новой сборкой. Если покупатель прислал код своего компьютера — выписывайте персональный код. Подтвердите, что универсальный код нужен именно вам.",
          { needConfirmUniversal: true },
        );
      }
    } else {
      const resolved = normalizeMachineCode(raw.machineCode);
      if (!resolved.ok) return reject(resolved.message, { field: "machineCode" });
      shortId = resolved.shortId;
    }

    // Повторная выдача на тот же компьютер: видно, если покупатель просит
    // второй ключ (или переустановил Windows и нужен перевыпуск).
    const ledger = await loadLedger();
    const conflicts = shortId
      ? ledger.filter((row) => row.kind === "personal" && row.shortId === shortId && row.status === "active")
      : [];
    if (conflicts.length && raw.force !== true) {
      return reject(
        `Для компьютера ${core.prettyShortId(shortId)} уже есть действующий код (${conflicts
          .map((row) => `${row.name || "без имени"}, серийник ${core.prettySerial(row.serial)}`)
          .join("; ")}). Перевыпустить? Прежний код будет отозван автоматически и попадёт в следующую сборку.`,
        { needForce: true, conflict: conflicts },
      );
    }

    // Перевыпуск (переустановка Windows, смена компьютера): старый серийник
    // отзывается сразу, новый код получает пометку, кого он заменяет.
    const replaced = [];
    for (const conflict of conflicts) {
      await revokeInternal(conflict.serial, `перевыпуск для ${core.prettyShortId(shortId)}`);
      replaced.push(conflict.serial);
    }

    const signer = privateKeyObject(key.privateKey);
    const issued = buildLicenseCode({ privateKey: signer, keyId, bound: !universal, shortId });

    // Самопроверка: код обязан проходить проверку приложения на этой машине.
    const check = core.verifyCode({
      code: issued.code,
      keys: keysModule.keys,
      machineShortId: shortId,
      revokedSerials: keysModule.revokedSerials,
    });
    if (!check.ok) {
      return reject(`Самопроверка кода не прошла (${check.reason}) — код не выдан`);
    }

    const row = {
      issuedAt: ledgerNow(now()),
      serial: issued.serialHex,
      keyId,
      kind: universal ? "universal" : "personal",
      shortId,
      code: issued.code,
      name,
      phone,
      email,
      note: ledgerCell(replaced.length ? `${note} ${note ? "· " : ""}перевыпуск ${core.prettySerial(replaced[0])}` : note, 200),
      status: "active",
      revokedAt: "",
      replaces: replaced.join(","),
    };
    await appendLedgerRows(files.ledger, [row], fsIo);

    return {
      ok: true,
      permanent: true,
      universal,
      code: issued.code,
      serialHex: issued.serialHex,
      serial: core.prettySerial(issued.serialHex),
      shortId,
      shortIdPretty: universal ? "—" : core.prettyShortId(shortId),
      messageText: buildBuyerMessage({ name, code: issued.code, shortId, serialHex: issued.serialHex, universal }),
      smsText: buildBuyerSms({ code: issued.code, shortId, universal }),
      agrolic: {
        fileName: agrolicFileName(issued.serialHex),
        content: buildAgrolicContent({ name, shortId, serialHex: issued.serialHex, code: issued.code, universal }),
      },
      replaced: replaced.map((serial) => core.prettySerial(serial)),
      row,
    };
  }

  /* ── Доставка кода покупателю (необязательный модуль) ─────────────────── */

  /**
   * Отправка готового сообщения покупателю — только из студии, на машине
   * владельца. Каналы включаются переменными окружения; без ключей модуль
   * просто сообщает, что не настроен.
   *
   * @param {{channel:"sms"|"telegram"|"email", to:string, text:string}} input
   */
  async function send({ channel, to, text } = {}) {
    const capabilities = deliveryCapabilities(env);
    const transports = options.delivery ?? {};
    if (channel === "sms") {
      return sendSms({ env, capabilities, to, text, fetchImpl: transports.fetch });
    }
    if (channel === "telegram") {
      if (!capabilities.telegram) return { ok: false, message: "Telegram-бот не настроен: задайте AGRO_TG_BOT_TOKEN" };
      return sendTelegram({ token: env.AGRO_TG_BOT_TOKEN, chatId: to, text, fetchImpl: transports.fetch });
    }
    if (channel === "email") {
      if (!capabilities.smtp) {
        return { ok: false, message: "Почта не настроена: задайте AGRO_SMTP_HOST, AGRO_SMTP_USER, AGRO_SMTP_PASS" };
      }
      return sendEmail({
        host: env.AGRO_SMTP_HOST,
        port: Number(env.AGRO_SMTP_PORT ?? 587),
        user: env.AGRO_SMTP_USER,
        password: env.AGRO_SMTP_PASS,
        from: env.AGRO_SMTP_FROM,
        to,
        subject: "Код активации — АгроПрогноз — Кукуруза",
        text,
        netImpl: transports.net,
        tlsImpl: transports.tls,
      });
    }
    return { ok: false, message: "Неизвестный канал доставки" };
  }

  return { files, state, issue, revoke, send };
}
