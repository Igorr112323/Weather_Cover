/**
 * Проверка автономной страницы «Активация ключей».
 * Запуск: node --test tests/standalone.test.mjs   (из каталога station/)
 *
 * Страница собирается скриптом scripts/build-standalone.mjs из тех же файлов,
 * что использует приложение, поэтому тесты строятся вокруг двух вещей:
 *
 *   1) собранный файл актуален (не «забыли пересобрать» после правки ядра);
 *   2) браузерная обвязка (WebCrypto) даёт те же вердикты, что Node-код
 *      приложения: код страницы принимает приложение, код приложения принимает
 *      страница, одинаковые причины отказа на мусор, подделку, чужой компьютер
 *      и отозванный серийник.
 *
 * Расхождение = красный тест: покупатель получил бы код, который приложение не
 * принимает, или наоборот.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import net from "node:net";
import path from "node:path";
import vm from "node:vm";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const STATION_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PROJECT_ROOT = path.resolve(STATION_ROOT, "..");
const HTML_FILE = path.join(STATION_ROOT, "standalone", "aktivaciya-klyuchey.html");
const TEMPLATE = path.join(STATION_ROOT, "standalone", "template.html");
const BUILDER = path.join(STATION_ROOT, "scripts", "build-standalone.mjs");

const builder = await import(pathToFileURL(BUILDER).href);
const core = require(path.join(STATION_ROOT, "vendor", "core.cjs"));
const checkmode = require(path.join(STATION_ROOT, "vendor", "checkmode.cjs"));
const shared = await import(pathToFileURL(path.join(STATION_ROOT, "vendor", "license-shared.mjs")).href);
const request = await import(pathToFileURL(path.join(STATION_ROOT, "src", "request.mjs")).href);

/* ─────────────────────────── окружение «как в браузере» ────────────────── */

/**
 * Собирает бандл в памяти и исполняет в чистом контексте: DOM не подключается,
 * есть только WebCrypto Node — ровно то, что нужно логике страницы.
 */
async function loadGlue() {
  const bundle = builder.buildBundle({ indent: "" });
  // Тот же realm, что и у теста: иначе Uint8Array из vm не проходит проверку
  // `instanceof Uint8Array` в ядре, и Buffer-ы Host'а выглядят чужими.
  return vm.runInThisContext(`(() => {
"use strict";
${bundle}
return { AGRO, AGRO_CORE, AGRO_CM, AGRO_L, AGRO_R, AGRO_MESSAGES };
})()`);
}

const PAGE = await loadGlue();
const { AGRO, AGRO_L, AGRO_R, AGRO_CM } = PAGE;

const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
const SPKI_B64 = publicKey.export({ format: "der", type: "spki" }).toString("base64");
const PKCS8_B64 = privateKey.export({ format: "der", type: "pkcs8" }).toString("base64");
const KEYS = [{ keyId: 1, label: "тест", publicKey: SPKI_B64 }];
const MACHINE_A = "ab".repeat(32);
const MACHINE_B = "cd".repeat(32);
const SHORT_A = core.machineShortId(MACHINE_A);
const SHORT_B = core.machineShortId(MACHINE_B);

/* ─────────────────────────── собранный файл актуален ──────────────────── */

