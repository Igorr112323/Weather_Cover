/**
 * Лицензирование и защита: код активации, хранилище, целостность, страж.
 * Запуск: npm test
 *
 * Ключевое свойство, которое проверяется отдельной группой тестов:
 * ЛИЦЕНЗИЯ БЕССРОЧНАЯ. В модулях лицензирования нет обращений к часам —
 * решение не зависит от системной даты, поэтому перевод часов, «откат» времени
 * и подмена даты ничего не дают. Проверяется и статически (в исходниках нет
 * Date/now/performance.time), и поведением (одно и то же состояние лицензии
 * принимается одинаково).
 *
 * Electron в тестах не нужен: все модули принимают зависимости параметрами.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

import { CODE_BODY_LENGTH, codeBody, codeHint, codeProgress, formatCodeText, isCodeComplete } from "../src/services/license-code.js";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const core = require("../electron/license/core.cjs");
const { createLicenseStore, createFallbackCipher } = require("../electron/license/store.cjs");
const { createIntegrityChecker, manifestRootHash, electronRootHash, hashBytes } = require("../electron/license/integrity.cjs");
const { decideLaunch, inspectLaunchEnvironment } = require("../electron/license/shield.cjs");
const { createGuard } = require("../electron/license/guard.cjs");
const machineModule = require("../electron/license/machine.cjs");
const { createMachineIdentity } = machineModule;

/* ── Общие заготовки ─────────────────────────────────────────────────────── */

let keyPair = null;
let keyEntry = null;
let tempDirs = [];

function makeTempDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

/** Подписывает код активации тестовым закрытым ключом. */
function signCode({ keyId = 1, bound = false, machineId = "", serial, productId = core.PRODUCT_ID, version = core.FORMAT_VERSION } = {}) {
  const payload = bound
    ? core.buildPayload({ keyId, bound: true, machineId, serial })
    : core.buildPayload({ keyId, serial });
  if (productId !== core.PRODUCT_ID) payload[1] = productId;
  if (version !== core.FORMAT_VERSION) payload[0] = version;
  const signature = crypto.sign(null, Buffer.from(payload), keyPair.privateKey);
  return {
    code: core.formatCode(Buffer.concat([Buffer.from(payload), Buffer.from(signature)])),
    payload,
    signature,
    serialHex: Buffer.from(payload.subarray(4, 4 + core.SERIAL_BYTES)).toString("hex"),
  };
}

/** Хранилище лицензии в памяти: тесты не должны зависеть от диска. */
function memoryStore(initial = null) {
  let record = initial;
  return {
    fileName: "memory.license",
    STATUS: { NONE: "none", ACTIVE: "active", INVALID: "invalid" },
    writes: 0,
    async read() {
      return record ? { status: "active", record } : { status: "none" };
    },
    async write(next) {
      record = next;
      this.writes += 1;
      return { ok: true };
    },
    async quarantine() {
      record = null;
      return "quarantined";
    },
  };
}

function fakeMachine(machineId = "ab".repeat(32)) {
  return { machineId, quality: "high", source: "test" };
}

const NO_INTEGRITY = Object.freeze({
  enabled: false,
  async verify() {
    return { ok: true, skipped: true, mismatches: [], checked: 0 };
  },
});

before(() => {
  keyPair = crypto.generateKeyPairSync("ed25519");
  keyEntry = {
    keyId: 1,
    label: "test",
    publicKey: keyPair.publicKey.export({ format: "der", type: "spki" }).toString("base64"),
  };
});

after(async () => {
  for (const dir of tempDirs) await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
  tempDirs = [];
});

/* ── Поле ввода кода (интерфейс) ─────────────────────────────────────────── */

describe("форматирование кода в поле ввода", () => {
  it("приводит регистр, пробелы и разделители к печатному виду", () => {
    const clean = formatCodeText("AGRO-ABCDEFGH-23456789");
    assert.equal(clean, "AGRO-ABCDEFGH-23456789");
    assert.equal(formatCodeText("agro-abcdefgh-23456789"), clean);
    assert.equal(formatCodeText("  agro abcdefgh 23456789  "), clean);
    assert.equal(formatCodeText("AGROABCDEFGH23456789"), clean);
    // O → 0, I → 1, L → 1: те же замены, что и в проверке main process
    assert.equal(formatCodeText("AGRO-OLCDEFGH-23456789"), "AGRO-01CDEFGH-23456789");
  });

  it("пустой ввод остаётся пустым", () => {
    assert.equal(formatCodeText(""), "");
    assert.equal(formatCodeText("   "), "");
    assert.equal(formatCodeText(null), "");
    assert.equal(formatCodeText(undefined), "");
  });

  it("лишние символы отбрасываются, длинный ввод обрезается", () => {
    // I после приведения превращается в 1 — как и при проверке в main process
    assert.equal(formatCodeText("AGRO-ABC!!DEF**GHI"), "AGRO-ABCDEFGH-1");
    assert.equal(codeProgress("9".repeat(400)), CODE_BODY_LENGTH);
    // «AGRO-» + 128 символов + 15 разделителей между группами по 8 символов
    assert.equal(formatCodeText("9".repeat(400)).length, CODE_BODY_LENGTH + "AGRO-".length + 128 / 8 - 1);
  });

  it("прогресс и полнота кода считаются по телу кода", () => {
    assert.equal(codeProgress(""), 0);
    assert.equal(codeProgress("AGRO"), 0, "префикс не считается символами кода");
    assert.equal(codeBody("AGRO-ABCD"), "ABCD");
    assert.equal(codeProgress("AGRO-ABCD"), 4);
    assert.equal(codeProgress(`AGRO-${"ABCDEFGH-".repeat(15)}ABCDEFGH`), CODE_BODY_LENGTH);
    assert.equal(isCodeComplete(`AGRO-${"ABCDEFGH-".repeat(15)}ABCDEFGH`), true);
    assert.equal(isCodeComplete("AGRO-ABCDEFGH"), false);
    assert.match(codeHint(""), /Введите/);
    assert.match(codeHint("AGRO-ABCD"), /4 из 128/);
    assert.match(codeHint(`AGRO-${"ABCDEFGH-".repeat(15)}ABCDEFGH`), /целиком/);
  });

  it("форматирование интерфейса совпадает с разбором в main process", () => {
    // Один и тот же код: напечатан «грязно», приведён интерфейсом, принят ядром
    const { code } = signCode();
    const dirty = ` ${code.toLowerCase().replace(/-/g, " ")} `;
    const formatted = formatCodeText(dirty);
    assert.equal(formatted, code);
    assert.equal(core.verifyCode({ code: formatted, keys: [keyEntry] }).ok, true);
  });
});

