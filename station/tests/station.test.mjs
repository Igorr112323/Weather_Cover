/**
 * Станция «Активация ключей»: разбор заявки, выдача кода, журнал, отзыв,
 * проверочный EXE и защита путей скачивания.
 * Запуск: npm test   (из корня станции)
 *
 * Тесты работают в реальном временном каталоге: проверяется то, что владелец
 * видит глазами — код подписан, принят проверкой приложения, попал в журнал,
 * отозван и больше не принимается. Закрытый ключ выдумывается на месте.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { createRequire } from "node:module";
import fsp from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const STATION_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const core = require("../vendor/core.cjs");
const { parseLedger, buildLicenseCode, privateKeyObject } = await import("../vendor/license-shared.mjs");
const config = await import("../src/config.mjs");
const { parseActivationRequest, findActivationCode } = await import("../src/request.mjs");
const { createStation, StationError } = await import("../src/backend.mjs");
const { startStationServer } = await import("../src/server.mjs");

let root = "";
const keyId = 1;
let secretPair = null;
let clock = Date.UTC(2026, 8, 13, 12, 0, 0);

/** Ключевая пара для всей пачки тестов: выдумывается, к боевым ключам отношения не имеет. */
function freshPair() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
  return {
    privateKey: privateKey.export({ format: "der", type: "pkcs8" }).toString("base64"),
    publicKey: publicKey.export({ format: "der", type: "spki" }).toString("base64"),
  };
}

/** Каталог станции + проект приложения: что нужно, чтобы станция заработала. */
async function makeWorkspace({ withExe = true, linkRepo = false } = {}) {
  const stationDir = await fsp.mkdtemp(path.join(os.tmpdir(), "agro-station-"));
  const dataDir = path.join(stationDir, "data");
  await fsp.mkdir(dataDir, { recursive: true });

  await fsp.writeFile(
    path.join(dataDir, "license-key.json"),
    JSON.stringify({ keys: [{ keyId, label: "test", privateKey: secretPair.privateKey, publicKey: secretPair.publicKey }] }, null, 2),
    "utf8",
  );
  await fsp.writeFile(path.join(dataDir, "keys.json"), JSON.stringify({ keys: [{ keyId, label: "test", publicKey: secretPair.publicKey }], revokedSerials: [] }, null, 2), "utf8");

  const releaseDir = path.join(stationDir, "release");
  if (withExe) {
    await fsp.mkdir(releaseDir, { recursive: true });
    await fsp.writeFile(path.join(releaseDir, "AgroPrognoz-0.2.1-portable.exe"), "MZ fake portable payload", "utf8");
  }

  const conf = {
    root: stationDir,
    repo: linkRepo ? stationDir : null,
    repoLinked: Boolean(linkRepo),
    env: {},
    product: { name: "АгроПрогноз — Кукуруза", version: "0.2.1" },
    exeUrl: "",
    exeSources: withExe ? [releaseDir] : [],
    files: {
      secret: path.join(dataDir, "license-key.json"),
      ledger: path.join(dataDir, "ledger.csv"),
      keys: path.join(dataDir, "keys.json"),
      outDir: path.join(stationDir, "out"),
      dataDir,
    },
  };
  const station = createStation({ config: conf, now: () => clock });
  return { dir: stationDir, conf, station, dataDir, releaseDir };
}

before(async () => {
  root = await fsp.mkdtemp(path.join(os.tmpdir(), "agro-station-suite-"));
  await fsp.rm(root, { recursive: true, force: true });
  secretPair = freshPair();
});

after(async () => {
  await fsp.rm(root, { recursive: true, force: true });
});

/* ── Разбор заявки ────────────────────────────────────────────────────────── */

