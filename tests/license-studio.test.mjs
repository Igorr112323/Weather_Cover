/**
 * «Студия лицензий» и заявка на персональный код: unit-тесты. Запуск: npm test
 *
 * Проверяется полный цикл выдачи без диска и без настоящего закрытого ключа:
 *   • нормализация кода компьютера (регистр, пробелы, I/L/O, полный 64-hex);
 *   • выписывание привязанного кода и его активация стражем (guard.cjs);
 *   • отказ на чужом компьютере и объяснение, что делать при переустановке
 *     Windows;
 *   • повторная активация новым кодом поверх старой лицензии (без удаления
 *     файла лицензии);
 *   • журнал выдачи (в том числе старый формат license-tool) и отзыв;
 *   • перевыпуск на тот же компьютер: предупреждение и автоотзыв старого;
 *   • универсальный код — только с явным подтверждением;
 *   • ЛИЦЕНЗИЯ БЕССРОЧНАЯ: полей срока нет ни в выдаче, ни в текстах;
 *   • модуль доставки (СМС/Telegram/почта): настройки, протоколы — на
 *     подменённых транспортах, без сети и без списания денег;
 *   • локальный сервер студии: без ключа запуска не отвечает.
 *
 * Даты допускаются только в журнале выдачи (учёт владельца) — тесты следят,
 * чтобы они не просочились в код активации, файл лицензии и тексты.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { EventEmitter } from "node:events";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const core = require("../electron/license/core.cjs");
const { createGuard } = require("../electron/license/guard.cjs");
const { createLicenseStore } = require("../electron/license/store.cjs");
const licenseRequest = require("../electron/license/request.cjs");

import {
  LEDGER_COLUMNS,
  LEDGER_HEADER,
  agrolicFileName,
  appendLedgerRows,
  buildAgrolicContent,
  buildBuyerMessage,
  buildBuyerSms,
  buildLicenseCode,
  parseLedger,
  saveLedger,
  serializeLedger,
} from "../scripts/license-shared.mjs";
import { createStudio } from "../scripts/license-studio/studio.mjs";
import { startStudioServer } from "../scripts/license-studio/server.mjs";
import {
  TEST_PHONE,
  deliveryCapabilities,
  isEmailLike,
  isPhoneLike,
  normalizePhone,
  sendEmail,
  sendSmsC,
  sendSmsRu,
  sendTelegram,
} from "../scripts/license-studio/delivery.mjs";

/* ── Общие заготовки ─────────────────────────────────────────────────────── */

let tempDirs = [];

function makeTempDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

after(async () => {
  for (const dir of tempDirs) await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
  tempDirs = [];
});

function makeKeyPair() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
  return {
    privateKey,
    publicKey,
    privateKeyBase64: privateKey.export({ format: "der", type: "pkcs8" }).toString("base64"),
    publicKeyBase64: publicKey.export({ format: "der", type: "spki" }).toString("base64"),
  };
}

/**
 * Файловый слой в памяти: секрет, keys.cjs и журнал живут в Map. keys.cjs
 * исполняется через vm — тот же путь, что у require в бою.
 */
function memoryWorld({ keyPair = makeKeyPair(), ledgerText = "", revokedSerials = [] } = {}) {
  const studioRoot = "/studio-root";
  const files = new Map();
  files.set(
    path.join(studioRoot, "secrets", "license-key.json"),
    JSON.stringify({ keys: [{ keyId: 1, label: "test", privateKey: keyPair.privateKeyBase64, publicKey: keyPair.publicKeyBase64 }] }),
  );

  const keysModulePath = path.join(studioRoot, "electron", "license", "keys.cjs");
  const initialKeys = `module.exports = { keys: [{ keyId: 1, label: "test", publicKey: ${JSON.stringify(keyPair.publicKeyBase64)} }], revokedSerials: ${JSON.stringify(revokedSerials)} };`;
  files.set(keysModulePath, initialKeys);
  if (ledgerText) files.set(path.join(studioRoot, "secrets", "ledger.csv"), ledgerText);

  const io = {
    readFile: async (file) => {
      if (!files.has(file)) {
        const error = new Error("ENOENT");
        error.code = "ENOENT";
        throw error;
      }
      return files.get(file);
    },
    writeFile: async (file, body) => {
      files.set(file, body);
    },
    rename: async (from, to) => {
      files.set(to, files.get(from));
      files.delete(from);
    },
    existsSync: (file) => files.has(file),
    loadModule: (file) => {
      const script = new vm.Script(files.get(file), { filename: file });
      const module = { exports: {} };
      script.runInNewContext({ module, exports: module.exports });
      return module.exports;
    },
  };

  const clock = { value: new Date(2026, 8, 13, 10, 30).getTime() };
  const studio = createStudio({
    root: studioRoot,
    env: {},
    io,
    now: () => clock.value,
  });

  return {
    studio,
    files,
    keyPair,
    clock,
    advance(minutes) {
      clock.value += minutes * 60 * 1000;
    },
    keysModule() {
      return io.loadModule(keysModulePath);
    },
    ledgerText() {
      return files.get(path.join(studioRoot, "secrets", "ledger.csv")) ?? "";
    },
  };
}

/** Идентификатор «настоящей» машины для проверок через страж. */
const BUYER_MACHINE_ID = "ab".repeat(32);
const BUYER_SHORT_ID = core.machineShortId(BUYER_MACHINE_ID);
const OTHER_MACHINE_ID = "cd".repeat(32);

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

const NO_INTEGRITY = Object.freeze({
  enabled: false,
  async verify() {
    return { ok: true, skipped: true, mismatches: [], checked: 0 };
  },
});