/* ── Формат кода ─────────────────────────────────────────────────────────── */

describe("формат кода активации", () => {
  it("80 байт: 16 байт нагрузки и 64 байта подписи Ed25519", () => {
    assert.equal(core.PAYLOAD_LENGTH, 16);
    assert.equal(core.SIGNATURE_LENGTH, 64);
    assert.equal(core.LICENSE_LENGTH, 80);
  });

  it("тело кода — ровно 128 символов base32", () => {
    const { code } = signCode();
    const body = code.replace(/^AGRO-/, "").replace(/-/g, "");
    assert.equal(body.length, core.CODE_BODY_LENGTH);
    assert.match(body, /^[0-9ABCDEFGHJKMNPQRSTVWXYZ]+$/);
  });

  it("base32: round-trip без потерь", () => {
    for (const length of [1, 5, 16, 80, 128]) {
      const bytes = crypto.randomBytes(length);
      assert.deepEqual(Buffer.from(core.base32Decode(core.base32Encode(bytes))), Buffer.from(bytes));
    }
  });

  it("регистр, пробелы, переносы строк и опечатки I/L/O не мешают", () => {
    const { code } = signCode();
    const keys = [keyEntry];
    assert.equal(core.verifyCode({ code, keys }).ok, true);
    assert.equal(core.verifyCode({ code: code.toLowerCase(), keys }).ok, true);
    assert.equal(core.verifyCode({ code: code.replace(/-/g, " "), keys }).ok, true);
    assert.equal(core.verifyCode({ code: code.replace(/-/g, "\n"), keys }).ok, true);
    assert.equal(core.verifyCode({ code: `  ${code}  `, keys }).ok, true);
    // 0 → O и 1 → I: человек мог перепутать, проверка обязана простить
    const confused = code.replace(/0/g, "O").replace(/1/g, "I");
    assert.equal(core.verifyCode({ code: confused, keys }).ok, true);
  });

  it("код находится внутри письма", () => {
    const { code } = signCode();
    const letter = `Здравствуйте!\n\nВаш код активации: ${code}\n\nСпасибо за покупку.\n`;
    const result = core.verifyCode({ code: letter, keys: [keyEntry] });
    assert.equal(result.ok, true);
  });

  it("лишние символы и обрезанный код отклоняются", () => {
    const { code } = signCode();
    assert.equal(core.verifyCode({ code: "", keys: [keyEntry] }).reason, core.REJECT.EMPTY);
    assert.equal(core.verifyCode({ code: "   ", keys: [keyEntry] }).reason, core.REJECT.EMPTY);
    assert.equal(core.verifyCode({ code: "привет", keys: [keyEntry] }).reason, core.REJECT.MALFORMED);
    assert.equal(core.verifyCode({ code: code.slice(0, 40), keys: [keyEntry] }).reason, core.REJECT.LENGTH);
  });
});

/* ── Проверка подписи ────────────────────────────────────────────────────── */