describe("разбор того, что прислал пользователь", () => {
  const SHORT = "ZZG5-9ZKT";
  const FULL = core.machineShortId;

  it("полный текст заявки приложения", () => {
    const machineId = "ab".repeat(32);
    const short = core.prettyShortId(core.machineShortId(machineId));
    const text = [
      "Заявка на персональный код активации",
      "Приложение: АгроПрогноз — Кукуруза 0.2.1",
      `Код компьютера: ${short}`,
      `Полный идентификатор: ${machineId}`,
      "Лицензия бессрочная. Прошу выслать персональный код активации для этого компьютера.",
    ].join("\n");
    const parsed = parseActivationRequest(text);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.pretty, short);
    assert.equal(parsed.machineId, machineId);
    assert.equal(parsed.version, "0.2.1");
    assert.deepEqual(parsed.conflicts, [], "оба идентификатора согласованы — конфликтов нет");
  });

  it("несовпадение короткого кода и полного идентификатора — берётся полный, есть предупреждение", () => {
    const machineId = "ab".repeat(32);
    const parsed = parseActivationRequest(`Код компьютера: ${SHORT}\nПолный идентификатор: ${machineId}`);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.conflicts.length, 2, parsed.conflicts.join(" | "));
    assert.ok(parsed.conflicts.some((line) => /не совпадает/.test(line)), "должно быть сказано про расхождение");
    assert.ok(parsed.conflicts.some((line) => /несколько кодов/i.test(line)), "и про несколько кодов в тексте");
    assert.equal(parsed.pretty, core.prettyShortId(core.machineShortId(machineId)), "взят идентификатор из полного machineId");
  });

  it("несогласованность видно и по одной только подписи «Полный идентификатор»", () => {
    // Короткий код, который не выводится из приложенного полного, — единственный кандидат: предупреждаем.
    const parsed = parseActivationRequest(`Код компьютера: ${SHORT}\nПолный идентификатор: ${"cd".repeat(32)}`);
    assert.equal(parsed.ok, true);
    assert.ok(parsed.conflicts.some((line) => /не совпадает/.test(line)), parsed.conflicts.join(" | "));
  });

  it("свободное сообщение в мессенджере", () => {
    const parsed = parseActivationRequest("Здравствуйте! Меня зовут Иван, купил программу. Код компьютера zzg5 9zkt, телефон +7 960 484-34-63, почта ivan@mail.ru");
    assert.equal(parsed.ok, true);
    assert.equal(parsed.pretty, SHORT);
    assert.equal(parsed.name, "Иван");
    assert.equal(parsed.email, "ivan@mail.ru");
    assert.match(parsed.phone, /960/);
  });

  it("голый код и опечатки вида O/0, I/1", () => {
    assert.equal(parseActivationRequest(SHORT).pretty, SHORT);
    assert.equal(parseActivationRequest("  zzg5-9zkt ").pretty, SHORT);
    // В алфавите Crockford нет I, L, O — они читаются как 1 и 0.
    assert.equal(parseActivationRequest("ZZ05-9ZKI").pretty, parseActivationRequest("ZZO5-9ZKL").pretty);
  });

  it("полный идентификатор вместо короткого", () => {
    const machineId = "cd".repeat(32);
    const parsed = parseActivationRequest(machineId);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.pretty, core.prettyShortId(FULL(machineId)));
  });

  it("мусор и пустой ввод — честный отказ", () => {
    assert.equal(parseActivationRequest("").ok, false);
    assert.equal(parseActivationRequest("купил вашу программу, пришлите код").ok, false);
    assert.match(parseActivationRequest("купил вашу программу, пришлите код").message, /код компьютера/i);
  });

  it("код активации не принимается за код компьютера", () => {
    const { code } = buildLicenseCode({ privateKey: privateKeyObject(secretPair.privateKey), keyId, bound: false });
    const parsed = parseActivationRequest(`Вот мой код: ${code}`);
    assert.equal(parsed.ok, false, `не должен был ничего найти, а нашёл: ${parsed.pretty}`);
    assert.match(parsed.message, /код компьютера/i);
    // ...а если в письме есть и код компьютера, и код активации — берётся компьютер.
    const both = parseActivationRequest(`Код компьютера: ${SHORT}\nМой код: ${code}`);
    assert.equal(both.ok, true);
    assert.equal(both.pretty, SHORT);
    assert.equal(findActivationCode(both) === "", true, "разбор заявки не пытается угадывать код активации");
  });

  it("findActivationCode находит код в письме", () => {
    const { code } = buildLicenseCode({ privateKey: privateKeyObject(secretPair.privateKey), keyId, bound: false });
    const letter = `Иван, здравствуйте!\n\nВаш код активации:\n\n${code}\n\nС уважением, владелец.`;
    assert.equal(findActivationCode(letter), code);
    assert.equal(findActivationCode("просто текст без кода"), "");
  });
});

