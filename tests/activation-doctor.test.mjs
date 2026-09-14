/**
 * Проверка и сброс активации на своём компьютере: проверочный режим копий,
 * диагностика файла лицензии и полный самопроверочный сценарий.
 * Запуск: npm test
 *
 * Что здесь главное:
 *   • проверочный режим (electron/license/checkmode.cjs) меняет ТОЛЬКО имя
 *     файла лицензии — он не умеет «разрешать» приложение, поэтому обязанность
 *     спрашивать код у новой копии сохраняется, а проверка подписи не ослабевает;
 *   • диагностика (scripts/activation-doctor-lib.mjs) читает конверт теми же
 *     функциями, что и хранилище стража, — не «на глаз», а тем же кодом;
 *   • runActivationSelfTest прогоняет весь сценарий активации на настоящем
 *     страже во временном каталоге: чистая машина → ввод кода → перезапуск →
 *     чужая машина → подмена файла → сброс → отзыв → подделка.
 *
 * Electron и настоящий закрытый ключ не нужны: ключ выдумывается, каталог —
 * временный, файловый слой внедряется параметрами.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { createRequire } from "node:module";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const core = require("../electron/license/core.cjs");
const storeModule = require("../electron/license/store.cjs");
const checkmode = require("../electron/license/checkmode.cjs");
const { createGuard } = require("../electron/license/guard.cjs");

const doctor = await import("../scripts/activation-doctor-lib.mjs");
const { buildLicenseCode, privateKeyObject } = await import("../scripts/license-shared.mjs");

const { createLicenseStore, inspectEnvelope } = storeModule;
const { LICENSE_FILE_NAME, licenseFileNameFor, resolveCheckInstance, sanitizeInstance, instanceFromExePath } = checkmode;

const MACHINE_A = "a".repeat(64);
const MACHINE_B = "b".repeat(64);

/* ── Заготовки ───────────────────────────────────────────────────────────── */

function makeKeyPair(keyId = 1) {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
  return {
    keyId,
    privateKeyBase64: privateKey.export({ format: "der", type: "pkcs8" }).toString("base64"),
    entry: { keyId, label: "test", publicKey: publicKey.export({ format: "der", type: "spki" }).toString("base64") },
  };
}

function issue(pair, input) {
  return buildLicenseCode({ privateKey: privateKeyObject(pair.privateKeyBase64), keyId: pair.keyId, ...input });
}

function guardFor({ machineId, dir, keys, revokedSerials = [], licenseFileName }) {
  return createGuard({
    keyMaterial: { keys, revokedSerials },
    machine: {
      machineId,
      quality: "high",
      source: "test",
      identity: () => ({ machineId, quality: "high", source: "test", platform: "test" }),
    },
    userDataDir: dir,
    appRoot: ROOT,
    safeStorage: {},
    licenseFileName,
    integrity: { enabled: false, verify: async () => ({ ok: true, skipped: true, mismatches: [], checked: 0 }) },
    log: () => {},
  });
}

async function withTempDir(run) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "agro-doctor-"));
  try {
    return await run(dir);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
}

/* ── Проверочный режим ───────────────────────────────────────────────────── */