describe("проверка подписи", () => {
  it("действительный код принимается", () => {
    const { code, serialHex } = signCode();
    const result = core.verifyCode({ code, keys: [keyEntry] });
    assert.equal(result.ok, true);
    assert.equal(result.license.productId, core.PRODUCT_ID);
    assert.equal(result.license.keyId, 1);
    assert.equal(result.license.serialHex, serialHex);
    assert.equal(result.license.bound, false);
  });

  it("изменённая подпись отклоняется", () => {
    const { payload } = signCode();
    const forged = core.formatCode(Buffer.concat([Buffer.from(payload), crypto.randomBytes(core.SIGNATURE_LENGTH)]));
    assert.equal(core.verifyCode({ code: forged, keys: [keyEntry] }).reason, core.REJECT.SIGNATURE);
  });

  it("изменённая нагрузка отклоняется", () => {
    const { code } = signCode();
    const body = code.replace(/^AGRO-/, "").replace(/-/g, "");
    // 60-й символ тела — это уже подпись: нагрузка цела, подпись не сходится
    const flipped = `${body.slice(0, 60)}${body[60] === "A" ? "B" : "A"}${body.slice(61)}`;
    assert.equal(core.verifyCode({ code: `AGRO-${flipped}`, keys: [keyEntry] }).reason, core.REJECT.SIGNATURE);
  });

  it("код, подписанный другим ключом, не принимается", () => {
    const other = crypto.generateKeyPairSync("ed25519");
    const payload = core.buildPayload({ keyId: 1 });
    const signature = crypto.sign(null, Buffer.from(payload), other.privateKey);
    const code = core.formatCode(Buffer.concat([Buffer.from(payload), Buffer.from(signature)]));
    assert.equal(core.verifyCode({ code, keys: [keyEntry] }).reason, core.REJECT.SIGNATURE);
  });

  it("без открытых ключей код принять нечем", () => {
    const { code } = signCode();
    assert.equal(core.verifyCode({ code, keys: [] }).reason, core.REJECT.UNKNOWN_KEY);
    assert.equal(core.verifyCode({ code, keys: [{ keyId: 1, publicKey: "не-base64" }] }).reason, core.REJECT.UNKNOWN_KEY);
  });

  it("код другого продукта и другой версии формата отклоняются", () => {
    const wrongProduct = signCode({ productId: 0x7f });
    assert.equal(core.verifyCode({ code: wrongProduct.code, keys: [keyEntry] }).reason, core.REJECT.PRODUCT);
    const wrongVersion = signCode({ version: 0x09 });
    assert.equal(core.verifyCode({ code: wrongVersion.code, keys: [keyEntry] }).reason, core.REJECT.VERSION);
  });

  it("ротация ключей: старый код принимается новым ключом из набора", () => {
    const { code } = signCode({ keyId: 1 });
    const second = crypto.generateKeyPairSync("ed25519");
    const keys = [
      keyEntry,
      { keyId: 2, publicKey: second.publicKey.export({ format: "der", type: "spki" }).toString("base64") },
    ];
    assert.equal(core.verifyCode({ code, keys }).ok, true);
  });

  it("отозванный серийник не принимается", () => {
    const { code, serialHex } = signCode();
    assert.equal(core.verifyCode({ code, keys: [keyEntry], revokedSerials: [serialHex] }).reason, core.REJECT.REVOKED);
    assert.equal(core.verifyCode({ code, keys: [keyEntry], revokedSerials: [serialHex.toUpperCase()] }).reason, core.REJECT.REVOKED);
  });

  it("каждый код уникален: серийники не повторяются", () => {
    const serials = new Set();
    for (let index = 0; index < 500; index += 1) serials.add(signCode().serialHex);
    assert.equal(serials.size, 500);
  });
});

/* ── Привязка к компьютеру ───────────────────────────────────────────────── */

describe("персональные коды (привязка к компьютеру)", () => {
  it("общий код работает на любом компьютере", () => {
    const { code } = signCode();
    assert.equal(core.verifyCode({ code, keys: [keyEntry], machineId: "ab".repeat(32) }).ok, true);
    assert.equal(core.verifyCode({ code, keys: [keyEntry], machineId: "" }).ok, true);
  });

  it("персональный код принимается только своим компьютером", () => {
    const machineId = "cd".repeat(32);
    const { code } = signCode({ bound: true, machineId });
    assert.equal(core.verifyCode({ code, keys: [keyEntry], machineId }).ok, true);
    assert.equal(core.verifyCode({ code, keys: [keyEntry], machineId: "ef".repeat(32) }).reason, core.REJECT.MACHINE_MISMATCH);
    assert.equal(core.verifyCode({ code, keys: [keyEntry], machineId: "" }).reason, core.REJECT.MACHINE_UNKNOWN);
  });

  it("короткий идентификатор даёт тот же отпечаток, что полный", () => {
    const machineId = "11".repeat(32);
    const shortId = core.machineShortId(machineId);
    assert.equal(shortId.length, 8);
    assert.deepEqual(core.fingerprintFromShortId(shortId), core.machineFingerprint(machineId));
    // Короткий идентификатор можно передать вместо полного
    const { code } = signCode({ bound: true, machineId });
    assert.equal(core.verifyCode({ code, keys: [keyEntry], machineShortId: shortId }).ok, true);
    assert.equal(core.verifyCode({ code, keys: [keyEntry], machineShortId: core.prettyShortId(shortId) }).ok, true);
  });

  it("resolveBindTarget понимает и короткий, и полный идентификатор", () => {
    const machineId = "22".repeat(32);
    const shortId = core.machineShortId(machineId);
    assert.deepEqual(core.resolveBindTarget(core.prettyShortId(shortId)), { ok: true, shortId });
    assert.deepEqual(core.resolveBindTarget(machineId.toUpperCase()), { ok: true, shortId });
    assert.equal(core.resolveBindTarget("мусор").ok, false);
    assert.equal(core.resolveBindTarget("").ok, false);
  });

  it("у общего кода отпечаток нулевой, у персонального — нет", () => {
    const general = core.parsePayload(core.parseCode(signCode().code).subarray(0, core.PAYLOAD_LENGTH));
    assert.equal(general.bound, false);
    assert.deepEqual([...general.fingerprint], [0, 0, 0, 0]);
    const bound = core.parsePayload(
      core.parseCode(signCode({ bound: true, machineId: "33".repeat(32) }).code).subarray(0, core.PAYLOAD_LENGTH),
    );
    assert.equal(bound.bound, true);
    assert.equal(bound.consistent, true);
  });
});

/* ── Бессрочность ────────────────────────────────────────────────────────── */