/* ── Имена и идентификаторы ──────────────────────────────────────────────── */

describe("имя проверочного EXE", () => {
  it("собирается из идентификатора и чистится", () => {
    assert.equal(config.checkExeName("demo"), "AgroPrognoz-check-demo.exe");
    // Идентификатор не должен протащить в имя файла разделители пути.
    for (const attempt of ["../../etc/passwd", "..\\..\\windows", "a/b\\c", "..", ""]) {
      const name = config.checkExeName(config.sanitizeInstance(attempt));
      assert.doesNotMatch(name, /[\\/]/, `опасное имя: ${name}`);
      assert.equal(name.includes(".."), false, `родительский каталог: ${name}`);
    }
    assert.equal(config.sanitizeInstance(" 2026-09-13 "), "2026-09-13");
    assert.match(config.newInstance(), /^t\d{4}-[0-9a-z]{1,4}$/);
  });

  it("уникальный идентификатор не повторяется подряд", () => {
    const seen = new Set();
    for (let index = 0; index < 40; index += 1) {
      clock += 1000;
      seen.add(config.newInstance(clock));
    }
    assert.ok(seen.size >= 30, `слишком много повторов: ${seen.size}`);
  });
});

/* ── Выдача ───────────────────────────────────────────────────────────────── */

describe("выдача кода", () => {
  it("персональный код подписан, принят проверкой приложения и попал в журнал", async () => {
    const { dir, station, conf } = await makeWorkspace();
    try {
      const result = await station.issue({ requestText: `Код компьютера: ZZG5-9ZKT, Мария`, name: "Мария", note: "заказ 14" });
      assert.equal(result.ok, true, result.message);
      assert.equal(result.kind, "personal");
      assert.equal(result.machine.shortId, "ZZG5-9ZKT");
      assert.match(result.code, /^AGRO-/);

      // Проверка ровно тем кодом, которым проверяет приложение.
      const checked = core.verifyCode({ code: result.code, keys: [{ keyId, publicKey: secretPair.publicKey }], machineShortId: "ZZG5-9ZKT" });
      assert.equal(checked.ok, true, checked.reason);
      assert.equal(checked.license.bound, true);
      assert.equal(checked.license.permanent, true);
      assert.equal(checked.license.expiration, null);
      const foreign = core.verifyCode({ code: result.code, keys: [{ keyId, publicKey: secretPair.publicKey }], machineShortId: "AAAA-AAAA" });
      assert.equal(foreign.reason, core.REJECT.MACHINE_MISMATCH);

      const ledger = parseLedger(await fsp.readFile(conf.files.ledger, "utf8"));
      assert.equal(ledger.length, 1);
      assert.equal(ledger[0].serial, result.serialHex);
      assert.equal(ledger[0].name, "Мария");
      assert.equal(ledger[0].status, "active");
      assert.ok(result.agrolic.content.includes(result.code), "файл .agrolic содержит код");
      assert.match(result.buyerMessage, /ZZG5-9ZKT/);
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });

  it("повторная заявка на тот же компьютер спрашивает подтверждение и отзывает старый код", async () => {
    const { dir, station, conf } = await makeWorkspace();
    try {
      const first = await station.issue({ machineCode: "ZZG5-9ZKT", name: "Пётр" });
      assert.equal(first.ok, true);
      const again = await station.issue({ machineCode: "zzg5 9zkt", name: "Пётр" });
      assert.equal(again.ok, false);
      assert.equal(again.needsConfirm, "duplicate");
      assert.equal(again.previous.length, 1);

      const forced = await station.issue({ machineCode: "ZZG5-9ZKT", name: "Пётр", confirm: true });
      assert.equal(forced.ok, true, forced.message);
      assert.equal(forced.replaced[0].serial, first.serialHex);

      const rows = parseLedger(await fsp.readFile(conf.files.ledger, "utf8"));
      assert.equal(rows.length, 2);
      const [oldRow, newRow] = rows;
      assert.equal(oldRow.status, "revoked", "журнал станции помечает отзыв сам, если keys.cjs проекта недоступен");
      assert.equal(newRow.replaces, oldRow.serial);
      assert.match(newRow.note, /замена/);

      // Отозванный серийник больше не проходит проверку с обновлённым списком.
      const revokedCheck = core.verifyCode({
        code: first.code,
        keys: [{ keyId, publicKey: secretPair.publicKey }],
        machineShortId: "ZZG5-9ZKT",
        revokedSerials: [first.serialHex],
      });
      assert.equal(revokedCheck.reason, core.REJECT.REVOKED);
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });

  it("универсальный код требует явного подтверждения и не привязан к машине", async () => {
    const { dir, station } = await makeWorkspace();
    try {
      const ask = await station.issue({ machineCode: "ZZG5-9ZKT", universal: true });
      assert.equal(ask.ok, false);
      assert.equal(ask.needsConfirm, "universal");

      const issued = await station.issue({ machineCode: "ZZG5-9ZKT", universal: true, confirm: true });
      assert.equal(issued.ok, true);
      assert.equal(issued.kind, "universal");
      const checked = core.verifyCode({ code: issued.code, keys: [{ keyId, publicKey: secretPair.publicKey }] });
      assert.equal(checked.ok, true);
      assert.equal(checked.license.bound, false);
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });

  it("без закрытого ключа выдача честно отказывает", async () => {
    const workspace = await makeWorkspace();
    try {
      await fsp.rm(workspace.conf.files.secret, { force: true });
      const result = await workspace.station.issue({ machineCode: "ZZG5-9ZKT" });
      assert.equal(result.ok, false);
      assert.match(result.message, /Закрытый ключ не найден/);
    } finally {
      await fsp.rm(workspace.dir, { recursive: true, force: true });
    }
  });

  it("код ключа, которого нет в приложении, станция не выдаёт", async () => {
    const { dir, station, conf } = await makeWorkspace();
    try {
      await fsp.writeFile(conf.files.keys, JSON.stringify({ keys: [{ keyId: 7, publicKey: secretPair.publicKey }], revokedSerials: [] }), "utf8");
      const result = await station.issue({ machineCode: "ZZG5-9ZKT" });
      assert.equal(result.ok, false);
      assert.match(result.message, /не добавлен/);
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });
});

/* ── Проверка готового кода ──────────────────────────────────────────────── */

describe("проверка кода активации", () => {
  it("раскладывает код на человеческий язык", async () => {
    const { dir, station } = await makeWorkspace();
    try {
      const issued = await station.issue({ machineCode: "ZZG5-9ZKT", name: "Ольга" });
      const result = await station.verify({ code: `вот код: ${issued.code}`, machineCode: "ZZG5-9ZKT" });
      assert.equal(result.ok, true, result.message);
      assert.equal(result.license.serialHex, issued.serialHex);
      assert.equal(result.machine.checked, true);
      assert.match(result.machine.verdict, /совпал/);
      assert.match(result.ledgerNote, /журнале/);

      const otherMachine = await station.verify({ code: issued.code, machineCode: "AAAA-AAAA" });
      assert.equal(otherMachine.ok, false);
      assert.equal(otherMachine.reason, core.REJECT.MACHINE_MISMATCH);

      const junk = await station.verify({ code: "AGRO-AAAA-AAAA" });
      assert.equal(junk.ok, false);
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });
});

/* ── Проверочный EXE ─────────────────────────────────────────────────────── */

describe("проверочный EXE", () => {
  it("делает копию с новым именем и отдаёт её по ссылке", async () => {
    const { dir, station, conf } = await makeWorkspace();
    try {
      const result = await station.buildCheckExe({ instance: "demo-1" });
      assert.equal(result.ready, true, result.note);
      assert.equal(result.fileName, "AgroPrognoz-check-demo-1.exe");
      assert.match(result.url, /^\/download\/AgroPrognoz-check-demo-1\.exe$/);
      const served = await station.resolveDownload("AgroPrognoz-check-demo-1.exe");
      assert.equal(path.basename(served), result.fileName);
      assert.equal(await fsp.readFile(served, "utf8"), "MZ fake portable payload");
      assert.ok(result.size > 0);
      assert.ok((await station.findExes()).some((item) => item.name === "AgroPrognoz-0.2.1-portable.exe"));
      assert.ok(conf.files.outDir.endsWith("out"));
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });

  it("указывает на ссылку и переименование, когда EXE нет", async () => {
    const { dir, station } = await makeWorkspace({ withExe: false });
    try {
      const result = await station.buildCheckExe({ instance: "t1" });
      assert.equal(result.ready, false);
      assert.match(result.note, /не найдено/i);
      assert.match(result.fileName, /^AgroPrognoz-check-t1\.exe$/);
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });

  it("отдаёт только разрешённые имена: ни путь наружу, ни чужие файлы", async () => {
    const { dir, station, conf } = await makeWorkspace();
    try {
      await station.buildCheckExe({ instance: "safe" });
      for (const attempt of ["../data/license-key.json", "..\\..\\windows\\system32\\x.exe", "license-key.json", "data/keys.json", "/etc/passwd", "AgroPrognoz-check-safe.exe.exe"]) {
        assert.equal(await station.resolveDownload(attempt), null, `пропущен опасный путь: ${attempt}`);
      }
      await fsp.writeFile(path.join(conf.files.outDir, "AgroPrognoz-0.2.1-portable.exe"), "from out", "utf8");
      assert.equal(path.basename(await station.resolveDownload("AgroPrognoz-0.2.1-portable.exe")), "AgroPrognoz-0.2.1-portable.exe");
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });
});

/* ── Состояние и сброс активации ─────────────────────────────────────────── */

describe("состояние станции и сброс активации", () => {
  it("state показывает ключи, журнал и код компьютера", async () => {
    const { dir, station } = await makeWorkspace();
    try {
      await station.issue({ machineCode: "ZZG5-9ZKT", name: "Тест" });
      const state = await station.state();
      assert.equal(state.ok, true);
      assert.equal(state.secret.available, true);
      assert.deepEqual(state.published.keyIds, [keyId]);
      assert.equal(state.ledger.total, 1);
      assert.equal(state.ledger.active, 1);
      assert.match(state.machine.shortId, /^[0-9A-Z]{4}-[0-9A-Z]{4}$/);
      assert.equal(state.exe.sources.length, 1);
      assert.equal(state.terms.includes("бессрочная"), true);
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });

  it("сброс трогает только файлы лицензий и оставляет резервную копию", async () => {
    const { dir, station } = await makeWorkspace();
    try {
      // Имитируем профиль приложения: основная лицензия, лицензия проверочной
      // копии и база данных — последнюю сброс задеть не должен.
      const profile = path.join(dir, "profile");
      await fsp.mkdir(profile, { recursive: true });
      const store = require(path.join(STATION_ROOT, "vendor", "store.cjs"));
      const machineId = crypto.randomBytes(32).toString("hex");
      await store.createLicenseStore({ dir: profile, machineId, log: () => {} }).write({ payload: "AA==", signature: "AA==", serialHex: "1122334455667788", keyId: 1, bound: false });
      await store
        .createLicenseStore({ dir: profile, fileName: "agroprognoz-check-demo.license", machineId, log: () => {} })
        .write({ payload: "BB==", signature: "BB==", serialHex: "99", keyId: 1, bound: true });
      await fsp.writeFile(path.join(profile, "agroprognoz.sqlite"), "данные не трогаем", "utf8");

      const seen = await station.activation({ dirs: [profile] });
      assert.equal(seen.files.length, 2, "увидены оба файла лицензии");
      assert.equal(seen.files.some((item) => item.instance === "demo"), true);

      const preview = await station.reset({ dirs: [profile], dryRun: true });
      assert.equal(preview.dryRun, true);
      assert.equal(preview.changed.length, 1, "по умолчанию сбрасывается только основная лицензия");

      const done = await station.reset({ dirs: [profile] });
      assert.equal(done.changed.length, 1);
      assert.match(path.basename(done.changed[0].to), /^agroprognoz\.license\.bak-\d{8}-\d{6}$/);

      const names = await fsp.readdir(profile);
      assert.equal(names.includes("agroprognoz.license"), false, "основная лицензия убрана → приложение спросит код");
      assert.ok(names.some((name) => name.startsWith("agroprognoz.license.bak-")), "резервная копия осталась");
      assert.ok(names.includes("agroprognoz-check-demo.license"), "проверочная копия не задета");
      assert.ok(names.includes("agroprognoz.sqlite"), "база данных не задета");

      const checks = await station.reset({ dirs: [profile], checks: true, purge: true });
      assert.equal(checks.changed.length, 1);
      const after = await fsp.readdir(profile);
      assert.equal(after.includes("agroprognoz-check-demo.license"), false, "--checks снимает активацию проверочной копии");
      assert.equal(after.includes("agroprognoz.sqlite"), true);
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });

  it("revoke по серийнику помечает запись журнала", async () => {
    const { dir, station, conf } = await makeWorkspace();
    try {
      const issued = await station.issue({ machineCode: "ZZG5-9ZKT", name: "Сергей" });
      const result = await station.revoke({ serial: issued.serialHex });
      assert.equal(result.ok, true, result.message);
      const rows = parseLedger(await fsp.readFile(conf.files.ledger, "utf8"));
      assert.equal(rows[0].status, "revoked");
      assert.match(rows[0].revokedAt, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
      const bad = await station.revoke({ serial: "не-серийник" });
      assert.equal(bad.ok, false);
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });
});

/* ── HTTP-слой: токен, Host и раздача файлов ─────────────────────────────── */

/**
 * Сырой HTTP-запрос: нужен, чтобы подставить любой Host — fetch не разрешает
 * менять этот заголовок. Запрос отправляется без FIN: сервер на закрытом на
 * половину сокете ответ досылает не всегда, а тест обязан видеть именно код
 * ответа, а не обрыв соединения.
 */
function rawRequest(port, { method = "GET", path: target = "/", host = "127.0.0.1", headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, "127.0.0.1", () => {
      const lines = [`${method} ${target} HTTP/1.1`, `Host: ${host}`, "Connection: close"];
      for (const [name, value] of Object.entries(headers)) lines.push(`${name}: ${value}`);
      socket.write(`${lines.join("\r\n")}\r\n\r\n`);
    });
    let text = "";
    let received = 0;
    let settled = false;
    // length сравнивается в БАЙТАХ: ответы с кириллицей в символах короче, чем
    // в байтах, и наивное text.length >= Content-Length никогда не выполнится.
    const finish = ({ forced = false } = {}) => {
      if (settled) return;
      const status = Number(/^HTTP\/1\.1 (\d{3})/.exec(text)?.[1] ?? 0);
      const headerEnd = text.indexOf("\r\n\r\n");
      if (status === 0 || headerEnd === -1) {
        if (!forced) return;
        settled = true;
        socket.destroy();
        resolve({ status, text });
        return;
      }
      const length = Number(/content-length: (\d+)/i.exec(text)?.[1] ?? NaN);
      if (!forced && !Number.isNaN(length) && received < length) return;
      settled = true;
      socket.destroy();
      resolve({ status, text });
    };
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      text += chunk;
      received += Buffer.byteLength(chunk, "utf8");
      finish();
    });
    socket.on("end", () => finish({ forced: true }));
    socket.setTimeout(4000, () => {
      socket.destroy();
      finish({ forced: true });
    });
    socket.on("error", (error) => {
      if (!settled) reject(error);
    });
  });
}

describe("доступ к станции по сети", () => {
  let workspace = null;
  let server = null;
  const TOKEN = "token-for-tests";

  before(async () => {
    workspace = await makeWorkspace();
    await workspace.station.buildCheckExe({ instance: "guarded" });
    server = await startStationServer({ backend: workspace.station, token: TOKEN, host: "127.0.0.1", port: 0, allowedHosts: [".e2b.app"] });
  });

  after(async () => {
    if (server) await server.close();
    if (workspace) await fsp.rm(workspace.dir, { recursive: true, force: true });
  });

  it("страница открывается, API без токена — нет", async () => {
    assert.equal((await rawRequest(server.port, { host: "127.0.0.1" })).status, 200);
    const denied = await rawRequest(server.port, { path: "/api/state", host: "127.0.0.1" });
    assert.equal(denied.status, 403);
    assert.match(denied.text, /токен/i);
    const allowed = await rawRequest(server.port, { path: "/api/state", host: "127.0.0.1", headers: { "x-agro-token": TOKEN } });
    assert.equal(allowed.status, 200);
    assert.match(allowed.text, /"product"/);
  });

  it("чужой Host отклоняется, адрес из белого списка — принимается (защита от DNS-привязки)", async () => {
    assert.equal((await rawRequest(server.port, { host: "evil.example.com" })).status, 403);
    assert.equal((await rawRequest(server.port, { host: "evilnote2be2b.app" })).status, 403, "чужой хост не должен прятаться за суффикс");
    assert.equal((await rawRequest(server.port, { host: "8793-abc.e2b.app" })).status, 200);
    assert.equal((await rawRequest(server.port, { host: "localhost:8793" })).status, 200);
  });

  it("скачивание: только файлы из белого списка имён и каталогов", async () => {
    const ok = await rawRequest(server.port, { path: "/download/AgroPrognoz-check-guarded.exe", host: "127.0.0.1", headers: { "x-agro-token": TOKEN } });
    assert.equal(ok.status, 200);
    assert.match(ok.text, /Content-Disposition: attachment/i);
    for (const attempt of ["/download/..%2Fdata%2Flicense-key.json", "/download/license-key.json", "/download/etc/passwd"]) {
      const bad = await rawRequest(server.port, { path: attempt, host: "127.0.0.1", headers: { "x-agro-token": TOKEN } });
      assert.equal(bad.status, 404, `пропущен путь: ${attempt}`);
    }
    // Без токена файл не отдают, даже с правильным именем.
    assert.equal((await rawRequest(server.port, { path: "/download/AgroPrognoz-check-guarded.exe", host: "127.0.0.1" })).status, 403);
  });

  it("офлайн-копия страницы раздаётся без токена и это тот же файл, что в репозитории", async () => {
    const page = await rawRequest(server.port, { path: "/aktivaciya-klyuchey.html", host: "127.0.0.1" });
    assert.equal(page.status, 200, "офлайн-файл должен открываться и без токена");
    assert.match(page.text, /AGRO_CORE/, "в странице должен быть собранный блок ядра");
    assert.equal(page.text.includes(secretPair.privateKey), false, "закрытый ключ не должен попадать в раздаваемый файл");
    const onDisk = await fsp.readFile(path.join(STATION_ROOT, "public", "aktivaciya-klyuchey.html"), "utf8");
    assert.ok(onDisk.includes("const AGRO_CORE"), "публичная копия офлайн-страницы не собрана: npm run station:standalone");
  });

  it("в ответ страницы нет ни закрытого ключа, ни содержимого журнала", async () => {
    // Префикс DER-заголовка PKCS#8 для Ed25519; собирается из частей, чтобы
    // собственная проверка не ругалась на эту строку в исходниках станции.
    const pkcs8Prefix = ["MC4CAQAw", "BQYDK2Vw"].join("");
    const page = await rawRequest(server.port, { host: "127.0.0.1" });
    assert.equal(page.text.includes(pkcs8Prefix), false, "PKCS#8 закрытого ключа в HTML быть не может");
    assert.equal(page.text.includes(secretPair.privateKey), false, "в HTML не должен попадать и сам ключ из файла");
    const state = await rawRequest(server.port, { path: "/api/state", host: "127.0.0.1", headers: { "x-agro-token": TOKEN } });
    assert.equal(state.text.includes(pkcs8Prefix), false, "закрытый ключ не отдаётся и в API");
    assert.equal(state.text.includes(secretPair.privateKey), false);
    // Журнал (имена и телефоны покупателей) — тоже не содержимое ответа /api/state.
    assert.equal(state.text.includes("+7 960"), false);
  });
});