describe("проверочный режим копий (checkmode)", () => {
  it("ничего не включает по умолчанию", () => {
    const resolved = resolveCheckInstance({ argv: ["AgroPrognoz.exe"], env: {}, execPath: "C:\\app\\AgroPrognoz.exe" });
    assert.deepEqual(resolved, { instance: "", source: null });
    assert.equal(licenseFileNameFor(resolved.instance), "agroprognoz.license");
  });

  it("берёт идентификатор из переключателя", () => {
    assert.equal(resolveCheckInstance({ argv: ["--check-instance=demo-1"], env: {}, execPath: "C:\\a\\AgroPrognoz.exe" }).instance, "demo-1");
    assert.equal(resolveCheckInstance({ argv: ["--check-instance", "demo-2"], env: {}, execPath: "C:\\a\\AgroPrognoz.exe" }).instance, "demo-2");
    assert.equal(resolveCheckInstance({ argv: ["--check"], env: {}, execPath: "C:\\a\\AgroPrognoz.exe" }).instance, checkmode.DEFAULT_INSTANCE);
  });

  describe("где лежит файл лицензии", () => {
    const { licenseDirFor } = checkmode;

    it("portable-сборка держит лицензию рядом с EXE", () => {
      const dir = licenseDirFor({ env: { PORTABLE_EXECUTABLE_DIR: "D:\\Загрузки\\Agro" }, userDataDir: "C:\\Users\\x\\AgroPrognoz" });
      assert.deepEqual(dir, { dir: "D:\\Загрузки\\Agro", portable: true, source: "PORTABLE_EXECUTABLE_DIR" });
      const viaExe = licenseDirFor({ env: { AGRO_PORTABLE_EXE: "D:\\Загрузки\\Agro\\AgroPrognoz.exe" }, userDataDir: "C:\\u" });
      assert.equal(viaExe.dir, "D:\\Загрузки\\Agro");
      assert.equal(viaExe.portable, true);
    });

    it("установленная сборка — как раньше, каталог пользователя", () => {
      const dir = licenseDirFor({ env: {}, userDataDir: "C:\\Users\\x\\AppData\\Roaming\\AgroPrognoz" });
      assert.deepEqual(dir, { dir: "C:\\Users\\x\\AppData\\Roaming\\AgroPrognoz", portable: false, source: "userData" });
    });

    it("рядом с EXE писать некуда — откат на каталог пользователя", () => {
      const notThere = licenseDirFor({ env: { PORTABLE_EXECUTABLE_DIR: "D:\\нет\\такого" }, userDataDir: "C:\\u", existsSync: () => false });
      assert.deepEqual(notThere, { dir: "C:\\u", portable: false, source: "userData" });
      const readOnly = licenseDirFor({ env: { AGRO_PORTABLE_EXE: "C:\\Program Files\\Agro\\AgroPrognoz.exe" }, userDataDir: "C:\\u", existsSync: () => true, canWrite: () => false });
      assert.equal(readOnly.dir, "C:\\u", "из Program Files лицензия в Program Files не пишется");
      assert.equal(readOnly.portable, false);
    });

    it("каталог рядом с EXE видит диагностика и сброс", () => {
      const candidates = doctor.licenseDirectoryCandidates({ platform: "win32", env: { USERPROFILE: "C:\\u", APPDATA: "C:\\u\\AppData\\Roaming", PORTABLE_EXECUTABLE_DIR: "D:\\Загрузки\\Agro" } });
      assert.equal(candidates[0], path.normalize("D:\\Загрузки\\Agro"), "портативный каталог должен быть первым");
      assert.ok(candidates.some((dir) => dir.endsWith(path.join("Roaming", "AgroPrognoz"))), "обычный каталог тоже должен оставаться в списке");
      const viaExe = doctor.licenseDirectoryCandidates({ platform: "win32", env: { USERPROFILE: "C:\\u", APPDATA: "C:\\u\\AppData\\Roaming", AGRO_PORTABLE_EXE: "E:\\Agro\\AgroPrognoz.exe" } });
      assert.equal(viaExe[0], path.normalize("E:\\Agro"));
    });
  });

  it("не съедает следующий переключатель вместо значения", () => {
    assert.equal(resolveCheckInstance({ argv: ["--check", "--other"], env: {}, execPath: "C:\\a\\AgroPrognoz.exe" }).instance, checkmode.DEFAULT_INSTANCE);
  });

  it("берёт идентификатор из окружения, а имя EXE — запасной вариант", () => {
    assert.equal(resolveCheckInstance({ argv: [], env: { AGRO_CHECK_INSTANCE: "from-env" }, execPath: "C:\\a\\AgroPrognoz.exe" }).instance, "from-env");
    assert.equal(resolveCheckInstance({ argv: [], env: {}, execPath: "C:\\Downloads\\AgroPrognoz-check-42.exe" }).instance, "42");
    assert.equal(
      resolveCheckInstance({ argv: [], env: { AGRO_PORTABLE_EXE: "D:\\tmp\\AgroPrognoz-check-portable-9.exe" }, execPath: "C:\\Users\\x\\AppData\\Local\\Temp\\n\\AgroPrognoz.exe" }).instance,
      "portable-9",
    );
    assert.equal(resolveCheckInstance({ argv: [], env: {}, execPath: "C:\\x\\agroprognoz-check-ZA.exe" }).source, "exe-name");
  });

  it("переключатель важнее имени файла и окружения", () => {
    const resolved = resolveCheckInstance({
      argv: ["--check-instance=from-flag"],
      env: { AGRO_CHECK_INSTANCE: "from-env", AGRO_PORTABLE_EXE: "C:\\x\\AgroPrognoz-check-from-name.exe" },
      execPath: "C:\\x\\AgroPrognoz.exe",
    });
    assert.deepEqual(resolved, { instance: "from-flag", source: "flag" });
  });

  it("имя файла лицензии получается из идентификатора и безопасно", () => {
    assert.equal(licenseFileNameFor("demo"), "agroprognoz-check-demo.license");
    assert.equal(licenseFileNameFor(" 2026-09-13 "), "agroprognoz-check-2026-09-13.license");
    assert.equal(licenseFileNameFor(""), LICENSE_FILE_NAME);
    assert.equal(sanitizeInstance("!!!"), "", "из мусора идентификатор не получается");
    assert.equal(sanitizeInstance("a".repeat(40)), "", "слишком длинный идентификатор отбрасывается, а не укорачивается");
    assert.equal(sanitizeInstance("a".repeat(32)).length, 32);
    // Идентификатор не должен протащить в имя файла разделители или «..».
    for (const attempt of ["../../etc/passwd", "..\\..\\windows", "a/b\\c", "..", "x".repeat(80)]) {
      const name = licenseFileNameFor(attempt);
      assert.doesNotMatch(name, /[\\/]/, `небезопасное имя: ${name}`);
      assert.equal(name.includes(".."), false, `родительский каталог в имени: ${name}`);
    }
  });

  it("обычное имя_exe не считается проверочным", () => {
    assert.equal(instanceFromExePath("C:\\x\\AgroPrognoz-0.2.1-portable.exe"), "");
    assert.equal(instanceFromExePath("C:\\x\\AgroPrognoz-check-.exe"), "");
    assert.equal(instanceFromExePath("C:\\x\\AgroPrognoz-check-very-long-instance-name-1234567890.exe"), "");
  });
});