function makeGuard({ machineId = BUYER_MACHINE_ID, revokedSerials = [], store = memoryStore() } = {}) {
  return createGuard({
    keyMaterial: { keys: [{ keyId: 1, label: "test", publicKey: world?.keyPair?.publicKeyBase64 ?? "" }], revokedSerials },
    machine: { machineId, quality: "high", source: "test" },
    store,
    integrity: NO_INTEGRITY,
  });
}

let world = null;
before(() => {
  world = memoryWorld();
});

/* ── Нормализация кода компьютера ────────────────────────────────────────── */

describe("студия: нормализация кода компьютера", () => {
  it("принимает код компьютера любым написанием", async () => {
    const variants = [
      core.prettyShortId(BUYER_SHORT_ID), // ZZG5-9ZKT
      BUYER_SHORT_ID, // без разделителя
      BUYER_SHORT_ID.toLowerCase(),
      core.prettyShortId(BUYER_SHORT_ID).toLowerCase().replace(/-/g, " "),
      `  ${core.prettyShortId(BUYER_SHORT_ID)}  `,
    ];
    for (const variant of variants) {
      const local = memoryWorld(); // каждая выдача — отдельный «день» студии
      const result = await local.studio.issue({ machineCode: variant, name: "Иванов" });
      assert.equal(result.ok, true, `${variant}: ${result.message ?? ""}`);
      assert.equal(result.shortId, BUYER_SHORT_ID);
    }
  });

  it("принимает полный 64-символьный идентификатор из заявки", async () => {
    const local = memoryWorld();
    const result = await local.studio.issue({ machineCode: BUYER_MACHINE_ID.toUpperCase(), name: "Иванов" });
    assert.equal(result.ok, true);
    assert.equal(result.shortId, BUYER_SHORT_ID);
  });

  it("отказывает в мусоре, а не выписывает код наугад", async () => {
    const local = memoryWorld();
    for (const bad of ["", "ABC", "ZZZZ-ZZZZ-ZZZZ", "привет", "z".repeat(64)]) {
      const result = await local.studio.issue({ machineCode: bad, name: "Иванов" });
      assert.equal(result.ok, false, JSON.stringify(bad));
    }
  });

  it("имя покупателя обязательно: без него журнал теряет смысл", async () => {
    const local = memoryWorld();
    const result = await local.studio.issue({ machineCode: BUYER_SHORT_ID, name: "   " });
    assert.equal(result.ok, false);
    assert.match(result.message, /имя/i);
  });
});

/* ── Выдача привязанного кода и активация ────────────────────────────────── */

describe("студия: персональный код от заявки до активации", () => {
  it("выписывает код, который активируется на компьютере покупателя", async () => {
    const local = memoryWorld();
    const result = await local.studio.issue({ machineCode: BUYER_SHORT_ID, name: "Иванов И.И.", phone: "+7 900 111-22-33", email: "ivanov@example.com" });
    assert.equal(result.ok, true);
    assert.equal(result.universal, false);
    assert.equal(result.permanent, true);

    const guard = createGuard({
      keyMaterial: { keys: [{ keyId: 1, label: "test", publicKey: local.keyPair.publicKeyBase64 }], revokedSerials: [] },
      machine: { machineId: BUYER_MACHINE_ID, quality: "high", source: "test" },
      store: memoryStore(),
      integrity: NO_INTEGRITY,
    });
    await guard.initialize();
    const activation = await guard.activate(result.code);
    assert.equal(activation.ok, true, activation.reason);
    assert.equal(activation.status.bound, true);
    assert.equal(activation.status.serialHex, result.serialHex);
  });

  it("код покупателя не работает на чужом компьютере", async () => {
    const local = memoryWorld();
    const result = await local.studio.issue({ machineCode: BUYER_SHORT_ID, name: "Иванов" });
    const guard = createGuard({
      keyMaterial: { keys: [{ keyId: 1, label: "test", publicKey: local.keyPair.publicKeyBase64 }], revokedSerials: [] },
      machine: { machineId: OTHER_MACHINE_ID, quality: "high", source: "test" },
      store: memoryStore(),
      integrity: NO_INTEGRITY,
    });
    await guard.initialize();
    const rejection = await guard.activate(result.code);
    assert.equal(rejection.ok, false);
    assert.equal(rejection.reason, core.REJECT.MACHINE_MISMATCH);
    // Сообщение объясняет, что делать (переустановка Windows, новый компьютер)
    assert.match(rejection.message, /владелец|новый код/i);
    assert.match(rejection.message, /переустановил|переустановке|новый компьютер/i);
  });

  it("повторная активация новым кодом поверх старой лицензии — без удаления файла", async () => {
    const local = memoryWorld();
    const first = await local.studio.issue({ machineCode: BUYER_SHORT_ID, name: "Иванов" });
    const second = await local.studio.issue({ machineCode: core.machineShortId(OTHER_MACHINE_ID), name: "Петров" });

    const store = memoryStore();
    const guard = createGuard({
      keyMaterial: { keys: [{ keyId: 1, label: "test", publicKey: local.keyPair.publicKeyBase64 }], revokedSerials: [] },
      machine: { machineId: BUYER_MACHINE_ID, quality: "high", source: "test" },
      store,
      integrity: NO_INTEGRITY,
    });
    await guard.initialize();
    assert.equal((await guard.activate(first.code)).ok, true);

    // Владелец выдал новый код на этот же компьютер: активируем поверх, руками
    // файл лицензии никто не удаляет.
    const third = await local.studio.issue({ machineCode: BUYER_SHORT_ID, name: "Иванов", note: "перевыпуск", force: true });
    const again = await guard.activate(third.code);
    assert.equal(again.ok, true, again.reason);
    assert.equal(again.status.serialHex, third.serialHex);
    assert.notEqual(again.status.serialHex, first.serialHex);
    assert.equal(store.writes, 2);
    assert.equal(second.ok, true); // код другого покупателя тоже выписан нормально
  });

  it("активация файлом .agrolic, который собирает студия", async () => {
    const local = memoryWorld();
    const result = await local.studio.issue({ machineCode: BUYER_SHORT_ID, name: "Иванов" });
    const guard = createGuard({
      keyMaterial: { keys: [{ keyId: 1, label: "test", publicKey: local.keyPair.publicKeyBase64 }], revokedSerials: [] },
      machine: { machineId: BUYER_MACHINE_ID, quality: "high", source: "test" },
      store: memoryStore(),
      integrity: NO_INTEGRITY,
    });
    await guard.initialize();
    // Файл содержит шапку для человека и код: приложение находит код в тексте.
    const activation = await guard.activate(result.agrolic.content);
    assert.equal(activation.ok, true, activation.reason);
    assert.equal(activation.status.serialHex, result.serialHex);
  });

  it("повторная активация работает и с настоящим файлом лицензии на диске", async () => {
    const dir = makeTempDir("agro-store-");
    const local = memoryWorld();
    const store = createLicenseStore({ dir, machineId: () => BUYER_MACHINE_ID });
    const guard = createGuard({
      userDataDir: dir,
      keyMaterial: { keys: [{ keyId: 1, label: "test", publicKey: local.keyPair.publicKeyBase64 }], revokedSerials: [] },
      machine: { machineId: BUYER_MACHINE_ID, quality: "high", source: "test" },
      store,
      integrity: NO_INTEGRITY,
    });
    await guard.initialize();

    const first = await local.studio.issue({ machineCode: BUYER_SHORT_ID, name: "Иванов" });
    assert.equal((await guard.activate(first.code)).ok, true);
    const replacement = await local.studio.issue({ machineCode: BUYER_SHORT_ID, name: "Иванов", force: true });
    assert.equal((await guard.activate(replacement.code)).ok, true);

    const read = await store.read();
    assert.equal(read.status, "active");
    assert.equal(read.record.serialHex, replacement.serialHex);
  });
});

