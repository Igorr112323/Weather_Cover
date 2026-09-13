/**
 * Хранилище активированной лицензии (main process).
 *
 * Файл `agroprognoz.license` в каталоге профиля приложения. Внутри — не код
 * активации текстом, а зашифрованный конверт:
 *
 *   • шифрование — safeStorage (на Windows это DPAPI: расшифровать файл может
 *     только этот пользователь в этой системе), а если он недоступен —
 *     AES-256-GCM с ключом, выведенным из идентификатора компьютера;
 *   • поверх — HMAC-SHA256 от всего конверта, чтобы подмену полей было видно
 *     даже без расшифровки;
 *   • идентификатор компьютера дублируется в открытой части: файл лицензии,
 *     просто скопированный на другую машину, не читается и не принимается.
 *
 * Даты в записи нет: лицензия бессрочная, хранить «когда активировано» незачем,
 * а значит и подделывать/откатывать нечего.
 *
 * Запись атомарная (временный файл → fsync → rename), как у слоя базы данных.
 */

"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");

const MAGIC = "AGROLIC1";
const ENVELOPE_VERSION = 1;
/** Домены вывода ключей: разные роли — разные ключи, даже если материал один. */
const HKDF_INFO_CIPHER = "agro:license:cipher:v1";
const HKDF_INFO_MAC = "agro:license:mac:v1";
/** Константа приложения: делает запасной ключ разным у разных сборок. */
const APP_PEPPER = "agroprognoz-corn::license::pepper::v1";
const SALT_BYTES = 16;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const MAC_BYTES = 32;

const CIPHER = Object.freeze({ SAFE_STORAGE: "os", FALLBACK: "aes-gcm" });

const STATUS = Object.freeze({
  /** Файла нет — приложение ещё не активировали. */
  NONE: "none",
  /** Запись есть и читается; содержимое проверяет guard. */
  ACTIVE: "active",
  /** Файл есть, но читается как чужой/испорченный: нужна повторная активация. */
  INVALID: "invalid",
});

function toBase64(bytes) {
  return Buffer.from(bytes).toString("base64");
}

function fromBase64(text) {
  const buffer = Buffer.from(String(text ?? ""), "base64");
  return Uint8Array.from(buffer);
}

function deriveKey(machineId, salt, info) {
  return Buffer.from(
    crypto.hkdfSync("sha256", Buffer.from(`${APP_PEPPER}:${machineId}`, "utf8"), Buffer.from(salt), Buffer.from(info, "utf8"), 32),
  );
}

/**
 * Запасной шифр на случай, если safeStorage недоступен (Linux без keyring,
 * сбой системного хранилища). Ключ выводится из идентификатора компьютера,
 * поэтому перенос файла на другую машину его не открывает.
 */
function createFallbackCipher(machineId) {
  return {
    kind: CIPHER.FALLBACK,
    isAvailable: () => Boolean(machineId),
    encrypt(salt, plaintext) {
      const key = deriveKey(machineId, salt, HKDF_INFO_CIPHER);
      const iv = crypto.randomBytes(IV_BYTES);
      const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
      const data = Buffer.concat([cipher.update(Buffer.from(plaintext)), cipher.final()]);
      return { iv, data, tag: cipher.getAuthTag() };
    },
    decrypt(salt, iv, data, tag) {
      const key = deriveKey(machineId, salt, HKDF_INFO_CIPHER);
      const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(iv));
      decipher.setAuthTag(Buffer.from(tag));
      return Buffer.concat([decipher.update(Buffer.from(data)), decipher.final()]);
    },
  };
}

/** Обёртка над safeStorage Electron: тот же интерфейс, что у запасного шифра. */
function createSafeStorageCipher(safeStorage) {
  return {
    kind: CIPHER.SAFE_STORAGE,
    isAvailable: () => {
      try {
        return Boolean(safeStorage?.isEncryptionAvailable?.());
      } catch {
        return false;
      }
    },
    encrypt(salt, plaintext) {
      const data = safeStorage.encryptString(Buffer.from(plaintext).toString("base64"));
      return { iv: Buffer.alloc(0), data: Buffer.from(data), tag: Buffer.alloc(0) };
    },
    decrypt(_salt, _iv, data) {
      const decoded = safeStorage.decryptString(Buffer.from(data));
      return Buffer.from(decoded, "base64");
    },
  };
}

/**
 * @param {object} options
 * @param {string} options.dir каталог профиля приложения
 * @param {string} [options.fileName] имя файла лицензии
 * @param {() => string} options.machineId идентификатор компьютера
 * @param {{isEncryptionAvailable?:Function, encryptString?:Function, decryptString?:Function}} [options.safeStorage]
 * @param {(message:string)=>void} [options.log]
 */