/* ── Диагностика ─────────────────────────────────────────────────────────── */

describe("каталоги профиля, где ищется лицензия", () => {
  it("Windows — AppData\\Roaming по имени сборки и по имени пакета", () => {
    const dirs = doctor.licenseDirectoryCandidates({
      platform: "win32",
      env: { APPDATA: "C:\\Users\\igor\\AppData\\Roaming" },
    });
    assert.equal(dirs.length, 2);
    assert.match(dirs[0], /AgroPrognoz$/);
    assert.match(dirs[1], /agroprognoz-corn$/);
  });

  it("Linux уважает XDG_CONFIG_HOME, macOS берёт Application Support", () => {
    assert.match(doctor.licenseDirectoryCandidates({ platform: "linux", env: { XDG_CONFIG_HOME: "/tmp/cfg", HOME: "/home/x" } })[0], /\/tmp\/cfg/);
    assert.match(doctor.licenseDirectoryCandidates({ platform: "linux", env: { HOME: "/home/x" } })[0], /\/home\/x\/\.config/);
    assert.match(doctor.licenseDirectoryCandidates({ platform: "darwin", env: { HOME: "/Users/x" } })[0], /Library\/Application Support/);
  });

  it("распознаёт файлы лицензии и их карантины", () => {
    assert.equal(doctor.isLicenseArtifact(LICENSE_FILE_NAME), true);
    assert.equal(doctor.isLicenseArtifact("agroprognoz-check-demo.license"), true);
    assert.equal(doctor.isLicenseArtifact("agroprognoz.license.MAC.bad"), true);
    assert.equal(doctor.isLicenseArtifact("agroprognoz.license.bak-20260913-101500"), true);
    assert.equal(doctor.isLicenseArtifact("agroprognoz.sqlite"), false);
    assert.equal(doctor.isLicenseArtifact("license.txt"), false);
    assert.equal(doctor.isLiveLicenseFile("agroprognoz.license"), true);
    assert.equal(doctor.isLiveLicenseFile("agroprognoz.license.MAC.bad"), false);
    assert.equal(doctor.instanceOfLicenseFile("agroprognoz-check-demo.license"), "demo");
    assert.equal(doctor.instanceOfLicenseFile(LICENSE_FILE_NAME), "");
  });
});