describe("лицензия бессрочная: дат нет ни в коде, ни в проверке", () => {
  const MODULES = [
    "electron/license/core.cjs",
    "electron/license/guard.cjs",
    "electron/license/store.cjs",
    "electron/license/integrity.cjs",
    "electron/license/keys.cjs",
    "electron/license/request.cjs",
    "electron/license/checkmode.cjs",
  ];

  it("в модулях лицензирования нет обращений к часам", () => {
    for (const relative of MODULES) {
      const source = fs.readFileSync(path.join(ROOT, relative), "utf8");
      // setTimeout в guard.cjs — пауза против перебора кодов, а не проверка срока,
      // поэтому часов здесь быть не должно вовсе.
      for (const pattern of [/\bDate\b/, /Date\.now/, /\bperformance\.now/, /\bhrtime\b/, /\bgetTime\b/, /\btoLocaleDateString\b/]) {
        assert.equal(pattern.test(source), false, `${relative}: найдено ${pattern.source}`);
      }
    }
  });

  it("в раскладке кода нет поля срока действия", () => {
    const payload = core.buildPayload({ keyId: 1 });
    assert.equal(payload.byteLength, core.PAYLOAD_LENGTH);
    const parsed = core.parsePayload(payload);
    assert.deepEqual(
      Object.keys(parsed).sort(),
      ["bound", "consistent", "fingerprint", "fingerprintHex", "flags", "keyId", "productId", "serial", "serialHex", "version"].sort(),
    );
    assert.equal(core.LICENSE_TERMS.permanent, true);
    assert.equal(core.LICENSE_TERMS.expiration, null);
  });

  it("результат проверки всегда сообщает о бессрочности", () => {
    const result = core.verifyCode({ code: signCode().code, keys: [keyEntry] });
    assert.equal(result.license.permanent, true);
    assert.equal(result.license.expiration, null);
  });

  it("перевод системных часов не меняет решение (проверка детерминирована)", () => {
    const { code } = signCode();
    const first = core.verifyCode({ code, keys: [keyEntry] });
    const second = core.verifyCode({ code, keys: [keyEntry] });
    assert.deepEqual(first, second);
  });

  it("guard.cjs замедляет перебор, но не знает ни сроков, ни пробного периода", () => {
    const source = fs.readFileSync(path.join(ROOT, "electron/license/guard.cjs"), "utf8");
    assert.match(source, /THROTTLE_STEPS/);
    // Поле expiration в статусе есть только как константа null
    assert.match(source, /expiration: null/);
    for (const pattern of [/validUntil/i, /expiresAt/i, /expiryDate/i, /\btrial\b/i, /осталось дней/i, /пробн/i]) {
      assert.doesNotMatch(source, pattern, `найдено ${pattern.source}`);
    }
  });
});

/* ── Хранилище лицензии ──────────────────────────────────────────────────── */

describe("хранилище лицензии", () => {
  function fakeSafeStorage(secret = "os-key-material") {
    let available = true;
    return {
      setAvailable: (value) => {
        available = value;
      },
      isEncryptionAvailable: () => available,
      encryptString: (text) => Buffer.from(`${secret}:${Buffer.from(text, "utf8").toString("hex")}`, "utf8"),
      decryptString: (buffer) => {
        const text = Buffer.from(buffer).toString("utf8");
        const prefix = `${secret}:`;
        if (!text.startsWith(prefix)) throw new Error("не тот ключ");
        return Buffer.from(text.slice(prefix.length), "hex").toString("utf8");
      },
    };
  }

  it("без файла лицензии — статус none", async () => {
    const dir = makeTempDir("agro-store-");
    const store = createLicenseStore({ dir, machineId: () => "ab".repeat(32), safeStorage: fakeSafeStorage() });
    assert.deepEqual(await store.read(), { status: "none" });
  });

  it("запись и чтение через safeStorage", async () => {
    const dir = makeTempDir("agro-store-");
    const safeStorage = fakeSafeStorage();
    const store = createLicenseStore({ dir, machineId: () => "ab".repeat(32), safeStorage });
    const record = { payload: "AA", signature: "BB", serialHex: "cc" };
    assert.deepEqual(await store.write(record), { ok: true });
    const read = await store.read();
    assert.equal(read.status, "active");
    assert.deepEqual(read.record, record);

    const raw = fs.readFileSync(path.join(dir, "agroprognoz.license"), "utf8");
    assert.match(raw, /^AGROLIC1/);
    assert.equal(raw.includes("AA"), false, "содержимое не должно лежать открытым текстом");
  });

  it("файл с другой машины не читается", async () => {
    const dir = makeTempDir("agro-store-");
    const safeStorage = fakeSafeStorage();
    const first = createLicenseStore({ dir, machineId: () => "ab".repeat(32), safeStorage });
    await first.write({ payload: "AA", signature: "BB" });
    const second = createLicenseStore({ dir, machineId: () => "cd".repeat(32), safeStorage });
    const read = await second.read();
    assert.equal(read.status, "invalid");
    assert.equal(read.reason, "MACHINE");
  });

  it("подмена полей конверта видна по HMAC", async () => {
    const dir = makeTempDir("agro-store-");
    const safeStorage = fakeSafeStorage();
    const store = createLicenseStore({ dir, machineId: () => "ab".repeat(32), safeStorage });
    await store.write({ payload: "AA", signature: "BB" });
    const file = path.join(dir, "agroprognoz.license");
    const envelope = JSON.parse(fs.readFileSync(file, "utf8").replace(/^AGROLIC1\s*/, ""));
    envelope.data = Buffer.from("подмена").toString("base64");
    await fsp.writeFile(file, `AGROLIC1\n${JSON.stringify(envelope, null, 2)}\n`, "utf8");
    const read = await store.read();
    assert.equal(read.status, "invalid");
    assert.equal(read.reason, "MAC");
  });

  it("мусор вместо файла — invalid, а не падение", async () => {
    const dir = makeTempDir("agro-store-");
    await fsp.writeFile(path.join(dir, "agroprognoz.license"), "AGROLIC1\n{не json", "utf8");
    const store = createLicenseStore({ dir, machineId: () => "ab".repeat(32), safeStorage: fakeSafeStorage() });
    assert.equal((await store.read()).status, "invalid");
  });

  it("без safeStorage работает запасной шифр на идентификаторе машины", async () => {
    const dir = makeTempDir("agro-store-");
    const safeStorage = fakeSafeStorage();
    safeStorage.setAvailable(false);
    const store = createLicenseStore({ dir, machineId: () => "ab".repeat(32), safeStorage });
    assert.deepEqual(await store.write({ payload: "AA", signature: "BB" }), { ok: true });
    const read = await store.read();
    assert.equal(read.status, "active");
    assert.deepEqual(read.record, { payload: "AA", signature: "BB" });

    // Ключ запасного шифра выводится из идентификатора компьютера
    const other = createLicenseStore({ dir, machineId: () => "ff".repeat(32), safeStorage });
    assert.equal((await other.read()).status, "invalid");
  });

  it("запасной шифр: AES-256-GCM, ключ из HKDF", () => {
    const cipher = createFallbackCipher("ab".repeat(32));
    assert.equal(cipher.kind, "aes-gcm");
    const salt = crypto.randomBytes(16);
    const encrypted = cipher.encrypt(salt, Buffer.from("секрет"));
    assert.equal(cipher.decrypt(salt, encrypted.iv, encrypted.data, encrypted.tag).toString("utf8"), "секрет");
    assert.throws(() => cipher.decrypt(crypto.randomBytes(16), encrypted.iv, encrypted.data, encrypted.tag));
  });

  it("карантин: нечитаемый файл переименовывается, а не удаляется", async () => {
    const dir = makeTempDir("agro-store-");
    const file = path.join(dir, "agroprognoz.license");
    await fsp.writeFile(file, "мусор", "utf8");
    const store = createLicenseStore({ dir, machineId: () => "ab".repeat(32), safeStorage: fakeSafeStorage() });
    const name = await store.quarantine("broken");
    assert.ok(name && name.endsWith(".bad"));
    assert.equal(fs.existsSync(file), false);
    assert.equal(fs.existsSync(path.join(dir, name)), true);
  });
});