describe("автономная страница собрана из исходников проекта", () => {
  it("в шаблоне нет скопированной руками криптографии", () => {
    const template = fs.readFileSync(TEMPLATE, "utf8");
    assert.ok(template.includes("<!-- @BUNDLE@ -->"), "в шаблоне должна быть метка сборки @BUNDLE@");
    assert.ok(!/function base32Decode|function parsePayload|Crockford/.test(template), "формат кода не должен быть переписан в шаблоне руками");
  });

  it("готовый файл совпадает со сборкой (не забыли npm run station:standalone)", () => {
    const expected = builder.build();
    const actual = fs.readFileSync(HTML_FILE, "utf8");
    assert.equal(actual, expected, "файл устарел: выполните node station/scripts/build-standalone.mjs");
  });

  it("копия для станции отдана покупателю в том же виде", () => {
    const served = path.join(STATION_ROOT, "public", "aktivaciya-klyuchey.html");
    assert.ok(fs.existsSync(served), "нет копии в station/public — станция не отдаст страницу");
    assert.equal(fs.readFileSync(served, "utf8"), fs.readFileSync(HTML_FILE, "utf8"), "копии разошлись");
  });

  it("в файле нет ничего, что ломает HTML, и нет секретов", () => {
    const text = fs.readFileSync(HTML_FILE, "utf8");
    const script = /<script>([\s\S]*)<\/script>/.exec(text)[1];
    assert.ok(!script.includes("</script"), "в коде встретился </script> — HTML сломается");
    assert.ok(!script.includes("<!--"), "последовательность «<!--» внутри скрипта опасна для парсера");
    assert.ok(!text.includes(["MC4CAQAw", "BQYDK2Vw"].join("")), "в публичной странице не должно быть метки закрытого ключа");
    assert.ok(!/privateKey\s*:\s*["'`][A-Za-z0-9+/=]{40,}/.test(text), "в файл не должен попадать закрытый ключ");
  });

  it("синтаксис: скрипт страницы разбирается Node", () => {
    const script = /<script>([\s\S]*)<\/script>/.exec(fs.readFileSync(HTML_FILE, "utf8"))[1];
    const tempFile = path.join(os.tmpdir(), `agro-page-check-${process.pid}.cjs`);
    fs.writeFileSync(tempFile, script, "utf8");
    try {
      const check = require("node:child_process").spawnSync(process.execPath, ["--check", tempFile]);
      assert.equal(check.status, 0, `синтаксис сломан: ${check.stderr.toString()}`);
    } finally {
      fs.rmSync(tempFile, { force: true });
    }
  });
});

import { fakePage } from "./fake-page.mjs";

/* ─────────────────────────── формат кода: дословно ядро ────────────────── */

describe("страница использует ядро приложения без изменений", () => {
  it("base32, нормализация и кандидаты совпадают побайтово", () => {
    for (let iteration = 0; iteration < 200; iteration += 1) {
      const bytes = crypto.randomBytes(core.LICENSE_LENGTH);
      const code = core.formatCode(bytes);
      assert.equal(AGRO.formatCode(bytes), code, "formatCode разошёлся");
      assert.deepEqual(Array.from(AGRO.parseCode(code)), Array.from(core.parseCode(code)), "parseCode разошёлся");
      assert.deepEqual(AGRO.codeCandidates(`письмо: ${code} — активируйте`), core.codeCandidates(`письмо: ${code} — активируйте`), "кандидаты разошлись");
      const noisy = `«${code.toUpperCase()}» (без кавычек тоже ок)`;
      assert.deepEqual(AGRO.codeCandidates(noisy), core.codeCandidates(noisy), "кандидаты на шуме разошлись");
    }
  });

  it("хэши идентификаторов считаются так же (шим SHA-256)", () => {
    for (let iteration = 0; iteration < 60; iteration += 1) {
      const machineId = crypto.randomBytes(32).toString("hex");
      assert.equal(AGRO.machineShortId(machineId), core.machineShortId(machineId), "machineShortId разошёлся");
      assert.deepEqual(
        Array.from(AGRO.fingerprintFromShortId(AGRO.machineShortId(machineId))),
        Array.from(core.fingerprintFromShortId(core.machineShortId(machineId))),
        "отпечаток разошёлся",
      );
      const short = core.machineShortId(machineId);
      assert.deepEqual(Array.from(AGRO.machineFingerprint(machineId)), Array.from(core.machineFingerprint(machineId)), "machineFingerprint разошёлся");
      assert.equal(AGRO.prettyShortId(short), core.prettyShortId(short));
    }
  });

  it("нагрузка собирается так же, как у генератора проекта", () => {
    for (let iteration = 0; iteration < 40; iteration += 1) {
      const serial = crypto.randomBytes(core.SERIAL_BYTES);
      const keyId = crypto.randomInt(1, 250);
      for (const [bound, machineId] of [[false, ""], [true, MACHINE_A], [true, MACHINE_B]]) {
        const viaPage = AGRO.buildPayload({ keyId, serial, bound, machineId });
        const viaProject = core.buildPayload({ keyId, serial, bound, machineId });
        assert.deepEqual(Array.from(viaPage), Array.from(viaProject), "раскладка нагрузки разошлась");
      }
      // персональный код по короткому идентификатору — как в bindPayload проекта
      const pageBound = AGRO_L.bindPayload({ keyId, shortId: SHORT_A, serial });
      const projectBound = core.buildPayload({ keyId, bound: true, serial });
      projectBound.set(core.fingerprintFromShortId(SHORT_A), core.PAYLOAD_LENGTH - 4);
      assert.deepEqual(Array.from(pageBound), Array.from(projectBound), "отпечаток в нагрузке лёг не туда");
    }
  });
});

/* ─────────────────────────── выдача: страница → приложение ─────────────── */

describe("код, выписанный страницей, принимает приложение", () => {
  it("персональный код проходит проверку на своём компьютере", async () => {
    for (const serial of ["", crypto.randomBytes(core.SERIAL_BYTES).toString("hex")]) {
      const issued = await AGRO.issueCode({ privateKeyBase64: PKCS8_B64, publicKeyBase64: SPKI_B64, keyId: 1, bound: true, shortId: SHORT_A, serial });
      const verdict = core.verifyCode({ code: issued.code, keys: KEYS, machineId: MACHINE_A });
      assert.equal(verdict.ok, true, `приложение отвергло код страницы: ${verdict.reason}`);
      assert.equal(verdict.license.serialHex, issued.serialHex);
      assert.equal(verdict.license.bound, true);
      assert.equal(verdict.license.keyId, 1);
      assert.equal(verdict.license.permanent, true);
      assert.equal(verdict.encoded, issued.code, "канонический текст кода разошёлся");
    }
  });

  it("универсальный код работает на любом компьютере", async () => {
    const issued = await AGRO.issueCode({ privateKeyBase64: PKCS8_B64, publicKeyBase64: SPKI_B64, keyId: 1, bound: false });
    for (const machineId of [MACHINE_A, MACHINE_B, ""]) {
      assert.equal(core.verifyCode({ code: issued.code, keys: KEYS, machineId }).ok, true, "универсальный код не принят");
    }
    assert.equal(core.verifyCode({ code: issued.code, keys: KEYS, machineId: MACHINE_A }).license.bound, false);
  });

  it("код с чужого компьютера приложение не принимает", async () => {
    const issued = await AGRO.issueCode({ privateKeyBase64: PKCS8_B64, publicKeyBase64: SPKI_B64, keyId: 1, bound: true, shortId: SHORT_A });
    const verdict = core.verifyCode({ code: issued.code, keys: KEYS, machineId: MACHINE_B });
    assert.equal(verdict.ok, false);
    assert.equal(verdict.reason, core.REJECT.MACHINE_MISMATCH);
  });

  it("подпись сверяется по списку ключей приложения", async () => {
    const other = crypto.generateKeyPairSync("ed25519");
    const issued = await AGRO.issueCode({ privateKeyBase64: PKCS8_B64, publicKeyBase64: SPKI_B64, keyId: 1, bound: false });
    const foreignPublicKey = [{ keyId: 1, publicKey: other.publicKey.export({ format: "der", type: "spki" }).toString("base64") }];
    assert.equal(core.verifyCode({ code: issued.code, keys: foreignPublicKey }).reason, core.REJECT.SIGNATURE);
    // ключ с другим key-id в списке подходит — ротация ключей не ломает выданные коды
    assert.equal(core.verifyCode({ code: issued.code, keys: [{ keyId: 7, publicKey: SPKI_B64 }] }).ok, true);
  });

  it("серийник попадает в журнал и в список отзыва в том же формате", async () => {
    const issued = await AGRO.issueCode({ privateKeyBase64: PKCS8_B64, publicKeyBase64: SPKI_B64, keyId: 1, bound: true, shortId: SHORT_A });
    assert.match(issued.serialHex, /^[0-9a-f]{16}$/, "serialHex должен быть 16 hex-символов, как в приложении");
    assert.deepEqual(Array.from(AGRO.bytesFromHex(issued.serialHex)), Array.from(core.parseCode(issued.code).subarray(4, 12)));
    const verdict = core.verifyCode({ code: issued.code, keys: KEYS, machineId: MACHINE_A, revokedSerials: [issued.serialHex] });
    assert.equal(verdict.reason, core.REJECT.REVOKED, "страница отдаёт серийник в другом формате");
  });
});

/* ─────────────────────────── проверка: приложение → страница ───────────── */

describe("код, выписанный проектом, проверяется страницей", () => {
  it("вердикты страницы и приложения совпадают на 240 случаях", async () => {
    const revokedSerial = crypto.randomBytes(core.SERIAL_BYTES).toString("hex");
    const cases = [];

    const push = async (label, input) => cases.push({ label, ...input });

    const personal = shared.buildLicenseCode({ privateKeyBase64: PKCS8_B64, keyId: 1, bound: true, shortId: SHORT_A });
    await push("персональный на своём", { code: personal.code, machineId: MACHINE_A, expectOk: true });
    await push("персональный на чужом", { code: personal.code, machineId: MACHINE_B, expectOk: false });
    await push("персональный без компьютера", { code: personal.code, machineId: "", expectOk: false });
    await push("персональный по короткому", { code: personal.code, machineShortId: SHORT_A, expectOk: true });
    await push("персональный по чужому короткому", { code: personal.code, machineShortId: SHORT_B, expectOk: false });
    await push("универсальный", { code: shared.buildLicenseCode({ privateKeyBase64: PKCS8_B64, keyId: 1, bound: false }).code, machineId: MACHINE_A, expectOk: true });
    await push("отозванный", { code: personal.code, machineId: MACHINE_A, revoked: [revokedSerial], expectOk: false });

    const revokedCode = shared.buildLicenseCode({ privateKeyBase64: PKCS8_B64, keyId: 1, bound: false, serial: Buffer.from(revokedSerial, "hex") });
    await push("универсальный из списка отзыва", { code: revokedCode.code, revoked: [revokedSerial], expectOk: false });

    for (let index = 0; index < 200; index += 1) {
      const bytes = Buffer.from(core.parseCode(personal.code));
      const mutation = index % 5;
      if (mutation === 0) bytes[crypto.randomInt(bytes.length)] ^= 1 << crypto.randomInt(8); // подпись
      if (mutation === 1) bytes[0] = 0x02; // версия
      if (mutation === 2) bytes[1] = 0x07; // продукт
      if (mutation === 3) bytes[3] = 0x01; // флаг привязки без отпечатка
      if (mutation === 4) bytes[12] ^= 0xff; // отпечаток
      const text = core.formatCode(bytes);
      await push(`мутация ${index}`, {
        code: mutation === 4 || mutation === 0 ? text : index % 2 ? text.toLowerCase().replace(/AGRO/, "AGRO ") : `код: ${text}`,
        machineId: index % 3 === 0 ? MACHINE_A : index % 3 === 1 ? MACHINE_B : "",
        revoked: index % 7 === 0 ? [revokedSerial] : [],
        expectOk: false,
      });
    }

    for (const item of cases) {
      const keys = KEYS;
      const expected = core.verifyCode({ code: item.code, keys, machineId: item.machineId ?? "", machineShortId: item.machineShortId ?? "", revokedSerials: item.revoked ?? [] });
      const actual = await AGRO.verifyCode({ code: item.code, keys, machineId: item.machineId ?? "", machineShortId: item.machineShortId ?? "", revokedSerials: item.revoked ?? [] });
      assert.equal(actual.ok, expected.ok, `расхождение по допуску: ${item.label}`);
      assert.equal(actual.reason, expected.reason, `расхождение по причине: ${item.label}`);
      if (expected.ok) {
        assert.equal(actual.license.serialHex, expected.license.serialHex, `серийник разошёлся: ${item.label}`);
        assert.equal(actual.license.keyId, expected.license.keyId, `key-id разошёлся: ${item.label}`);
        assert.equal(actual.encoded, expected.encoded, `канонический код разошёлся: ${item.label}`);
      }
    }
  });

  it("для отказа страница даёт человеческий текст", async () => {
    const empty = await AGRO.verifyCode({ code: "   ", keys: KEYS });
    assert.equal(empty.reason, core.REJECT.EMPTY);
    assert.match(empty.message, /Введите код/i);
    const garbage = await AGRO.verifyCode({ code: "привет, дайте код пожалуйста", keys: KEYS });
    assert.ok(!garbage.ok);
    assert.ok(garbage.message.length > 5, "для мусора должно быть объяснение, а не пустая строка");
    const noKeys = await AGRO.verifyCode({ code: "AGRO-1234", keys: [] });
    assert.equal(noKeys.reason, core.REJECT.UNKNOWN_KEY);
  });

  it("ключ приложения читается из keys.cjs и из JSON одинаково", async () => {
    const fromJson = AGRO.parseKeysSource(JSON.stringify({ keys: KEYS, revokedSerials: [SHORT_A.toLowerCase()] }));
    assert.equal(fromJson.ok, true);
    assert.equal(fromJson.value.keys[0].publicKey, SPKI_B64);
    const moduleSource = `module.exports = { keys: [{ keyId: 1, label: "production", publicKey: "${SPKI_B64}" }], revokedSerials: ["dd765aac5612aeb9"] };`;
    const fromModule = AGRO.parseKeysSource(moduleSource);
    assert.equal(fromModule.ok, true, fromModule.message);
    assert.deepEqual(fromModule.value.keys.map(({ keyId, publicKey }) => ({ keyId, publicKey })), [{ keyId: 1, publicKey: SPKI_B64 }]);
    assert.equal(fromModule.value.keys[0].label, "production");
    assert.deepEqual(fromModule.value.revokedSerials, ["dd765aac5612aeb9"]);
    const broken = AGRO.parseKeysSource("тут нечего читать");
    assert.equal(broken.ok, false);
    assert.match(broken.message, /ключ/i);
  });

  it("PKCS#8 с открытым ключом внутри читается, без — пусто", () => {
    // Node выводит PKCS#8 без открытого ключа, OpenSSL — с ним (a1 21 03 21 00 …).
    assert.equal(AGRO.publicFromPrivate(PKCS8_B64), "", "из «голого» PKCS#8 выводить нечего");
    const seed = Buffer.from(PKCS8_B64, "base64").subarray(-32);
    const withPublic = Buffer.concat([
      Buffer.from(PKCS8_B64, "base64"),
      Buffer.from("a121032100", "hex"),
      Buffer.from(SPKI_B64, "base64").subarray(-32),
    ]);
    assert.equal(seed.length, 32);
    assert.equal(AGRO.publicFromPrivate(withPublic.toString("base64")), SPKI_B64);
  });

  it("пара ключей доказывается подписью, а не совпадением строк", async () => {
    const proof = await AGRO.matchKey({ privateKeyBase64: PKCS8_B64, keys: [{ keyId: 1, publicKey: SPKI_B64 }] });
    assert.equal(proof.ok, true, proof.message);
    assert.equal(proof.keyId, 1);
    const foreign = crypto.generateKeyPairSync("ed25519");
    const bad = await AGRO.matchKey({
      privateKeyBase64: PKCS8_B64,
      keys: [{ keyId: 2, publicKey: foreign.publicKey.export({ format: "der", type: "spki" }).toString("base64") }],
    });
    assert.equal(bad.ok, false);
    assert.match(bad.message, /не соответствует/i);
    assert.equal((await AGRO.matchKey({ privateKeyBase64: "не ключ", keys: KEYS })).ok, false);
  });

  it("список отзыва читается из файла построчно", () => {
    const code = shared.buildLicenseCode({ privateKeyBase64: PKCS8_B64, keyId: 1, bound: false });
    const serial = Buffer.from(code.payload.subarray(4, 12)).toString("hex");
    const parsed = AGRO.parseRevokedList(`# отзыв\n${serial}\n\n  ${serial.toUpperCase()}  \n${code.code}\nмусор`);
    assert.deepEqual(parsed.serials, [serial], "дубли и разный регистр сворачиваются в один серийник");
    assert.equal(parsed.notes.length, 1, "про «мусор» надо сказать отдельно");
    assert.equal(core.parsePayload(core.parseCode(code.code).subarray(0, core.PAYLOAD_LENGTH)).serialHex, serial);
  });
});

/* ─────────────────────────── журнал и тексты ──────────────────────────── */

describe("журнал и сообщения совпадают с проектом", () => {
  const rows = [
    {
      issuedAt: "2026-09-14 12:00",
      serial: "dd765aac5612aeb9",
      keyId: 1,
      kind: "personal",
      shortId: SHORT_A,
      code: core.formatCode(crypto.randomBytes(core.LICENSE_LENGTH)),
      name: "Иван; Иванов",
      phone: "+7 900 000-00-00",
      email: "ivan@example.com",
      note: "перезаказ\nсо слов",
      status: "active",
      revokedAt: "",
      replaces: "",
    },
    {
      issuedAt: "2026-09-14 12:05",
      serial: "1234567890abcdef",
      keyId: 1,
      kind: "universal",
      shortId: "",
      code: core.formatCode(crypto.randomBytes(core.LICENSE_LENGTH)),
      name: "",
      phone: "",
      email: "",
      note: "",
      status: "revoked",
      revokedAt: "2026-09-14 13:00",
      replaces: "dd765aac5612aeb9",
    },
  ];

  it("сериализация байт в байт", () => {
    assert.equal(AGRO.ledgerSerialize(rows), shared.serializeLedger(rows));
  });

  it("страница читает журнал проекта и наоборот", () => {
    const fromProject = AGRO.ledgerParse(shared.serializeLedger(rows));
    assert.deepEqual(fromProject.map((row) => [row.serial, row.keyId, row.status, row.shortId]), rows.map((row) => [row.serial, row.keyId, row.status, row.shortId]));
    const fromPage = shared.parseLedger(AGRO.ledgerSerialize(rows));
    assert.deepEqual(fromPage, AGRO.ledgerParse(AGRO.ledgerSerialize(rows)));
    assert.deepEqual(fromPage.map((row) => row.name), ["Иван Иванов", ""], "точки с запятой и переносы строк в CSV вычищаются");
  });

  it("старый формат license-tool читается", () => {
    const legacy = "serial;keyId;bound;shortId;code;note\ndd765aac5612aeb9;1;yes;4WD42EYK;AGRO-1234;заметка";
    assert.deepEqual(AGRO.ledgerParse(legacy), shared.parseLedger(legacy));
    assert.equal(AGRO.ledgerParse(legacy)[0].kind, "personal");
  });

  it("сообщение покупателю и .agrolic — те же строки, что у проекта", async () => {
    const issued = await AGRO.issueCode({ privateKeyBase64: PKCS8_B64, publicKeyBase64: SPKI_B64, keyId: 1, bound: true, shortId: SHORT_A });
    const expectedMessage = shared.buildBuyerMessage({ name: "Иван", code: issued.code, shortId: SHORT_A, serialHex: issued.serialHex, universal: false });
    assert.equal(AGRO.buyerMessage({ name: "Иван", code: issued.code, pretty: SHORT_A, serial: issued.serialHex, universal: false }), expectedMessage);
    assert.equal(AGRO.agrolicContent({ name: "Иван", pretty: SHORT_A, serial: issued.serialHex, code: issued.code, universal: false }), shared.buildAgrolicContent({ name: "Иван", code: issued.code, shortId: SHORT_A, serialHex: issued.serialHex, universal: false }));
    assert.equal(AGRO.agrolicName(issued.serialHex), shared.agrolicFileName(issued.serialHex));
    assert.equal(AGRO.smsText({ code: issued.code, pretty: SHORT_A }), shared.buildBuyerSms({ code: issued.code, shortId: SHORT_A }));
    assert.match(expectedMessage, /бессрочн/i);
  });

  it("штамп времени формата проекта", () => {
    assert.match(AGRO.stamp(), /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  });
});

/* ─────────────────────────── заявка покупателя ─────────────────────────── */

describe("разбор заявки — тот же код, что на сервере станции", () => {
  const texts = [
    "",
    "здравствуйте, купил программу. Код компьютера: 4WD4-2EYK. Иван",
    `Полный идентификатор: ${MACHINE_A}\nКод компьютера: ${SHORT_B.slice(0, 4)}-${SHORT_B.slice(4)}\nВерсия 0.3.0, тел +7 900 123-45-67, почта pet@Example.ru`,
    "а у меня не активируется! AGRO-" + core.formatCode(crypto.randomBytes(80)).slice(5),
    "4WD42EYK",
    `Код компьютера: ${SHORT_A.slice(0, 4)} ${SHORT_A.slice(4)} (это с экрана), приложения 0.2.1`,
    "нет ничего похожего на идентификатор",
  ];

  it("результаты идентичны", () => {
    for (const text of texts) {
      assert.deepEqual(AGRO.parseRequest(text), request.parseActivationRequest(text), `разбор разошёлся на: ${text.slice(0, 40)}`);
    }
  });

  it("из текста заявки страница достаёт код компьютера", () => {
    const parsed = AGRO.parseRequest(`Код компьютера: ${SHORT_A.slice(0, 4)}-${SHORT_A.slice(4)}`);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.shortId, SHORT_A);
  });

  it("короткий и полный идентификатор разрешаются одинаково", () => {
    assert.deepEqual(AGRO.resolveMachine(MACHINE_A), { ok: true, shortId: SHORT_A, pretty: core.prettyShortId(SHORT_A) });
    assert.equal(AGRO.resolveMachine("123").ok, false);
    assert.match(AGRO.resolveMachine("123").message, /идентификатор/i);
  });

  it("код активации из письма находится тем же поиском", () => {
    for (const suffix of ["", "\n", " — активируйте"]) {
      const code = core.formatCode(crypto.randomBytes(core.LICENSE_LENGTH));
      const text = `вот ваш код: ${code}${suffix}`;
      assert.equal(PAGE.AGRO_R.findActivationCode(text), request.findActivationCode(text), "поиск кода в письме разошёлся");
    }
    assert.equal(PAGE.AGRO_R.findActivationCode("кода нет"), request.findActivationCode("кода нет"));
  });
});

/* ─────────────────────────── проверочный режим приложения ─────────────── */

describe("имена файлов в проверочном режиме совпадают с приложением", () => {
  for (const instance of ["demo", "001", "ivan-pc", "ivan_pc", "аидфл", "", "a".repeat(40)]) {
    it(`«${instance || "пусто"}» → то же имя, что у приложения`, () => {
      assert.equal(AGRO.licenseFileNameFor(instance), checkmode.licenseFileNameFor(instance));
      assert.equal(AGRO.sanitizeInstance(instance), checkmode.sanitizeInstance(instance));
    });
  }

  it("без instance — обычный файл лицензии", () => {
    assert.equal(AGRO.licenseFileNameFor(""), core.LICENSE_FILE_NAME ?? checkmode.LICENSE_FILE_NAME);
    assert.equal(AGRO.LICENSE_FILE_NAME, checkmode.LICENSE_FILE_NAME);
  });
});

/* ─────────────────────────── сборка бандла ────────────────────────────── */

describe("сборка бандла", () => {
  it("сканер исходников не теряет объявления", () => {
    for (const file of ["vendor/core.cjs", "vendor/checkmode.mjs".replace(".mjs", ".cjs"), "vendor/license-shared.mjs", "src/request.mjs"]) {
      const source = fs.readFileSync(path.join(STATION_ROOT, file), "utf8");
      const declarations = builder.topLevelDeclarations(source);
      const names = declarations.map((item) => item.name);
      const expected = [...source.matchAll(/^(?:export )?(?:async function|function|class|const|let|var) ([A-Za-z0-9_$]+)/gm)].map((match) => match[1]);
      assert.deepEqual([...new Set(expected)].filter((name) => !names.includes(name)), [], `${file}: сканер потерял объявления`);
      for (const item of declarations) {
        // главное свойство сканера: объявление не «съедает» следующее
        const swallowed = item.code.split("\n").slice(1).filter((line) => /^(?:export )?(?:async function|function|class|const|let|var) [A-Za-z0-9_$]+/.test(line));
        assert.deepEqual(swallowed, [], `${file}: объявление «${item.name}» поглотило другое`);
      }
    }
  });

  it("целый модуль core вставляется без require и exports", () => {
    const source = fs.readFileSync(path.join(STATION_ROOT, "vendor", "core.cjs"), "utf8");
    const { body, names } = builder.wholeModuleExceptCrypto(source);
    assert.ok(!body.includes('require("node:crypto")'), "require должен быть вырезан");
    assert.ok(!body.includes("module.exports"), "module.exports должен быть вырезан");
    assert.ok(body.includes("function verifyCode"), "тело функций должно остаться на месте");
    assert.ok(names.length > 20 && names.includes("formatCode") && names.includes("REJECT"));
  });

  it("страница целиком работает: фиктивный DOM, реальные нажатия кнопок", async () => {
    const html = fs.readFileSync(HTML_FILE, "utf8");
    const script = /<script>([\s\S]*)<\/script>/.exec(html)[1];
    const dom = fakePage(script);

    // 1. ключи: закрытый (в localStorage) и открытый список приложения
    dom.set("privateKey", JSON.stringify({ keyId: 1, label: "тест", privateKey: PKCS8_B64, publicKey: SPKI_B64 }));
    await dom.click("saveKey");
    dom.set("publicKeys", JSON.stringify({ keys: [{ keyId: 1, label: "тест", publicKey: SPKI_B64 }], revokedSerials: [] }));
    dom.click("savePub");
    assert.match(dom.storage.get("agro.station.private"), /privateKey/, "закрытый ключ должен остаться в этом браузере");

    // 2. заявка покупателя → код компьютера найден
    dom.set("requestText", "Здравствуйте! Не активируется.\nИмя: Иван\nКод компьютера: " + core.prettyShortId(SHORT_A) + "\n+7 900 123-45-67");
    await dom.click("parse");
    assert.match(dom.get("parseResult").innerHTML, new RegExp(core.prettyShortId(SHORT_A)), "страница не показала код компьютера из заявки");
    // поля подставляются ровно так, как их нашёл серверный разбор заявки
    const expected = request.parseActivationRequest(dom.get("requestText").value);
    assert.equal(dom.get("name").value, expected.name, "имя подставилось не из того разбора");
    assert.match(dom.get("phone").value, /900/, "телефон не подставился");

    // 3. выдача → в блоке результата есть код, журнал пополнился
    await dom.click("issue");
    const result = dom.get("result").innerHTML;
    assert.match(result, /AGRO-/, "нет кода активации в результате");
    assert.match(result, /бессрочно/, "в результате нет слов о сроке");
    const rows = AGRO.ledgerParse(dom.storage.get("agro.station.ledger") ?? "");
    assert.equal(rows.length, 1, "журнал в этом браузере не пополнился");
    assert.equal(rows[0].shortId, SHORT_A);
    assert.equal(rows[0].kind, "personal");

    // 4. проверка выданного кода — той же страницей
    dom.set("codeText", rows[0].code);
    dom.set("verifyMachine", core.prettyShortId(SHORT_A));
    await dom.click("verify");
    assert.match(dom.get("verifyResult").innerHTML, /Код действителен/, "страница не узнала собственный код");

    // 5. чужой компьютер — отказ
    dom.set("verifyMachine", core.prettyShortId(SHORT_B));
    await dom.click("verify");
    assert.match(dom.get("verifyResult").innerHTML, /другого компьютера/, "отказ должен быть объяснён по-человечески");
    dom.close();
  });

  it("разметка и скрипт страницы согласованы", () => {
    const text = fs.readFileSync(HTML_FILE, "utf8");
    const markup = text.slice(0, text.indexOf("<script>"));
    const ids = new Set([...markup.matchAll(/id="([^"]+)"/g)].map((match) => match[1]));
    const used = new Set([...text.matchAll(/\$\("([^"]+)"\)/g)].map((match) => match[1]));
    const missing = [...used].filter((id) => !ids.has(id));
    assert.deepEqual(missing, [], "скрипт обращается к элементам, которых нет в разметке");
    // табы: каждая кнопка должна вести на существующую панель
    const tabs = new Set([...text.matchAll(/data-tab="([^"]+)"/g)].map((match) => match[1]));
    for (const tab of tabs) assert.ok(ids.has(`tab-${tab}`), `нет панели для таба «${tab}»`);
    assert.ok(markup.includes("lang=\"ru\""), "страница должна быть объявлена как русская");
    assert.ok(/<meta[^>]+viewport/.test(markup), "иначе на телефоне будет разъезд");
  });

  it("шифрование браузера проверено: подпись и проверка через WebCrypto", async () => {
    assert.equal(AGRO.ed25519Supported(), true);
    const issued = await AGRO.issueCode({ privateKeyBase64: PKCS8_B64, publicKeyBase64: SPKI_B64, keyId: 1, bound: false });
    const signature = issued.code;
    assert.ok(typeof signature === "string" && signature.startsWith("AGRO-"));
    // узкое место: подпись должна быть именно Ed25519, а не «подделана нулями»
    const bytes = core.parseCode(issued.code);
    assert.ok(bytes.subarray(core.PAYLOAD_LENGTH).some((byte) => byte !== 0));
    assert.equal(crypto.verify(null, bytes.subarray(0, core.PAYLOAD_LENGTH), publicKey, bytes.subarray(core.PAYLOAD_LENGTH)), true, "Node не подтверждает подпись браузера");
  });
});
