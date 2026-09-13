/**
 * Ядро лицензирования. Только node:crypto — ни Electron, ни файловой системы,
 * ни часов: модуль проверяется unit-тестами в обычном Node.
 *
 * ЛИЦЕНЗИЯ БЕССРОЧНАЯ. Это не «срок по умолчанию большой», а отсутствие срока
 * как понятия: в коде активации нет поля даты, проверка не читает системное
 * время, а решение «активировано / нет» зависит только от подписи и (если код
 * персональный) от отпечатка компьютера. Перевод часов, подмена даты, «откат»
 * времени — на лицензию не влияет, влиять просто не на что.
 *
 * Криптосхема: Ed25519 (RFC 8032). Код активации = полезная нагрузка (16 байт)
 * + подпись (64 байта), вместе 80 байт; в тексте — 128 символов Crockford
 * base32 (алфавит без I, L, O, U; регистр не важен, опечатки I/L/O исправляются).
 * Закрытый ключ живёт только у владельца приложения (scripts/license-tool.mjs),
 * в сборку попадает исключительно открытый ключ (electron/license/keys.cjs):
 * выписать себе новый код из установленного приложения нельзя.
 *
 * Раскладка нагрузки (16 байт):
 *   [0]      версия формата
 *   [1]      идентификатор продукта
 *   [2]      идентификатор ключа (ротация ключей без перевыпуска приложения)
 *   [3]      флаги (бит 0 — код привязан к компьютеру)
 *   [4..11]  серийный номер лицензии (8 байт, у каждой копии свой)
 *   [12..15] отпечаток компьютера (4 байта; нули у непривязанных кодов)
 */

"use strict";

const crypto = require("node:crypto");

/** Версия формата кода. Меняется только вместе с раскладкой нагрузки. */
const FORMAT_VERSION = 0x01;
/** Продукт «АгроПрогноз — Кукуруза»: код другого продукта не подойдёт. */
const PRODUCT_ID = 0x01;
const PRODUCT_NAME = "АгроПрогноз — Кукуруза";

const PAYLOAD_LENGTH = 16;
const SIGNATURE_LENGTH = 64;
/** 16 байт нагрузки + 64 байта подписи Ed25519. */
const LICENSE_LENGTH = PAYLOAD_LENGTH + SIGNATURE_LENGTH;
/** 80 байт = 640 бит = ровно 128 символов base32. */
const CODE_BODY_LENGTH = (LICENSE_LENGTH * 8) / 5;

const CODE_PREFIX = "AGRO";
/** Текст кода разбивается на группы по 8 символов — так его легче сверять. */
const GROUP_SIZE = 8;
const SERIAL_BYTES = 8;
const FINGERPRINT_BYTES = 4;
/** Байтов хэша уходит в короткий идентификатор компьютера (5 байт = 8 символов). */
const SHORT_ID_BYTES = 5;
/** Домен отделения отпечатка: меняет его при смене формата, не трогая хэш machineId. */
const FINGERPRINT_DOMAIN = "agro:fp:1:";
/** Длина полного идентификатора компьютера в hex (SHA-256). */
const MACHINE_ID_HEX_LENGTH = 64;

const FLAG_MACHINE_BOUND = 0x01;

/** Crockford base32: нет O/0, I/1/L, U — опечатки не превращаются в другой код. */
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const ALPHABET_LOOKUP = new Map();
for (let index = 0; index < ALPHABET.length; index += 1) ALPHABET_LOOKUP.set(ALPHABET[index], index);
/** Однозначные замены при вводе: I и L читаются как 1, O — как 0. */
const INPUT_ALIASES = { I: "1", L: "1", O: "0" };

/** Условия лицензии: единственное возможное значение — бессрочная. */
const LICENSE_TERMS = Object.freeze({ permanent: true, expiration: null });

/** Причины отказа (сообщения для человека — в guard.cjs и на экране активации). */
const REJECT = Object.freeze({
  EMPTY: "EMPTY",
  MALFORMED: "MALFORMED",
  LENGTH: "LENGTH",
  VERSION: "VERSION",
  PRODUCT: "PRODUCT",
  UNKNOWN_KEY: "UNKNOWN_KEY",
  SIGNATURE: "SIGNATURE",
  REVOKED: "REVOKED",
  MACHINE_MISMATCH: "MACHINE_MISMATCH",
  MACHINE_UNKNOWN: "MACHINE_UNKNOWN",
});