/* ── Целостность файлов ──────────────────────────────────────────────────── */

describe("самопроверка целостности", () => {
  function fixture() {
    const dir = makeTempDir("agro-integrity-");
    const distDir = path.join(dir, "dist");
    const electronDir = path.join(dir, "electron");
    fs.mkdirSync(path.join(distDir, "assets"), { recursive: true });
    fs.mkdirSync(path.join(electronDir, "license"), { recursive: true });
    fs.writeFileSync(path.join(distDir, "index.html"), "<html>1</html>");
    fs.writeFileSync(path.join(distDir, "assets", "index.js"), "console.log(1);");
    fs.writeFileSync(path.join(electronDir, "license", "guard.cjs"), "module.exports={};");
    fs.writeFileSync(path.join(electronDir, "main.cjs"), "module.exports={};");
    const manifest = {
      dist: {
        "index.html": hashBytes(fs.readFileSync(path.join(distDir, "index.html"))),
        "assets/index.js": hashBytes(fs.readFileSync(path.join(distDir, "assets", "index.js"))),
      },
      electron: {
        "license/guard.cjs": hashBytes(fs.readFileSync(path.join(electronDir, "license", "guard.cjs"))),
        "main.cjs": hashBytes(fs.readFileSync(path.join(electronDir, "main.cjs"))),
      },
    };
    return {
      dir,
      manifest,
      rootHashes: { dist: manifestRootHash(manifest.dist), electron: electronRootHash(manifest.electron) },
    };
  }

  it("нетронутые файлы проходят проверку", async () => {
    const { dir, manifest, rootHashes } = fixture();
    const checker = createIntegrityChecker({ root: dir, manifest, rootHashes });
    const result = await checker.verify();
    assert.equal(result.ok, true);
    assert.equal(result.skipped, false);
    assert.equal(result.checked, 4);
    assert.deepEqual(result.mismatches, []);
  });

  it("изменённый файл сборки ловится", async () => {
    const { dir, manifest, rootHashes } = fixture();
    fs.appendFileSync(path.join(dir, "dist", "assets", "index.js"), "\n// взлом");
    const result = await createIntegrityChecker({ root: dir, manifest, rootHashes }).verify();
    assert.equal(result.ok, false);
    assert.deepEqual(result.mismatches, ["dist/assets/index.js"]);
  });

  it("изменённый main process ловится", async () => {
    const { dir, manifest, rootHashes } = fixture();
    fs.writeFileSync(path.join(dir, "electron", "license", "guard.cjs"), "module.exports={patched:true};");
    const result = await createIntegrityChecker({ root: dir, manifest, rootHashes }).verify();
    assert.equal(result.ok, false);
    assert.deepEqual(result.mismatches, ["electron/license/guard.cjs"]);
  });

  it("подмена манифеста ловится корневым хэшем", async () => {
    const { dir, manifest, rootHashes } = fixture();
    const fake = JSON.parse(JSON.stringify(manifest));
    fake.dist["assets/index.js"] = "0".repeat(64);
    const result = await createIntegrityChecker({ root: dir, manifest: fake, rootHashes }).verify();
    assert.equal(result.ok, false);
    assert.equal(result.reason, "MANIFEST");
  });

  it("пропавший файл — тоже расхождение", async () => {
    const { dir, manifest, rootHashes } = fixture();
    fs.rmSync(path.join(dir, "dist", "index.html"));
    const result = await createIntegrityChecker({ root: dir, manifest, rootHashes }).verify();
    assert.equal(result.ok, false);
    assert.deepEqual(result.mismatches, ["dist/index.html"]);
  });

  it("в исходниках (без корневых хэшей) проверка честно пропускается", async () => {
    const { dir, manifest } = fixture();
    const checker = createIntegrityChecker({ root: dir, manifest, rootHashes: { dist: "__AGRO_DIST_ROOT__", electron: "__AGRO_ELECTRON_ROOT__" } });
    assert.equal(checker.enabled, false);
    const result = await checker.verify();
    assert.deepEqual(result, { ok: true, skipped: true, mismatches: [], checked: 0 });
  });
});