/* ── Универсальный код ───────────────────────────────────────────────────── */

describe("студия: универсальный код — только с явным подтверждением", () => {
  it("без подтверждения отказывает и предупреждает", async () => {
    const local = memoryWorld();
    const result = await local.studio.issue({ name: "Иванов", universal: true });
    assert.equal(result.ok, false);
    assert.equal(result.needConfirmUniversal, true);
    assert.match(result.message, /любом компьютере|передать дальше/i);
    // Ничего не выписано и в журнал не попало
    assert.equal(parseLedger(local.ledgerText()).length, 0);
  });

  it("с подтверждением выписывает код и помечает его в журнале", async () => {
    const local = memoryWorld();
    const result = await local.studio.issue({ name: "Сидоров", universal: true, confirmUniversal: true });
    assert.equal(result.ok, true);
    assert.equal(result.universal, true);

    const rows = parseLedger(local.ledgerText());
    assert.equal(rows.length, 1);
    assert.equal(rows[0].kind, "universal");
    assert.equal(rows[0].shortId, "");
    assert.equal(rows[0].name, "Сидоров");

    // Универсальный код работает на любой машине — и это видно сразу
    for (const machineId of [BUYER_MACHINE_ID, OTHER_MACHINE_ID, "ef".repeat(32)]) {
      const check = core.verifyCode({ code: result.code, keys: [{ keyId: 1, publicKey: local.keyPair.publicKeyBase64 }], machineId });
      assert.equal(check.ok, true, machineId.slice(0, 8));
    }
  });

  it("не даёт выписать универсальный код с указанием компьютера", async () => {
    const local = memoryWorld();
    const result = await local.studio.issue({ machineCode: BUYER_SHORT_ID, name: "Иванов", universal: true, confirmUniversal: true }).catch((error) => error);
    assert.equal(result.ok, false);
    assert.match(result.message, /очистите поле/i);
  });
});

/* ── Повторная выдача на тот же компьютер ────────────────────────────────── */