/**
 * Насколько «осмысленной» была лучшая попытка: чем дальше код прошёл по
 * проверкам, тем конкретнее сообщение человеку («неверный код» вместо
 * «какая-то каша на вводе»).
 */
const REJECT_PRIORITY = [
  REJECT.MACHINE_MISMATCH,
  REJECT.MACHINE_UNKNOWN,
  REJECT.REVOKED,
  REJECT.SIGNATURE,
  REJECT.UNKNOWN_KEY,
  REJECT.PRODUCT,
  REJECT.VERSION,
  REJECT.LENGTH,
  REJECT.MALFORMED,
  REJECT.EMPTY,
];

class CodeFormatError extends Error {
  constructor(message, reason) {
    super(message);
    this.name = "CodeFormatError";
    this.reason = reason;
  }
}

/* ── base32 ──────────────────────────────────────────────────────────────── */

/** Байты → строка Crockford base32 без выравнивания. */
function base32Encode(bytes) {
  let output = "";
  let buffer = 0;
  let bits = 0;
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      output += ALPHABET[(buffer >>> bits) & 0x1f];
    }
  }
  if (bits > 0) output += ALPHABET[(buffer << (5 - bits)) & 0x1f];
  return output;
}

/**
 * Приведение введённого текста: регистр не важен, разделители (пробелы, тире,
 * точки, подчёркивания, вертикальные палочки) выбрасываются, I/L → 1, O → 0.
 */