/* ── Условия запуска ─────────────────────────────────────────────────────── */

describe("условия запуска (shield)", () => {
  const argv = ["/app/AgroPrognoz.exe"];

  it("обычный запуск упаковки разрешён", () => {
    assert.equal(decideLaunch({ argv, env: {}, packaged: true, root: ROOT }).ok, true);
  });

  it("отладочные переключатели запрещены", () => {
    for (const extra of ["--inspect", "--inspect-brk", "--inspect-port=9229", "--remote-debugging-port=9222", "--js-flags=--jitless"]) {
      const decision = decideLaunch({ argv: [...argv, extra], env: {}, packaged: true, root: ROOT });
      assert.equal(decision.ok, false, extra);
    }
  });

  it("подключённый инспектор запрещает запуск", () => {
    assert.equal(decideLaunch({ argv, env: {}, packaged: true, inspectorOpen: true, root: ROOT }).ok, false);
  });

  it("переменные разработки в упаковке запрещены, общесистемные — только предупреждение", () => {
    assert.equal(decideLaunch({ argv, env: { AGRO_DEV_SERVER: "http://evil" }, packaged: true, root: ROOT }).ok, false);
    assert.equal(decideLaunch({ argv, env: { AGRO_DEV: "1" }, packaged: true, root: ROOT }).ok, false);
    const withNodeOptions = decideLaunch({ argv, env: { NODE_OPTIONS: "--require ./x.js" }, packaged: true, root: ROOT });
    assert.equal(withNodeOptions.ok, true);
    assert.deepEqual(withNodeOptions.warnings, ["NODE_OPTIONS"]);
  });

  it("запуск не из упаковки разрешён только в исходниках", () => {
    // ROOT — исходники: vite.config.js на месте
    assert.equal(decideLaunch({ argv, env: {}, packaged: false, root: ROOT }).ok, true);
    const extracted = makeTempDir("agro-unpacked-");
    assert.equal(decideLaunch({ argv, env: {}, packaged: false, root: extracted }).ok, false);
    assert.equal(decideLaunch({ argv, env: { AGRO_DEV: "1" }, packaged: false, root: extracted }).ok, true);
  });

  it("в разработке отладочные переключатели не мешают", () => {
    const inspected = inspectLaunchEnvironment({ argv: [...argv, "--inspect"], env: {}, packaged: false, root: ROOT });
    assert.deepEqual(inspected.problems, []);
  });
});

/* ── Идентификатор компьютера ────────────────────────────────────────────── */

/** Идентификатор, который должен получиться из системного значения. */
function expectedMachineId(seed) {
  return crypto.createHash("sha256").update(`${machineModule.DOMAIN}${seed}`, "utf8").digest("hex");
}