describe("осмотр файла лицензии без Electron", () => {
  it("инспекция и хранилище дают одинаковый вывод о целостности", async () => {
    await withTempDir(async (dir) => {
      const store = createLicenseStore({ dir, machineId: MACHINE_A, log: () => {} });
      await store.write({ payload: "AA==", signature: "AA==", serialHex: "0011223344556677", keyId: 1, bound: true });
      const raw = await fsp.readFile(path.join(dir, LICENSE_FILE_NAME), "utf8");
      assert.equal(inspectEnvelope(MACHINE_A, raw).ok, true);
      assert.equal(inspectEnvelope(MACHINE_B, raw).reason, "MACHINE");
      const broken = raw.replace(/"mac"\s*:\s*"[^"]+"/, `"mac": "${Buffer.alloc(32).toString("base64")}"`);
      assert.equal(inspectEnvelope(MACHINE_A, broken).reason, "MAC");
      assert.equal(inspectEnvelope(MACHINE_A, "не json").reason, "PARSE_FAILED");
      assert.equal(inspectEnvelope(MACHINE_A, `${storeModule.MAGIC}\n{"v":99}`).reason, "FORMAT");
    });
  });

  it("status видит активную лицензию, чужую машину и подмену", async () => {
    await withTempDir(async (dir) => {
      const write = async (name, machineId) => {
        const target = await createLicenseStore({ dir, fileName: name, machineId, log: () => {} }).write({
          payload: "AA==",
          signature: "AA==",
          serialHex: "0011223344556677",
          keyId: 1,
          bound: true,
        });
        assert.equal(target.ok, true);
      };
      await write(LICENSE_FILE_NAME, MACHINE_A);
      await write("agroprognoz-check-demo.license", MACHINE_B);
      await write("agroprognoz.license.MAC.bad", MACHINE_A);
      const files = await fsp.readdir(dir);
      const read = (file) => fsp.readFile(file, "utf8");
      const inspected = await doctor.inspectLicenseDirectory({ dir, machineId: MACHINE_A, listFiles: async () => files, readFile: read });
      const main = inspected.files.find((item) => item.name === LICENSE_FILE_NAME);
      const foreign = inspected.files.find((item) => item.name === "agroprognoz-check-demo.license");
      const archive = inspected.files.find((item) => item.verdict === "ARCHIVE");
      assert.equal(main.verdict, "ACTIVE");
      assert.equal(main.instance, "");
      // Запасной шифр выводится из идентификатора компьютера, поэтому содержимое доступно.
      assert.equal(main.licenseReadableHere, true);
      assert.equal(main.serialHex, "0011223344556677");
      assert.equal(foreign.verdict, "FOREIGN_MACHINE");
      assert.equal(foreign.instance, "demo");
      assert.equal(archive.isArchive, true);
    });
  });

  it("сброс переносит файл в резервную копию, а --purge удаляет", async () => {
    await withTempDir(async (dir) => {
      const file = path.join(dir, LICENSE_FILE_NAME);
      await createLicenseStore({ dir, machineId: MACHINE_A, log: () => {} }).write({ payload: "AA==", signature: "AA==", serialHex: "11", keyId: 1, bound: false });
      const moved = await doctor.resetLicenseFiles({
        files: [{ file }],
        now: () => new Date(2026, 8, 13, 10, 15, 0),
        rename: (from, to) => fsp.rename(from, to),
        unlink: (target) => fsp.rm(target, { force: true }),
      });
      assert.equal(moved.length, 1);
      assert.match(path.basename(moved[0].to), /^agroprognoz\.license\.bak-20260913-101500$/);
      await assert.rejects(() => fsp.access(file), /ENOENT/);
      const restored = await doctor.inspectLicenseDirectory({
        dir,
        machineId: MACHINE_A,
        listFiles: async () => await fsp.readdir(dir),
        readFile: (target) => fsp.readFile(target, "utf8"),
      });
      assert.equal(restored.files[0].verdict, "ARCHIVE", "резервная копия не считается активацией");

      await fsp.writeFile(file, "{}", "utf8");
      await doctor.resetLicenseFiles({ files: [{ file }], purge: true, rename: async () => {}, unlink: (target) => fsp.rm(target, { force: true }) });
      await assert.rejects(() => fsp.access(file), /ENOENT/);
    });
  });
});