function normalizeCodeText(text) {
  return String(text ?? "")
    .toUpperCase()
    // Пробелы и любые разделители, включая обычный дефис и неразрывный пробел
    .replace(/[\s\u00a0\u1680\u2000-\u200f\u2028\u2029\u202f\u205f\u3000\u2010-\u2015\u2212\-_.:,;/\\|()[\]{}<>'"`=+*#@!?~^%$&]/g, "")
    .replace(/[ILO]/g, (char) => INPUT_ALIASES[char] ?? char);
}

/** Префикс после нормализации («AGRO» → «AGR0»): нужен, чтобы его отбросить. */
const NORMALIZED_PREFIX = normalizeCodeText(CODE_PREFIX);

/** Строка → байты. Бросает CodeFormatError с причиной, пригодной для показа. */
function base32Decode(text) {
  const clean = normalizeCodeText(text);
  if (clean.length === 0) throw new CodeFormatError("Пустой код", REJECT.EMPTY);
  const bytes = [];
  let buffer = 0;
  let bits = 0;
  for (const char of clean) {
    const value = ALPHABET_LOOKUP.get(char);
    if (value === undefined) throw new CodeFormatError(`Недопустимый символ «${char}»`, REJECT.MALFORMED);
    buffer = (buffer << 5) | value;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((buffer >>> bits) & 0xff);
    }
  }
  // Хвостовые биты обязаны быть нулевыми: иначе один и тот же код получал бы
  // несколько разных написаний, а это ломало бы отзыв лицензий по серийнику.
  if (bits > 0 && (buffer & ((1 << bits) - 1)) !== 0) {
    throw new CodeFormatError("Лишние биты в конце кода", REJECT.MALFORMED);
  }
  return Uint8Array.from(bytes);
}

/** 80 байт лицензии → текст «AGRO-XXXXXXXX-XXXXXXXX-…». */
function formatCode(licenseBytes) {
  const body = base32Encode(licenseBytes);
  const groups = [];
  for (let index = 0; index < body.length; index += GROUP_SIZE) groups.push(body.slice(index, index + GROUP_SIZE));
  return `${CODE_PREFIX}-${groups.join("-")}`;
}

/** Текст → 80 байт. Префикс необязателен: принимается и «AGRO-…», и тело кода. */
function parseCode(text) {
  let clean = normalizeCodeText(text);
  if (clean.startsWith(NORMALIZED_PREFIX)) clean = clean.slice(NORMALIZED_PREFIX.length);
  const bytes = base32Decode(clean);
  if (bytes.byteLength !== LICENSE_LENGTH) {
    throw new CodeFormatError(`Ожидалось ${LICENSE_LENGTH} байт, получено ${bytes.byteLength}`, REJECT.LENGTH);
  }
  return bytes;
}

/**
 * Кандидаты на код внутри произвольного текста: письмо, readme, файл .agrolic.
 * Возвращаем несколько вариантов, а не один — пусть подпись сама выберет верный.
 */
function codeCandidates(text) {
  const source = String(text ?? "");
  if (source.trim().length === 0) return [];
  const candidates = new Set();

  // Текст целиком — самый частый случай (поле ввода, содержимое файла).
  const whole = normalizeCodeText(source);
  if (whole) candidates.add(whole);

  // Код с разделителями внутри окружающего текста.
  const grouped = source.match(/[A-Za-z0-9]{4}(?:[\s\u00a0-]+[0-9A-Za-z]{8}){16}/);
  if (grouped) candidates.add(normalizeCodeText(grouped[0]));

  // Непрерывные «слова» из символов алфавита: тело кода, тело с префиксом,
  // а также хвост длинного слова (префикс мог приклеиться к посторонним символам).
  let normalized = whole;
  if (normalized.startsWith(NORMALIZED_PREFIX)) normalized = normalized.slice(NORMALIZED_PREFIX.length);
  for (const run of normalized.match(/[0-9A-Z]{32,}/g) ?? []) {
    if (run.length === CODE_BODY_LENGTH) candidates.add(run);
    if (run.length > CODE_BODY_LENGTH) candidates.add(run.slice(run.length - CODE_BODY_LENGTH));
  }

  return [...candidates].slice(0, 8);
}

/* ── Нагрузка ────────────────────────────────────────────────────────────── */

/**
 * Идентификатор компьютера, который видит человек: 8 символов base32
 * («XXXX-XXXX» на экране активации). Получается из полного идентификатора,
 * поэтому владелец приложения может выписать персональный код, зная только
 * эти 8 символов, — полный 64-символьный hex диктовать не нужно.
 */
function machineShortId_(machineId) {
  const digest = crypto.createHash("sha256").update(String(machineId ?? ""), "utf8").digest();
  return base32Encode(Uint8Array.from(digest.subarray(0, SHORT_ID_BYTES)));
}

/** Короткий идентификатор компьютера (8 символов base32). */
const machineShortId = machineShortId_;

/** Короткий идентификатор из того, что дали: либо он сам, либо полный machineId. */
function resolveShortId({ machineId = "", machineShortId = "" }) {
  const short = normalizeCodeText(machineShortId);
  if (short.length === SHORT_ID_BYTES * 2 - 2 && /^[0-9A-Z]+$/.test(short)) return short;
  const full = String(machineId ?? "").trim();
  return full ? machineShortId_(full) : "";
}

/** Короткий идентификатор в читаемом виде: «XXXX-XXXX». */
function prettyShortId(shortId) {
  const clean = normalizeCodeText(shortId);
  return clean.match(/.{1,4}/g)?.join("-") ?? clean;
}

/**
 * 4 байта отпечатка компьютера. Считаются от КОРОТКОГО идентификатора: тогда
 * один и тот же отпечаток получается и в приложении (оно знает полный
 * machineId), и в генераторе кодов (ему достаточно того, что продиктовал
 * пользователь).
 */
function fingerprintFromShortId(shortId) {
  const digest = crypto
    .createHash("sha256")
    .update(`${FINGERPRINT_DOMAIN}${normalizeCodeText(shortId)}`, "utf8")
    .digest();
  return Uint8Array.from(digest.subarray(0, FINGERPRINT_BYTES));
}

/** Отпечаток по полному идентификатору компьютера — так считает приложение. */
function machineFingerprint(machineId) {
  return fingerprintFromShortId(machineShortId_(machineId));
}

/**
 * Разбор того, что прислал пользователь для персонального кода:
 * 64 hex-символа — полный идентификатор, 8 символов — короткий.
 * @returns {{ok:true, shortId:string}|{ok:false, message:string}}
 */
function resolveBindTarget(input) {
  const raw = String(input ?? "").trim();
  if (!raw) return { ok: false, message: "Пустой идентификатор компьютера" };
  const hex = raw.replace(/[^0-9a-fA-F]/g, "");
  if (hex.length === MACHINE_ID_HEX_LENGTH && /^[0-9a-fA-F\s-]+$/.test(raw)) {
    return { ok: true, shortId: machineShortId_(hex.toLowerCase()) };
  }
  const short = normalizeCodeText(raw);
  if (short.length === SHORT_ID_BYTES * 2 - 2 && /^[0-9A-Z]+$/.test(short)) {
    return { ok: true, shortId: short };
  }
  return {
    ok: false,
    message: `Ожидался короткий идентификатор из ${SHORT_ID_BYTES * 2 - 2} символов или полный идентификатор из ${MACHINE_ID_HEX_LENGTH} hex-символов`,
  };
}

/**
 * Собирает 16 байт нагрузки. Используется генератором кодов; приложение
 * нагрузку только разбирает. Поля даты в раскладке нет.
 * @param {{keyId:number, serial?:Uint8Array, bound?:boolean, machineId?:string}} options
 */
function buildPayload({ keyId, serial, bound = false, machineId = "" }) {
  const payload = new Uint8Array(PAYLOAD_LENGTH);
  payload[0] = FORMAT_VERSION;
  payload[1] = PRODUCT_ID;
  payload[2] = keyId & 0xff;
  payload[3] = bound ? FLAG_MACHINE_BOUND : 0;

  const serialBytes =
    serial instanceof Uint8Array && serial.byteLength === SERIAL_BYTES ? serial : crypto.randomBytes(SERIAL_BYTES);
  payload.set(serialBytes.subarray(0, SERIAL_BYTES), 4);

  if (bound) payload.set(machineFingerprint(machineId), 12);
  return Uint8Array.from(payload);
}

/** 16 байт → объект. Расхождение с раскладкой — отказ, «починить на месте» не пытаемся. */
function parsePayload(payload) {
  if (!(payload instanceof Uint8Array) || payload.byteLength !== PAYLOAD_LENGTH) {
    throw new CodeFormatError("Неверный размер нагрузки", REJECT.LENGTH);
  }
  const fingerprint = payload.subarray(12, 12 + FINGERPRINT_BYTES);
  const bound = (payload[3] & FLAG_MACHINE_BOUND) === FLAG_MACHINE_BOUND;
  const serial = payload.subarray(4, 4 + SERIAL_BYTES);
  const hasFingerprint = !fingerprint.every((byte) => byte === 0);
  return {
    version: payload[0],
    productId: payload[1],
    keyId: payload[2],
    flags: payload[3],
    bound,
    serial,
    serialHex: Buffer.from(serial).toString("hex"),
    fingerprint,
    fingerprintHex: Buffer.from(fingerprint).toString("hex"),
    /** У привязанного кода отпечаток есть, у общего — нули. Иначе код подделан «наполовину». */
    consistent: bound ? hasFingerprint : !hasFingerprint,
  };
}

/** Серийный номер в читаемом виде: четыре группы по 4 hex-символа. */
function prettySerial(serialHex) {
  const upper = String(serialHex ?? "").toUpperCase();
  return upper.match(/.{1,4}/g)?.join("-") ?? upper;
}

/* ── Проверка ────────────────────────────────────────────────────────────── */

function publicKeyFromEntry(entry) {
  try {
    return crypto.createPublicKey({
      key: Buffer.from(String(entry.publicKey), "base64"),
      format: "der",
      type: "spki",
    });
  } catch {
    return null;
  }
}

/** Сравнение байтов в постоянное время. */
function sameBytes(a, b) {
  if (!(a instanceof Uint8Array) || !(b instanceof Uint8Array)) return false;
  if (a.byteLength !== b.byteLength) return false;
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

function pickReason(reasons) {
  for (const reason of REJECT_PRIORITY) if (reasons.has(reason)) return reason;
  return REJECT.MALFORMED;
}

/**
 * Полная проверка кода активации. Дат не читает, времени не знает.
 *
 * @param {object} params
 * @param {string} params.code текст кода или содержимое файла лицензии
 * @param {Array<{keyId:number, publicKey:string}>} params.keys открытые ключи из сборки
 * @param {string} [params.machineId] полный идентификатор этого компьютера
 * @param {string} [params.machineShortId] короткий идентификатор (если полного нет)
 * @param {string[]} [params.revokedSerials] отозванные серийные номера (hex)
 * @returns {{ok:true, license:object}|{ok:false, reason:string}}
 */
function verifyCode({ code, keys, machineId = "", machineShortId = "", revokedSerials = [] }) {
  const candidates = codeCandidates(code);
  if (candidates.length === 0) return { ok: false, reason: REJECT.EMPTY };

  const entries = (Array.isArray(keys) ? keys : []).filter((entry) => entry && typeof entry.publicKey === "string");
  if (entries.length === 0) return { ok: false, reason: REJECT.UNKNOWN_KEY };
  const publicKeys = entries.map((entry) => ({ entry, key: publicKeyFromEntry(entry) })).filter((item) => item.key);
  if (publicKeys.length === 0) return { ok: false, reason: REJECT.UNKNOWN_KEY };

  const revoked = new Set([...revokedSerials].map((value) => String(value).toLowerCase()));
  const reasons = new Set();

  for (const candidate of candidates) {
    let bytes;
    try {
      bytes = parseCode(candidate);
    } catch (error) {
      reasons.add(error instanceof CodeFormatError ? error.reason : REJECT.MALFORMED);
      continue;
    }

    const payload = bytes.subarray(0, PAYLOAD_LENGTH);
    const signature = bytes.subarray(PAYLOAD_LENGTH);

    let license;
    try {
      license = parsePayload(payload);
    } catch {
      reasons.add(REJECT.LENGTH);
      continue;
    }
    if (license.version !== FORMAT_VERSION) {
      reasons.add(REJECT.VERSION);
      continue;
    }
    if (license.productId !== PRODUCT_ID) {
      reasons.add(REJECT.PRODUCT);
      continue;
    }
    if (!license.consistent) {
      reasons.add(REJECT.MALFORMED);
      continue;
    }
    if (revoked.has(license.serialHex.toLowerCase())) {
      reasons.add(REJECT.REVOKED);
      continue;
    }

    // Ключ ищем сначала по keyId из нагрузки, потом по остальным: ротация
    // ключей не должна ломать уже выданные коды.
    const ordered = [
      ...publicKeys.filter((item) => (item.entry.keyId & 0xff) === license.keyId),
      ...publicKeys.filter((item) => (item.entry.keyId & 0xff) !== license.keyId),
    ];

    let signed = false;
    let matchedKeyId = license.keyId;
    for (const { entry, key } of ordered) {
      try {
        signed = crypto.verify(null, Buffer.from(payload), key, Buffer.from(signature)) === true;
      } catch {
        signed = false;
      }
      if (signed) {
        matchedKeyId = entry.keyId & 0xff;
        break;
      }
    }
    if (!signed) {
      reasons.add(REJECT.SIGNATURE);
      continue;
    }

    if (license.bound) {
      // Отпечаток считается от короткого идентификатора, поэтому подходит и
      // полный machineId этого компьютера, и уже укороченный идентификатор.
      const shortId = resolveShortId({ machineId, machineShortId });
      if (!shortId) {
        reasons.add(REJECT.MACHINE_UNKNOWN);
        continue;
      }
      if (!sameBytes(license.fingerprint, fingerprintFromShortId(shortId))) {
        reasons.add(REJECT.MACHINE_MISMATCH);
        continue;
      }
    }

    return {
      ok: true,
      /** Канонический текст кода: из него guard.cjs берёт байты без повторного разбора ввода. */
      encoded: formatCode(bytes),
      license: {
        version: license.version,
        productId: license.productId,
        productName: PRODUCT_NAME,
        keyId: matchedKeyId,
        bound: license.bound,
        serialHex: license.serialHex,
        serial: prettySerial(license.serialHex),
        ...LICENSE_TERMS,
      },
    };
  }

  return { ok: false, reason: pickReason(reasons) };
}

module.exports = {
  ALPHABET,
  CODE_BODY_LENGTH,
  CODE_PREFIX,
  FLAG_MACHINE_BOUND,
  FORMAT_VERSION,
  GROUP_SIZE,
  LICENSE_LENGTH,
  LICENSE_TERMS,
  PAYLOAD_LENGTH,
  PRODUCT_ID,
  PRODUCT_NAME,
  REJECT,
  SERIAL_BYTES,
  SIGNATURE_LENGTH,
  MACHINE_ID_HEX_LENGTH,
  SHORT_ID_BYTES,
  CodeFormatError,
  base32Decode,
  base32Encode,
  buildPayload,
  codeCandidates,
  fingerprintFromShortId,
  formatCode,
  machineFingerprint,
  machineShortId,
  prettyShortId,
  normalizeCodeText,
  parseCode,
  parsePayload,
  prettySerial,
  resolveBindTarget,
  resolveShortId,
  sameBytes,
  verifyCode,
};