describe("студия: повторная выдача на тот же код компьютера", () => {
  it("предупреждает и не выписывает второй код молча", async () => {
    const local = memoryWorld();
    await local.studio.issue({ machineCode: BUYER_SHORT_ID, name: "Иванов" });
    const second = await local.studio.issue({ machineCode: BUYER_SHORT_ID, name: "Иванов" });
    assert.equal(second.ok, false);
    assert.equal(second.needForce, true);
    assert.match(second.message, /уже есть действующий код/i);
    // Журнал по-прежнему одна запись: ничего не выписано
    assert.equal(parseLedger(local.ledgerText()).length, 1);
  });

  it("перевыпуск отзывает старый код и помечает замену в журнале", async () => {
    const local = memoryWorld();
    const first = await local.studio.issue({ machineCode: BUYER_SHORT_ID, name: "Иванов" });
    local.advance(60); // «через час» покупатель переустановил Windows и прислал новую заявку
    const second = await local.studio.issue({ machineCode: BUYER_SHORT_ID, name: "Иванов", note: "переустановка Windows", force: true });

    assert.equal(second.ok, true);
    assert.deepEqual(second.replaced, [core.prettySerial(first.serialHex)]);
    assert.notEqual(second.serialHex, first.serialHex);

    // Старый серийник отозван в keys.cjs — следующая сборка его не примет
    assert.ok(local.keysModule().revokedSerials.includes(first.serialHex));

    // Журнал: старая запись отозвана, новая действует и ссылается на старую
    const rows = parseLedger(local.ledgerText());
    const oldRow = rows.find((row) => row.serial === first.serialHex);
    const newRow = rows.find((row) => row.serial === second.serialHex);
    assert.equal(oldRow.status, "revoked");
    assert.match(oldRow.revokedAt, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
    assert.equal(newRow.status, "active");
    assert.equal(newRow.replaces, first.serialHex);
    assert.match(newRow.note, /переустановка Windows/);

    // Новая лицензия действительно активируется на компьютере покупателя
    const guard = createGuard({
      keyMaterial: { keys: [{ keyId: 1, label: "test", publicKey: local.keyPair.publicKeyBase64 }], revokedSerials: local.keysModule().revokedSerials },
      machine: { machineId: BUYER_MACHINE_ID, quality: "high", source: "test" },
      store: memoryStore(),
      integrity: NO_INTEGRITY,
    });
    await guard.initialize();
    assert.equal((await guard.activate(second.code)).ok, true);
    // Старый код отозван — страж его больше не принимает
    assert.equal((await guard.activate(first.code)).reason, core.REJECT.REVOKED);
  });
});

/* ── Журнал выдачи ───────────────────────────────────────────────────────── */

describe("студия: журнал выдачи", () => {
  it("читает старый формат license-tool и переносит его при записи", async () => {
    const legacy = [
      "serial;keyId;bound;shortId;code;note",
      "dd765aac5612aeb9;1;no;;AGRO-AAAAAAAA-AAAAAAAA;универсальный для выставки",
      "1122334455667788;1;yes;ZZG59ZKT;AGRO-BBBBBBBB-BBBBBBBB;Иванов",
    ].join("\n");
    const rows = parseLedger(legacy);
    assert.equal(rows.length, 2);
    assert.equal(rows[0].kind, "universal");
    assert.equal(rows[0].note, "универсальный для выставки");
    assert.equal(rows[1].kind, "personal");
    assert.equal(rows[1].shortId, "ZZG59ZKT");

    // При добавлении записи файл целиком переезжает на новый формат
    const dir = makeTempDir("agro-ledger-");
    const ledger = path.join(dir, "ledger.csv");
    await fsp.writeFile(ledger, legacy + "\n", "utf8");
    await appendLedgerRows(ledger, [{ issuedAt: "2026-09-13 10:00", serial: "aabbccddeeff0011", keyId: 1, kind: "personal", shortId: "AB12CD34", code: "AGRO-CCCCCCCC", name: "Новый", note: "", status: "active", revokedAt: "", replaces: "" }], {
      readFile: (file) => fsp.readFile(file, "utf8"),
      writeFile: (file, body, options) => fsp.writeFile(file, body, options),
      rename: (from, to) => fsp.rename(from, to),
      existsSync: (file) => fs.existsSync(file),
    });
    const migrated = parseLedger(await fsp.readFile(ledger, "utf8"));
    assert.equal(migrated.length, 3);
    assert.ok((await fsp.readFile(ledger, "utf8")).startsWith(LEDGER_HEADER));
    assert.equal(migrated[0].note, "универсальный для выставки");
    assert.equal(migrated[2].name, "Новый");
  });

  it("запись выдачи содержит всё, что ищет владелец", async () => {
    const local = memoryWorld();
    const result = await local.studio.issue({
      machineCode: BUYER_SHORT_ID,
      name: "Иванов И.И.",
      phone: "+7 900 111-22-33",
      email: "ivanov@example.com",
      note: "оплата по счёту",
    });
    const rows = parseLedger(local.ledgerText());
    assert.equal(rows.length, 1);
    const row = rows[0];
    assert.equal(row.name, "Иванов И.И.");
    assert.equal(row.phone, "+7 900 111-22-33");
    assert.equal(row.email, "ivanov@example.com");
    assert.equal(row.note, "оплата по счёту");
    assert.equal(row.shortId, BUYER_SHORT_ID);
    assert.equal(row.serial, result.serialHex);
    assert.equal(row.code, result.code);
    assert.equal(row.status, "active");
    assert.equal(row.kind, "personal");
    assert.match(row.issuedAt, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  });

  it("журнал переносится по кругу без потерь", () => {
    const rows = [
      { issuedAt: "2026-09-13 10:30", serial: "aabbccddeeff0011", keyId: 1, kind: "personal", shortId: "AB12CD34", code: "AGRO-XXXX", name: "Иванов; ООО «Рога»", phone: "", email: "i@example.com", note: "", status: "active", revokedAt: "", replaces: "" },
    ];
    const text = serializeLedger(rows);
    const parsed = parseLedger(text);
    assert.equal(parsed.length, 1);
    // Точка с запятой внутри имени не ломает CSV: она вычищается при записи
    assert.equal(parsed[0].name, "Иванов ООО «Рога»");
  });

  it("в журнале нет колонок срока действия лицензии", () => {
    for (const forbidden of [/expires/i, /validUntil/i, /действует до/i, /срок/i]) {
      assert.equal(forbidden.test(LEDGER_HEADER), false, LEDGER_HEADER);
      for (const column of LEDGER_COLUMNS) assert.equal(forbidden.test(column), false, column);
    }
    // Дата в журнале — только учётная (когда выдано/отозвано)
    assert.ok(LEDGER_COLUMNS.includes("issuedAt"));
    assert.ok(LEDGER_COLUMNS.includes("revokedAt"));
  });
});

/* ── Отзыв ───────────────────────────────────────────────────────────────── */

describe("студия: отзыв по серийнику", () => {
  it("отзыв обновляет keys.cjs и журнал", async () => {
    const local = memoryWorld();
    const issued = await local.studio.issue({ machineCode: BUYER_SHORT_ID, name: "Иванов" });
    const result = await local.studio.revoke(issued.serialHex);
    assert.equal(result.ok, true);

    assert.ok(local.keysModule().revokedSerials.includes(issued.serialHex));
    const rows = parseLedger(local.ledgerText());
    assert.equal(rows.find((row) => row.serial === issued.serialHex).status, "revoked");

    // Отозванный код страж больше не принимает
    const guard = createGuard({
      keyMaterial: { keys: [{ keyId: 1, label: "test", publicKey: local.keyPair.publicKeyBase64 }], revokedSerials: local.keysModule().revokedSerials },
      machine: { machineId: BUYER_MACHINE_ID, quality: "high", source: "test" },
      store: memoryStore(),
      integrity: NO_INTEGRITY,
    });
    await guard.initialize();
    assert.equal((await guard.activate(issued.code)).reason, core.REJECT.REVOKED);
  });

  it("мусорный серийник не принимается", async () => {
    const local = memoryWorld();
    for (const bad of ["", "xyz", "12345"]) {
      const result = await local.studio.revoke(bad).catch((error) => ({ ok: false, message: error.message }));
      assert.equal(result.ok, false, JSON.stringify(bad));
    }
  });
});

/* ── Бессрочность ────────────────────────────────────────────────────────── */

describe("студия: лицензия бессрочная, полей срока нет", () => {
  it("в результате выдачи нет даты окончания и есть явная бессрочность", async () => {
    const local = memoryWorld();
    const result = await local.studio.issue({ machineCode: BUYER_SHORT_ID, name: "Иванов" });
    assert.equal(result.permanent, true);
    for (const key of Object.keys(result)) {
      assert.doesNotMatch(key, /expires|validUntil|expiry/i, key);
    }
    const license = core.verifyCode({ code: result.code, keys: [{ keyId: 1, publicKey: local.keyPair.publicKeyBase64 }], machineId: BUYER_MACHINE_ID }).license;
    assert.equal(license.permanent, true);
    assert.equal(license.expiration, null);
  });

  it("тексты для покупателя говорят о бессрочности и не содержат дат", async () => {
    const local = memoryWorld();
    const result = await local.studio.issue({ machineCode: BUYER_SHORT_ID, name: "Иванов" });
    for (const text of [result.messageText, result.smsText, result.agrolic.content]) {
      assert.match(text, /бессрочн/i);
      assert.doesNotMatch(text, /\d{2}[./]\d{2}[./]\d{2,4}/);
      assert.doesNotMatch(text, /действует до|срок действия истекает/i);
    }
    assert.ok(result.messageText.includes(result.code));
    assert.ok(result.smsText.length < 320, `СМС-текст должен быть компактным, получено ${result.smsText.length}`);
    assert.ok(agrolicFileName(result.serialHex).endsWith(".agrolic"));
    // Код находится в файле лицензии даже с шапкой
    assert.equal(core.verifyCode({ code: result.agrolic.content, keys: [{ keyId: 1, publicKey: local.keyPair.publicKeyBase64 }], machineId: BUYER_MACHINE_ID }).ok, true);
  });

  it("тексты сообщений собираются и без студии (общая библиотека)", () => {
    const message = buildBuyerMessage({ name: "Пётр", code: "AGRO-TEST", shortId: "AB12CD34", serialHex: "aabbccddeeff0011", universal: false });
    assert.match(message, /Пётр, здравствуйте/);
    assert.match(message, /только на компьютере AB12-CD34/);
    assert.match(message, /AABB-CCDD-EEFF-0011/);
    const sms = buildBuyerSms({ code: "AGRO-TEST", shortId: "AB12CD34" });
    assert.match(sms, /бессрочн/);
    const agrolic = buildAgrolicContent({ name: "Пётр", shortId: "AB12CD34", serialHex: "aabbccddeeff0011", code: "AGRO-TEST" });
    assert.match(agrolic, /бессрочная, без ограничения по дате/);
  });
});

/* ── Заявка на персональный код (сторона приложения) ─────────────────────── */

describe("заявка владельцу: текст и каналы (main process)", () => {
  it("текст заявки содержит код компьютера, полный идентификатор и версию", () => {
    const text = licenseRequest.buildRequestText({
      machineShortId: core.prettyShortId(BUYER_SHORT_ID),
      machineId: BUYER_MACHINE_ID,
      version: "0.2.1",
    });
    assert.match(text, /Заявка на персональный код активации/);
    assert.ok(text.includes(core.prettyShortId(BUYER_SHORT_ID)));
    assert.ok(text.includes(BUYER_MACHINE_ID));
    assert.ok(text.includes("0.2.1"));
    assert.match(text, /бессрочн/i);
    assert.doesNotMatch(text, /\d{2}[./]\d{2}[./]\d{2,4}/);
  });

  it("ссылки каналов связи строит main process — и только он", () => {
    const text = "Заявка";
    const contact = { phone: "79604843463", telegramUser: "agro_owner", email: "owner@example.com" };
    const whatsapp = licenseRequest.buildChannelUrl("whatsapp", text, contact);
    assert.ok(whatsapp.startsWith("https://wa.me/79604843463?text="));
    const telegram = licenseRequest.buildChannelUrl("telegram", text, contact);
    assert.equal(telegram, "tg://resolve?domain=agro_owner");
    const telegramByPhone = licenseRequest.buildChannelUrl("telegram", text, { phone: "79604843463", telegramUser: "", email: "" });
    assert.ok(telegramByPhone.startsWith("https://t.me/share/url"));
    const email = licenseRequest.buildChannelUrl("email", text, contact);
    assert.ok(email.startsWith("mailto:owner@example.com?subject="));
    assert.equal(licenseRequest.buildChannelUrl("unknown", text, contact), null);
  });

  it("канал доступен, только если контакт задан; пустой контакт всё выключает", () => {
    assert.deepEqual(licenseRequest.channelAvailability({ phone: "", telegramUser: "", email: "" }), {
      telegram: false,
      whatsapp: false,
      email: false,
    });
    const availability = licenseRequest.channelAvailability({ phone: "79604843463", telegramUser: "", email: "bad-address" });
    assert.equal(availability.telegram, true);
    assert.equal(availability.whatsapp, true);
    assert.equal(availability.email, false);
  });

  it("в модуле заявки нет обращений к часам", () => {
    const source = fs.readFileSync(path.join(ROOT, "electron", "license", "request.cjs"), "utf8");
    for (const pattern of [/\bDate\b/, /Date\.now/, /\bperformance\.now/, /\bhrtime\b/, /\bgetTime\b/]) {
      assert.equal(pattern.test(source), false, `request.cjs: найдено ${pattern.source}`);
    }
  });

  it("имя файла заявки зависит от кода компьютера", () => {
    assert.equal(licenseRequest.requestFileName("ZZG59ZKT"), "agroprognoz-request-ZZG59ZKT.agrorequest");
    assert.ok(licenseRequest.requestFileName("").endsWith(".agrorequest"));
  });
});

/* ── Доставка (СМС / Telegram / почта) ───────────────────────────────────── */

describe("доставка кода: настройки и нормализация", () => {
  it("без переменных окружения все каналы выключены", () => {
    const capabilities = deliveryCapabilities({});
    assert.equal(capabilities.sms, null);
    assert.equal(capabilities.telegram, false);
    assert.equal(capabilities.smtp, false);
  });

  it("каналы включаются переменными окружения", () => {
    assert.equal(deliveryCapabilities({ AGRO_SMS_PROVIDER: "smsru", AGRO_SMS_API_KEY: "key" }).sms.provider, "smsru");
    assert.equal(deliveryCapabilities({ AGRO_SMS_PROVIDER: "smsc", AGRO_SMSC_LOGIN: "l", AGRO_SMSC_PASSWORD: "p" }).sms.provider, "smsc");
    assert.equal(deliveryCapabilities({ AGRO_SMS_PROVIDER: "smsru" }).sms, null, "без ключа провайдера СМС не включается");
    assert.equal(deliveryCapabilities({ AGRO_TG_BOT_TOKEN: "t" }).telegram, true);
    assert.equal(deliveryCapabilities({ AGRO_SMTP_HOST: "smtp.example.com", AGRO_SMTP_USER: "u", AGRO_SMTP_PASS: "p" }).smtp, true);
  });

  it("телефоны нормализуются: тестовый номер и привычные написания", () => {
    assert.equal(normalizePhone(TEST_PHONE), "79604843463");
    assert.equal(normalizePhone("+7 960 484-34-63"), "79604843463");
    assert.equal(normalizePhone("8 (960) 484-34-63"), "79604843463");
    assert.equal(normalizePhone("9604843463"), "79604843463");
    assert.equal(isPhoneLike(TEST_PHONE), true);
    assert.equal(isPhoneLike("12345"), false);
    assert.equal(isEmailLike("pupkin@example.com"), true);
    assert.equal(isEmailLike("не почта"), false);
  });
});

describe("доставка кода: СМС и Telegram (подменённый fetch)", () => {
  function captureFetch(handler) {
    const calls = [];
    const fetchImpl = async (url, init) => handler(calls, url, init);
    return { calls, fetchImpl };
  }

  it("SMS.ru получает api_id, номер и текст", async () => {
    const { calls, fetchImpl } = captureFetch((store, url, init) => {
      store.push({ url, body: init.body });
      return { status: 200, text: async () => JSON.stringify({ status: "OK" }) };
    });
    const result = await sendSmsRu({ apiKey: "APIKEY", to: TEST_PHONE, text: "код", fetchImpl });
    assert.equal(result.ok, true, result.message);
    assert.equal(calls[0].url, "https://api.sms.ru/sms/send");
    assert.equal(new URLSearchParams(calls[0].body).get("api_id"), "APIKEY");
    assert.equal(new URLSearchParams(calls[0].body).get("to"), "79604843463");
    assert.equal(new URLSearchParams(calls[0].body).get("msg"), "код");
  });

  it("ошибка SMS.ru доходит до владельца текстом", async () => {
    const { fetchImpl } = captureFetch(() => ({ status: 200, text: async () => JSON.stringify({ status: "ERROR", status_text: "баланс кончился" }) }));
    const result = await sendSmsRu({ apiKey: "APIKEY", to: TEST_PHONE, text: "код", fetchImpl });
    assert.equal(result.ok, false);
    assert.match(result.message, /баланс кончился/);
  });

  it("SMSC.ru получает логин, пароль, номер и текст", async () => {
    const { calls, fetchImpl } = captureFetch((store, url, init) => {
      store.push({ url, body: init.body });
      return { status: 200, text: async () => JSON.stringify({ error_code: 0, id: "77" }) };
    });
    const result = await sendSmsC({ login: "login", password: "pass", to: TEST_PHONE, text: "код", fetchImpl });
    assert.equal(result.ok, true, result.message);
    assert.equal(calls[0].url, "https://smsc.ru/sys/send.php");
    const params = new URLSearchParams(calls[0].body);
    assert.equal(params.get("login"), "login");
    assert.equal(params.get("psw"), "pass");
    assert.equal(params.get("phones"), "79604843463");
    assert.equal(params.get("fmt"), "3");
  });

  it("Telegram-бот отправляет сообщение в chat_id", async () => {
    const { calls, fetchImpl } = captureFetch((store, url, init) => {
      store.push({ url, body: JSON.parse(init.body) });
      return { status: 200, json: async () => ({ ok: true }) };
    });
    const result = await sendTelegram({ token: "TOKEN", chatId: "123456789", text: "ваш код", fetchImpl });
    assert.equal(result.ok, true, result.message);
    assert.equal(calls[0].url, "https://api.telegram.org/botTOKEN/sendMessage");
    assert.equal(calls[0].body.chat_id, "123456789");
    assert.equal(calls[0].body.text, "ваш код");
  });

  it("без chat_id Telegram честно отказывает", async () => {
    const result = await sendTelegram({ token: "TOKEN", chatId: "какой-то текст", text: "код", fetchImpl: async () => ({ status: 200, json: async () => ({ ok: true }) }) });
    assert.equal(result.ok, false);
    assert.match(result.message, /chat_id/);
  });
});

describe("доставка кода: почта через SMTP (подменённые сокеты)", () => {
  /**
   * Скриптованный SMTP-сервер: отвечает на команды по порядку и помнит,
   * что получил. STARTTLS возвращает «новый» сокет — тот же скрипт.
   */
  function scriptServer({ failAuth = false } = {}) {
    const received = [];
    let expected = null;
    const state = { phase: 0 };
    const server = new FakeSmtpServer({ received, failAuth, state });
    const netImpl = {
      connect(_port, _host) {
        const socket = new FakeSocket(server);
        queueMicrotask(() => socket.emit("data", Buffer.from("220 fake ESMTP ready\r\n")));
        return socket;
      },
    };
    const tlsImpl = {
      connect() {
        const socket = new FakeSocket(server, { tls: true });
        return socket;
      },
    };
    return { netImpl, tlsImpl, received };
  }

  class FakeSmtpServer {
    constructor({ received, failAuth, state }) {
      this.received = received;
      this.failAuth = failAuth;
      this.state = state;
      this.awaitingData = false;
      this.dataBuffer = "";
    }

    handle(socket, chunk) {
      if (this.awaitingData) {
        this.dataBuffer += chunk.toString("utf8");
        if (this.dataBuffer.includes("\r\n.\r\n") || this.dataBuffer.endsWith("\r\n.\n") || this.dataBuffer.endsWith("\n.\r\n")) {
          this.awaitingData = false;
          this.received.push({ command: "DATA-BODY", body: this.dataBuffer });
          this.dataBuffer = "";
          socket.emit("data", Buffer.from("250 OK: queued\r\n"));
        }
        return;
      }
      for (const rawLine of chunk.toString("utf8").split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line) continue;
        this.received.push({ command: line });
        const reply = this.reply(line);
        if (reply) socket.emit("data", Buffer.from(reply));
      }
    }

    reply(line) {
      if (/^EHLO/i.test(line)) {
        this.state.ehlo = (this.state.ehlo ?? 0) + 1;
        if (this.state.ehlo === 1) return "250-fake\r\n250-STARTTLS\r\n250 AUTH LOGIN\r\n";
        return "250-fake\r\n250 AUTH LOGIN\r\n";
      }
      if (/^STARTTLS/i.test(line)) return "220 ready to start TLS\r\n";
      if (/^AUTH LOGIN$/i.test(line)) {
        this.state.awaitingUsername = true;
        return "334 VXNlcm5hbWU6\r\n";
      }
      if (this.state.awaitingUsername) {
        this.state.awaitingUsername = false;
        this.state.awaitingPassword = true;
        this.state.user = Buffer.from(line, "base64").toString("utf8");
        return "334 UGFzc3dvcmQ6\r\n";
      }
      if (this.state.awaitingPassword) {
        this.state.awaitingPassword = false;
        this.state.password = Buffer.from(line, "base64").toString("utf8");
        if (this.failAuth) return "535 authentication failed\r\n";
        return "235 authenticated\r\n";
      }
      if (/^MAIL FROM/i.test(line)) return "250 ok\r\n";
      if (/^RCPT TO/i.test(line)) return "250 ok\r\n";
      if (/^DATA$/i.test(line)) {
        this.awaitingData = true;
        return "354 end with <CRLF>.<CRLF>\r\n";
      }
      if (/^QUIT/i.test(line)) return "221 bye\r\n";
      return "502 not implemented\r\n";
    }
  }

  class FakeSocket extends EventEmitter {
    constructor(server, { tls = false } = {}) {
      super();
      this.server = server;
      this.tls = tls;
      this.destroyed = false;
      this.on("data", () => {});
    }

    write(data) {
      queueMicrotask(() => this.server.handle(this, Buffer.from(data)));
    }

    setTimeout() {}

    end() {
      this.destroyed = true;
    }

    destroy() {
      this.destroyed = true;
    }
  }

  it("полный диалог: EHLO, STARTTLS, AUTH LOGIN, письмо, QUIT", async () => {
    const { netImpl, tlsImpl, received } = scriptServer();
    const result = await sendEmail({
      host: "smtp.example.com",
      port: 587,
      user: "owner@example.com",
      password: "secret",
      from: "owner@example.com",
      to: "buyer@example.com",
      subject: "Код активации",
      text: "Здравствуйте!\n\nВаш код: AGRO-TEST.\nЛицензия бессрочная.",
      netImpl,
      tlsImpl,
    });
    assert.equal(result.ok, true, result.message);

    const commands = received.map((item) => item.command);
    assert.equal(commands[0], "EHLO agro-studio");
    assert.ok(commands.includes("STARTTLS"));
    assert.ok(commands.filter((command) => command === "EHLO agro-studio").length >= 2, "после STARTTLS нужен второй EHLO");
    assert.equal(received.find((item) => item.command.startsWith("AUTH LOGIN")).command, "AUTH LOGIN");

    const body = received.find((item) => item.command === "DATA-BODY").body;
    assert.match(body, /From: owner@example\.com/);
    assert.match(body, /To: buyer@example\.com/);
    assert.match(body, /Subject: =\?UTF-8\?B\?/);
    assert.match(body, /Content-Type: text\/plain; charset="UTF-8"/);
    // Тело письма в base64 — кириллица доедет без искажений
    const encoded = body
      .split(/\r?\n\r?\n/)[1]
      .replace(/\r?\n\.\r?\n?$/, "")
      .split(/\r?\n/)
      .join("");
    assert.ok(Buffer.from(encoded, "base64").toString("utf8").includes("AGRO-TEST"));
    // Точка-в-точке (dot-stuffing) не нужна: тело закодировано
    assert.ok(body.trimEnd().endsWith("\r\n."));
  });

  it("неверный пароль SMTP превращается в понятный отказ", async () => {
    const { netImpl, tlsImpl } = scriptServer({ failAuth: true });
    const result = await sendEmail({
      host: "smtp.example.com",
      user: "owner@example.com",
      password: "wrong",
      to: "buyer@example.com",
      text: "код",
      netImpl,
      tlsImpl,
    });
    assert.equal(result.ok, false);
    assert.match(result.message, /535/);
  });

  it("кривой адрес получателя отвергается до соединения", async () => {
    const result = await sendEmail({ host: "smtp.example.com", user: "u", password: "p", to: "не почта", text: "код", netImpl: { connect() { throw new Error("не должен соединяться"); } } });
    assert.equal(result.ok, false);
    assert.match(result.message, /адрес почты/i);
  });
});

/* ── Локальный сервер студии ─────────────────────────────────────────────── */

describe("локальный сервер студии", () => {
  it("без ключа запуска не отвечает, с ключом — выдаёт состояние и коды", async () => {
    const local = memoryWorld();
    const token = crypto.randomBytes(16).toString("hex");
    const server = await startStudioServer({ backend: local.studio, token, port: 0 });
    try {
      const baseUrl = `http://127.0.0.1:${server.port}`;

      const refused = await fetch(`${baseUrl}/api/state`);
      assert.equal(refused.status, 403);
      assert.equal((await refused.json()).ok, false);

      const page = await fetch(baseUrl);
      assert.equal(page.status, 200);
      assert.ok((await page.text()).includes("Студия лицензий"));

      const state = await fetch(`${baseUrl}/api/state`, { headers: { "x-agro-studio": token } });
      const info = await state.json();
      assert.equal(info.ok, true);
      assert.equal(info.permanent, true);
      assert.match(info.terms, /бессрочн/i);
      assert.ok(Array.isArray(info.ledger));

      const issued = await fetch(`${baseUrl}/api/issue`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-agro-studio": token },
        body: JSON.stringify({ machineCode: BUYER_SHORT_ID, name: "Иванов" }),
      });
      const result = await issued.json();
      assert.equal(result.ok, true);
      assert.ok(result.code.startsWith("AGRO-"));
    } finally {
      await server.close();
    }
  });
});