/* ── Полный самопроверочный сценарий ─────────────────────────────────────── */

describe("самопроверка активации (то, что делает npm run activation:selftest)", () => {
  it("проходит весь путь: чистая машина → код → перезапуск → чужая машина → сброс", async () => {
    const pair = makeKeyPair();
    const revoked = crypto.randomBytes(core.SERIAL_BYTES);
    const material = {
      keyId: pair.keyId,
      keyMaterial: { keys: [pair.entry], revokedSerials: [] },
      revokedSerial: Uint8Array.from(revoked),
      revokedSerialHex: revoked.toString("hex"),
    };
    const signer = privateKeyObject(pair.privateKeyBase64);

    const result = await withTempDir(async (dir) =>
      doctor.runActivationSelfTest({
        mkdtemp: async (prefix) => path.join(dir, prefix),
        mkdir: (target) => fsp.mkdir(target, { recursive: true }),
        rm: () => Promise.resolve(),
        rmFile: (file) => fsp.rm(file, { force: true }),
        readFile: (file) => fsp.readFile(file, "utf8"),
        writeFile: (file, body) => fsp.writeFile(file, body, "utf8"),
        copyFile: (from, to) => fsp.copyFile(from, to),
        keys: () => material,
        issue: (input) => buildLicenseCode({ privateKey: signer, ...input }),
        guard: (options) => createGuard(options),
      }),
    );

    assert.ok(
      result.passed,
      `провалено: ${result.checks.filter((item) => !item.ok).map((item) => `${item.name} (${item.detail})`).join("; ")}`,
    );
    assert.ok(result.total >= 15, `проверок слишком мало: ${result.total}`);
  });

  it("проверочный экземпляр живёт в отдельном файле лицензии", async () => {
    const pair = makeKeyPair();
    await withTempDir(async (dir) => {
      const fileName = licenseFileNameFor("main-vs-check");
      assert.equal(fileName, "agroprognoz-check-main-vs-check.license");
      const guard = guardFor({ machineId: MACHINE_A, dir, keys: [pair.entry], licenseFileName: fileName });
      assert.equal((await guard.initialize()).activated, false);
      const code = issue(pair, { bound: false });
      assert.equal((await guard.activate(code.code)).ok, true);
      const files = await fsp.readdir(dir);
      assert.ok(files.includes(fileName), `в каталоге: ${files.join(", ")}`);
      assert.equal(files.includes(LICENSE_FILE_NAME), false, "общий файл лицензии затронут не был");

      // Общий экземпляр про проверочную лицензию ничего не знает → снова просит код.
      const main = guardFor({ machineId: MACHINE_A, dir, keys: [pair.entry] });
      assert.equal((await main.initialize()).activated, false);
    });
  });

  it("подмена имени файла лицензии не меняет ни подпись, ни привязку", async () => {
    const pair = makeKeyPair();
    await withTempDir(async (dir) => {
      const personal = issue(pair, { bound: true, shortId: core.machineShortId(MACHINE_A) });
      const store = createLicenseStore({ dir, fileName: licenseFileNameFor("x"), machineId: MACHINE_A, log: () => {} });
      await store.write({
        payload: Buffer.from(core.parseCode(personal.code).subarray(0, core.PAYLOAD_LENGTH)).toString("base64"),
        signature: Buffer.from(core.parseCode(personal.code).subarray(core.PAYLOAD_LENGTH)).toString("base64"),
        serialHex: personal.serialHex,
        keyId: pair.keyId,
        bound: true,
      });
      const guard = guardFor({ machineId: MACHINE_A, dir, keys: [pair.entry], licenseFileName: licenseFileNameFor("x") });
      const status = await guard.initialize();
      assert.equal(status.activated, true);
      assert.equal(status.serialHex, personal.serialHex);
      const other = guardFor({ machineId: MACHINE_B, dir, keys: [pair.entry], licenseFileName: licenseFileNameFor("x") });
      assert.equal((await other.initialize()).activated, false, "на другой машине тот же файл не принимается");
    });
  });
});