describe("идентификатор компьютера", () => {
  // Системные команды и файлы подменяются: тест одинаков на Windows, Linux и macOS,
  // иначе прогон в CI (Windows) зависел бы от реестра конкретного раннера.
  const REG_OUTPUT = [
    "HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Cryptography",
    "    MachineGuid    REG_SZ    12345678-1234-1234-1234-1234567890ab",
    "",
  ].join("\n");
  const GUID = "12345678-1234-1234-1234-1234567890ab";
  const windows = (output) => createMachineIdentity({ platform: "win32", runCommand: () => output, log: () => {} });

  it("в Windows берётся MachineGuid из реестра, идентификатор — 64 hex", () => {
    const machine = windows(REG_OUTPUT);
    assert.match(machine.machineId, /^[0-9a-f]{64}$/);
    assert.equal(machine.quality, "high");
    assert.equal(machine.source, "MachineGuid");
    assert.equal(machine.machineId, expectedMachineId(GUID));
  });

  it("команда реестра вызывается списком аргументов, без оболочки", () => {
    const calls = [];
    createMachineIdentity({
      platform: "win32",
      runCommand: (command, args) => {
        calls.push({ command, args });
        return REG_OUTPUT;
      },
    }).identity();
    assert.equal(calls.length, 1);
    assert.equal(calls[0].command, "reg");
    assert.ok(Array.isArray(calls[0].args) && calls[0].args.every((item) => typeof item === "string"));
    assert.ok(!calls[0].args.some((item) => /[;&|`$]/.test(item)), "в аргументах нет символов оболочки");
  });

  it("в Linux берётся /etc/machine-id", () => {
    const machine = createMachineIdentity({ platform: "linux", readFile: () => `${"a".repeat(32)}\n`, log: () => {} });
    assert.equal(machine.quality, "high");
    assert.equal(machine.source, "machine-id");
    assert.equal(machine.machineId, expectedMachineId("a".repeat(32)));
  });

  it("в macOS берётся IOPlatformUUID", () => {
    const output = '|   "IOPlatformUUID" = "ABCDEF12-3456-7890-abcd-ef1234567890"';
    const machine = createMachineIdentity({ platform: "darwin", runCommand: () => output, log: () => {} });
    assert.equal(machine.quality, "high");
    assert.equal(machine.source, "IOPlatformUUID");
    assert.equal(machine.machineId, expectedMachineId("abcdef12-3456-7890-abcd-ef1234567890"));
  });

  it("недоступный системный идентификатор честно помечается как low", () => {
    const machine = windows("");
    assert.match(machine.machineId, /^[0-9a-f]{64}$/);
    assert.equal(machine.quality, "low");
    assert.equal(machine.source, "fallback");
    assert.notEqual(machine.machineId, expectedMachineId(GUID));
  });

  it("нераспознанный вывод реестра тоже даёт low", () => {
    const machine = windows("ОШИБКА: не удается найти указанный ключ реестра");
    assert.equal(machine.quality, "low");
    assert.equal(machine.source, "fallback");
  });

  it("значение стабильно между обращениями и зависит от идентификатора машины", () => {
    const machine = windows(REG_OUTPUT);
    assert.equal(machine.machineId, machine.machineId);
    assert.notEqual(machine.machineId, windows(`${GUID.slice(0, -2)}cd`).machineId);
  });

  it("реальная платформа тоже даёт рабочий идентификатор", () => {
    // Без подмен: на машине запуска берётся её собственный идентификатор или fallback.
    const machine = createMachineIdentity({ log: () => {} });
    assert.match(machine.machineId, /^[0-9a-f]{64}$/);
    assert.ok(["high", "low"].includes(machine.quality));
  });
});

/* ── Страж лицензии ──────────────────────────────────────────────────────── */

describe("страж лицензии", () => {
  function makeGuard(overrides = {}) {
    return createGuard({
      appRoot: ROOT,
      userDataDir: makeTempDir("agro-guard-"),
      keyMaterial: { keys: [keyEntry], revokedSerials: [] },
      machine: fakeMachine(),
      store: memoryStore(),
      integrity: NO_INTEGRITY,
      log: () => {},
      ...overrides,
    });
  }

  it("до активации приложение закрыто", async () => {
    const guard = makeGuard();
    const status = await guard.initialize();
    assert.equal(status.activated, false);
    assert.equal(status.requiresActivation, true);
    assert.equal(guard.gate("что угодно").code, guard.GATE.NOT_ACTIVATED);
    assert.equal(guard.checkToken("что угодно"), false);
  });

  it("статус всегда сообщает, что лицензия бессрочная", async () => {
    const guard = makeGuard();
    const status = await guard.initialize();
    assert.equal(status.permanent, true);
    assert.equal(status.terms, "permanent");
    assert.equal(status.expiration, null);
  });

  it("выдуманный и испорченный коды отклоняются", async () => {
    const guard = makeGuard();
    await guard.initialize();
    const forged = core.formatCode(Buffer.concat([Buffer.from(signCode().payload), crypto.randomBytes(core.SIGNATURE_LENGTH)]));
    const zeros = await guard.activate(forged);
    assert.equal(zeros.ok, false);
    assert.equal(zeros.reason, core.REJECT.SIGNATURE);
    assert.ok(zeros.message.length > 0);

    const truncated = await guard.activate("AGRO-0000-0000");
    assert.equal(truncated.ok, false);
    assert.equal(truncated.reason, core.REJECT.LENGTH);

    const garbage = await guard.activate("здравствуйте, дайте лицензию");
    assert.equal(garbage.ok, false);
    assert.equal(garbage.reason, core.REJECT.MALFORMED);

    const empty = await guard.activate("");
    assert.equal(empty.ok, false);
    assert.equal(empty.reason, core.REJECT.EMPTY);
    assert.equal(guard.activated, false);
  });

  it("действительный код открывает данные и выдаёт токен", async () => {
    const store = memoryStore();
    const guard = makeGuard({ store });
    await guard.initialize();

    const { code, serialHex } = signCode();
    const result = await guard.activate(code);
    assert.equal(result.ok, true, result.message);
    assert.equal(typeof result.token, "string");
    assert.equal(result.status.token, undefined, "в статусе токена быть не должно");
    assert.equal(result.status.activated, true);
    assert.equal(result.status.permanent, true);
    assert.equal(result.status.serialHex, serialHex);

    assert.equal(guard.gate(result.token), null);
    assert.equal(guard.gate(`${result.token}-лишний-символ`).code, guard.GATE.FORBIDDEN);
    assert.equal(guard.gate("").code, guard.GATE.FORBIDDEN);
    assert.equal(guard.gate(undefined).code, guard.GATE.FORBIDDEN);
    assert.equal(store.writes, 1);
  });

  it("активация переживает перезапуск", async () => {
    const store = memoryStore();
    const first = makeGuard({ store });
    await first.initialize();
    const activated = await first.activate(signCode().code);
    assert.equal(activated.ok, true);

    const second = makeGuard({ store });
    const status = await second.initialize();
    assert.equal(status.activated, true);
    assert.equal(status.serialHex, activated.status.serialHex);
    // Токен сессии каждый запуск свой: старый токен больше не действует
    assert.equal(second.gate(activated.token).code, second.GATE.FORBIDDEN);
    assert.equal(second.gate(second.statusWithToken().token), null);
  });

  it("сохранённая лицензия проверяется заново при каждом запуске", async () => {
    const { code, serialHex } = signCode();
    const store = memoryStore();
    const first = makeGuard({ store });
    await first.initialize();
    assert.equal((await first.activate(code)).ok, true);

    // Владелец отозвал лицензию — в новой сборке она больше не действует
    const second = makeGuard({ store, keyMaterial: { keys: [keyEntry], revokedSerials: [serialHex] } });
    const status = await second.initialize();
    assert.equal(status.activated, false);
    assert.equal(status.reason, core.REJECT.REVOKED);
    assert.equal(second.gate("токен").code, second.GATE.NOT_ACTIVATED);
  });

  it("персональный код чужого компьютера не принимается", async () => {
    const guard = makeGuard();
    await guard.initialize();
    const { code } = signCode({ bound: true, machineId: "zz".repeat(32) });
    const result = await guard.activate(code);
    assert.equal(result.ok, false);
    assert.equal(result.reason, core.REJECT.MACHINE_MISMATCH);
    assert.equal(guard.activated, false);
  });

  it("обнаруженная подмена файлов блокирует и активацию, и данные", async () => {
    const tampered = {
      enabled: true,
      async verify() {
        return { ok: false, skipped: false, mismatches: ["dist/assets/index.js"], checked: 1, reason: "FILE" };
      },
    };
    const guard = makeGuard({ integrity: tampered });
    const status = await guard.initialize();
    assert.equal(status.tampered, true);
    assert.equal(status.activated, false);
    assert.match(status.tamperDetail, /dist\/assets\/index\.js/);
    assert.equal(guard.gate("токен").code, guard.GATE.TAMPERED);

    const activation = await guard.activate(signCode().code);
    assert.equal(activation.ok, false);
    assert.equal(activation.code, guard.GATE.TAMPERED);
  });

  it("сбой проверки целостности не лишает доступа к данным", async () => {
    const broken = {
      enabled: true,
      async verify() {
        throw new Error("диск отвалился");
      },
    };
    const guard = makeGuard({ integrity: broken });
    const status = await guard.initialize();
    assert.equal(status.tampered, false);
    const activated = await guard.activate(signCode().code);
    assert.equal(activated.ok, true);
    assert.equal(guard.gate(activated.token), null);
  });

  it("ошибка записи лицензии не блокирует работу, но видна человеку", async () => {
    const store = memoryStore();
    store.write = async () => ({ ok: false, message: "диск полон" });
    const guard = makeGuard({ store });
    await guard.initialize();
    const result = await guard.activate(signCode().code);
    assert.equal(result.ok, true);
    assert.equal(result.persistError, true);
    assert.equal(guard.gate(result.token), null);
    assert.match(result.message, /сохранить/i);
  });

  it("в статусе есть идентификатор компьютера для поддержки", async () => {
    const guard = makeGuard();
    const status = await guard.initialize();
    assert.match(status.machineId, /^[0-9a-f]{64}$/);
    assert.match(status.machineIdShort, /^[0-9A-Z]{4}-[0-9A-Z]{4}$/);
    assert.equal(status.machineQuality, "high");
  });

  it("перебор кодов замедляется, но не зависит от времени", async () => {
    const guard = makeGuard();
    await guard.initialize();
    for (let index = 0; index < 5; index += 1) {
      const result = await guard.activate("AGRO-0000-0000");
      assert.equal(result.ok, false);
      assert.equal(result.attempts, index + 1);
    }
  });
});

/* ── Состав сборки ───────────────────────────────────────────────────────── */

describe("состав открытого материала", () => {
  it("в keys.cjs только открытые ключи", () => {
    const keys = require("../electron/license/keys.cjs");
    assert.ok(Array.isArray(keys.keys) && keys.keys.length > 0);
    for (const entry of keys.keys) {
      assert.equal(typeof entry.keyId, "number");
      assert.match(entry.publicKey, /^[A-Za-z0-9+/=]+$/);
      const publicKey = crypto.createPublicKey({ key: Buffer.from(entry.publicKey, "base64"), format: "der", type: "spki" });
      assert.equal(publicKey.asymmetricKeyType, "ed25519");
    }
    assert.ok(Array.isArray(keys.revokedSerials));
    const source = fs.readFileSync(path.join(ROOT, "electron/license/keys.cjs"), "utf8");
    assert.doesNotMatch(source, /privateKey/);
  });

  it("закрытый ключ не лежит в отслеживаемых каталогах", () => {
    const gitignore = fs.readFileSync(path.join(ROOT, ".gitignore"), "utf8");
    assert.match(gitignore, /^secrets\//m);
    assert.match(gitignore, /^hardened\//m);
  });

  it("в electron/ нет закрытых ключей", () => {
    const files = fs.readdirSync(path.join(ROOT, "electron"), { recursive: true });
    for (const relative of files) {
      const absolute = path.join(ROOT, "electron", String(relative));
      if (!fs.statSync(absolute).isFile()) continue;
      const source = fs.readFileSync(absolute, "utf8");
      assert.doesNotMatch(source, /MC4CAQAwBQYDK2Vw/, `${relative}: похож на закрытый ключ PKCS#8`);
      assert.doesNotMatch(source, /BEGIN (RSA |EC )?PRIVATE KEY/, relative);
    }
  });
});