/* ── Статика: секреты не утекают ─────────────────────────────────────────── */

describe("студия: закрытый ключ остаётся на месте", () => {
  it("выдача не возвращает закрытый ключ и содержимое secrets/", async () => {
    const local = memoryWorld();
    const token = crypto.randomBytes(16).toString("hex");
    const server = await startStudioServer({ backend: local.studio, token, port: 0 });
    try {
      const issued = await (
        await fetch(`http://127.0.0.1:${server.port}/api/issue`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-agro-studio": token },
          body: JSON.stringify({ machineCode: BUYER_SHORT_ID, name: "Иванов" }),
        })
      ).json();
      const serialized = JSON.stringify(issued);
      assert.ok(!serialized.includes(local.keyPair.privateKeyBase64), "закрытый ключ не должен покидать студию");
      assert.ok(!serialized.includes("license-key.json"));
    } finally {
      await server.close();
    }
  });

  it("buildLicenseCode — общий путь командной строки и студии", () => {
    const keyPair = makeKeyPair();
    const issued = buildLicenseCode({ privateKeyBase64: keyPair.privateKeyBase64, keyId: 1, bound: true, shortId: BUYER_SHORT_ID });
    const check = core.verifyCode({ code: issued.code, keys: [{ keyId: 1, publicKey: keyPair.publicKeyBase64 }], machineId: BUYER_MACHINE_ID });
    assert.equal(check.ok, true);
    const wrongMachine = core.verifyCode({ code: issued.code, keys: [{ keyId: 1, publicKey: keyPair.publicKeyBase64 }], machineId: OTHER_MACHINE_ID });
    assert.equal(wrongMachine.reason, core.REJECT.MACHINE_MISMATCH);
  });
});