function createLicenseStore({ dir, fileName = "agroprognoz.license", machineId, safeStorage, log = () => {} }) {
  const filePath = path.join(dir, fileName);
  const osCipher = createSafeStorageCipher(safeStorage);
  const fallback = createFallbackCipher(typeof machineId === "function" ? "" : String(machineId ?? ""));

  function machine() {
    return typeof machineId === "function" ? String(machineId() ?? "") : String(machineId ?? "");
  }

  function pickCipher() {
    if (osCipher.isAvailable()) return osCipher;
    const local = createFallbackCipher(machine());
    return local.isAvailable() ? local : null;
  }

  function macKey(salt) {
    return deriveKey(machine(), salt, HKDF_INFO_MAC);
  }

  function envelopeMac(envelope) {
    const canonical = [
      envelope.v,
      envelope.cipher,
      envelope.salt,
      envelope.iv,
      envelope.tag,
      envelope.data,
      envelope.machine,
    ].join("|");
    return crypto.createHmac("sha256", macKey(fromBase64(envelope.salt))).update(canonical, "utf8").digest();
  }

  /**
   * @param {object} record содержимое лицензии (без дат)
   * @returns {Promise<{ok:true}|{ok:false, message:string}>}
   */
  async function write(record) {
    const cipher = pickCipher();
    if (!cipher) return { ok: false, message: "Системное хранилище ключей недоступно" };
    try {
      const salt = crypto.randomBytes(SALT_BYTES);
      const plaintext = Buffer.from(JSON.stringify(record), "utf8");
      const encrypted = cipher.encrypt(salt, plaintext);
      const envelope = {
        v: ENVELOPE_VERSION,
        magic: MAGIC,
        cipher: cipher.kind,
        salt: toBase64(salt),
        iv: toBase64(encrypted.iv),
        tag: toBase64(encrypted.tag),
        data: toBase64(encrypted.data),
        machine: toBase64(crypto.createHash("sha256").update(machine(), "utf8").digest()),
      };
      envelope.mac = toBase64(envelopeMac(envelope));

      await fsp.mkdir(dir, { recursive: true });
      const tempPath = path.join(dir, `${fileName}.${crypto.randomBytes(4).toString("hex")}.tmp`);
      let handle;
      try {
        handle = await fsp.open(tempPath, "w", 0o600);
        await handle.writeFile(`${MAGIC}\n${JSON.stringify(envelope, null, 2)}\n`, "utf8");
        try {
          await handle.sync();
        } catch (error) {
          log(`license: fsync не выполнен (${error?.code ?? error?.message})`);
        }
        await handle.close();
        handle = null;
        await fsp.rename(tempPath, filePath);
        return { ok: true };
      } finally {
        if (handle) await handle.close().catch(() => {});
        await fsp.rm(tempPath, { force: true }).catch(() => {});
      }
    } catch (error) {
      log(`license: запись не удалась (${error?.code ?? error?.message})`);
      return { ok: false, message: "Не удалось сохранить лицензию" };
    }
  }

  /** @returns {Promise<{status:string, record?:object, reason?:string}>} */
  async function read() {
    let raw;
    try {
      raw = await fsp.readFile(filePath, "utf8");
    } catch (error) {
      if (error?.code === "ENOENT") return { status: STATUS.NONE };
      log(`license: файл не читается (${error?.code ?? error?.message})`);
      return { status: STATUS.INVALID, reason: "READ_FAILED" };
    }

    const body = raw.replace(new RegExp(`^${MAGIC}\\s*`), "").trim();
    let envelope;
    try {
      envelope = JSON.parse(body);
    } catch {
      return { status: STATUS.INVALID, reason: "PARSE_FAILED" };
    }
    if (!envelope || envelope.magic !== MAGIC || envelope.v !== ENVELOPE_VERSION) {
      return { status: STATUS.INVALID, reason: "FORMAT" };
    }

    // Файл с чужой машины не принимаем, даже если смогли бы расшифровать.
    const currentMachine = toBase64(crypto.createHash("sha256").update(machine(), "utf8").digest());
    if (String(envelope.machine ?? "") !== currentMachine) {
      return { status: STATUS.INVALID, reason: "MACHINE" };
    }

    const expectedMac = toBase64(envelopeMac(envelope));
    const actualMac = String(envelope.mac ?? "");
    if (
      expectedMac.length !== actualMac.length ||
      !crypto.timingSafeEqual(Buffer.from(expectedMac, "base64"), Buffer.from(actualMac, "base64"))
    ) {
      return { status: STATUS.INVALID, reason: "MAC" };
    }

    try {
      const cipher = envelope.cipher === CIPHER.SAFE_STORAGE ? osCipher : createFallbackCipher(machine());
      if (!cipher.isAvailable()) return { status: STATUS.INVALID, reason: "CIPHER_UNAVAILABLE" };
      const plaintext = cipher.decrypt(
        fromBase64(envelope.salt),
        fromBase64(envelope.iv),
        fromBase64(envelope.data),
        fromBase64(envelope.tag),
      );
      const record = JSON.parse(Buffer.from(plaintext).toString("utf8"));
      if (!record || typeof record !== "object") return { status: STATUS.INVALID, reason: "EMPTY" };
      return { status: STATUS.ACTIVE, record };
    } catch (error) {
      log(`license: расшифровать не удалось (${error?.message ?? error})`);
      return { status: STATUS.INVALID, reason: "DECRYPT_FAILED" };
    }
  }

  /**
   * Нечитаемый файл не удаляем, а переименовываем: так остаётся материал для
   * разбора, и приложение не «съедает» следы сбоя.
   */
  async function quarantine(reason) {
    try {
      const target = `${filePath}.${String(reason || "invalid").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 24)}.bad`;
      await fsp.rename(filePath, target);
      return path.basename(target);
    } catch {
      return null;
    }
  }

  return { filePath, fileName, dir, read, write, quarantine, STATUS };
}

module.exports = { APP_PEPPER, CIPHER, MAGIC, STATUS, createFallbackCipher, createLicenseStore, deriveKey };
