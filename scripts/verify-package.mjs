#!/usr/bin/env node
/**
 * Проверка уже собранного приложения — `npm run verify:package`.
 *
 * CI не может запустить Windows EXE, но может проверить то, что внутри него,
 * до публикации артефакта:
 *
 *   1. состав app.asar: на месте ли обфусцированный electron/, dist/ и
 *      package.json, и нет ли внутри исходников (electron/*.cjs из репозитория);
 *   2. цепочка целостности упакованных файлов: guard.cjs из упаковки сам
 *      сверяет манифест и файлы — если electron-builder что-то пережал,
 *      перекодировал или потерял, проверка это увидит;
 *   3. страж лицензии из упаковки работает: не активирован без кода и не
 *      отдаёт данные без токена;
 *   4. Electron Fuses в AgroPrognoz.exe: RunAsNode, NODE_OPTIONS, --inspect и
 *      загрузка кода мимо app.asar должны быть выключены.
 *
 * Запуск: node scripts/verify-package.mjs [каталог win-unpacked]
 */

import { createRequire } from "node:module";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const asar = require("@electron/asar");
const { FuseV1Options, getCurrentFuseWire } = require("@electron/fuses");

/**
 * Состояния фьюзов в том виде, в котором их отдаёт @electron/fuses
 * (числовые коды FuseState). Приводим к строке, чтобы не зависеть от версии.
 */
function fuseState(value) {
  if (value === 48 || value === "0" || value === "Disabled") return "disabled";
  if (value === 49 || value === "1" || value === "Enabled") return "enabled";
  if (value === 114 || value === "r" || value === "Removed") return "removed";
  return `unknown(${String(value)})`;
}
const core = require("../electron/license/core.cjs");

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const UNPACKED = process.argv[2] ? path.resolve(process.argv[2]) : path.join(ROOT, "release", "win-unpacked");
const ASAR_PATH = path.join(UNPACKED, "resources", "app.asar");
const EXE_NAME = "AgroPrognoz.exe";

const failures = [];
let passed = 0;

function check(name, condition, detail = "") {
  if (condition) {
    passed += 1;
    console.log(`  ✓ ${name}${detail ? ` — ${detail}` : ""}`);
  } else {
    failures.push(name);
    console.error(`  ✘ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function fail(message) {
  console.error(`\n✘ verify-package: ${message}\n`);
  process.exit(1);
}

if (!existsSync(UNPACKED)) fail(`нет каталога ${path.relative(ROOT, UNPACKED)} — сначала соберите приложение`);
if (!existsSync(ASAR_PATH)) fail(`нет ${path.relative(ROOT, ASAR_PATH)}`);

const tempRoot = await mkdtemp(path.join(os.tmpdir(), "agro-verify-"));
const appDir = path.join(tempRoot, "app");

try {
  console.log("• распаковка app.asar");
  asar.extractAll(ASAR_PATH, appDir);
  const list = await readdir(appDir, { recursive: true });
  const files = list.map((item) => String(item).split(path.sep).join("/"));

  console.log("\nСостав app.asar:");
  const topLevel = [...new Set(files.map((item) => item.split("/")[0]))].sort();
  console.log(`  ${topLevel.join(", ")}`);
  check("внутри есть dist/", files.some((item) => item.startsWith("dist/")));
  check("внутри есть electron/", files.some((item) => item.startsWith("electron/")));
  check("package.json на месте", files.includes("package.json"));
  check("нет app.asar.unpacked", !existsSync(path.join(UNPACKED, "resources", "app.asar.unpacked")));

  const packagedMain = await readFile(path.join(appDir, "electron", "main.cjs"), "utf8");
  check("main.cjs обфусцирован", !packagedMain.includes("АгроПрогноз — Кукуруза") && !packagedMain.includes("createSplashWindow"));
  check("main.cjs — не исходник из репозитория", packagedMain.length !== (await readFile(path.join(ROOT, "electron", "main.cjs"), "utf8")).length);

  const packagedPreload = await readFile(path.join(appDir, "electron", "preload.cjs"), "utf8");
  check("preload.cjs обфусцирован", !packagedPreload.includes("contextBridge.exposeInMainWorld(\"agro\""));

  check("манифест целостности в упаковке", files.includes("electron/license/integrity-data.cjs"));
  check("исходников расчётов в упаковке нет", !files.some((item) => item.startsWith("calculations/")));
  check("исходников интерфейса (src/) в упаковке нет", !files.some((item) => item.startsWith("src/")));
  check("скриптов сборки в упаковке нет", !files.some((item) => item.startsWith("scripts/")));
  check("тестов в упаковке нет", !files.some((item) => item.startsWith("tests/")));
  check("ключей и журнала лицензий в упаковке нет", !files.some((item) => item.startsWith("secrets/") || item.endsWith(".agrolic")));
  // electron-builder всегда кладёт в asar production-зависимости из package.json,
  // поэтому список зависимостей намеренно пуст: всё нужное собирает Vite в dist/
  // (шрифты, chart.js, leaflet, sql-wasm). Появится node_modules — значит кто-то
  // вернул пакет в dependencies, и в EXE поедет лишний (необфусцированный) код.
  const modules = files.filter((item) => item.startsWith("node_modules/"));
  check("node_modules в упаковку не попали", modules.length === 0, modules.slice(0, 5).join(", "));

  const packagedPkg = JSON.parse(await readFile(path.join(appDir, "package.json"), "utf8"));
  check("точка входа — electron/main.cjs", packagedPkg.main === "electron/main.cjs", packagedPkg.main);
  check("версия совпадает", packagedPkg.version === require("../package.json").version, packagedPkg.version);

  console.log("\nЦепочка целостности упакованных файлов:");
  const packedIntegrity = require(path.join(appDir, "electron", "license", "integrity.cjs"));
  const packedManifestModule = require(path.join(appDir, "electron", "license", "integrity-data.cjs"));
  const manifest = { dist: packedManifestModule.dist, electron: packedManifestModule.electron };
  const checker = packedIntegrity.createIntegrityChecker({
    root: appDir,
    manifest,
    // Корневые хэши берём из самого манифеста: здесь проверяется, что файлы
    // упаковки совпадают с тем, что хэшировал harden.mjs (а не цепочка доверия).
    rootHashes: {
      dist: packedIntegrity.manifestRootHash(manifest.dist),
      electron: packedIntegrity.electronRootHash(manifest.electron),
    },
  });
  const result = await checker.verify();
  check(
    "файлы упаковки совпадают с манифестом",
    result.ok === true && result.skipped === false,
    `проверено ${result.checked}, расхождений ${result.mismatches.length}${result.mismatches.length ? `: ${result.mismatches.slice(0, 4).join(", ")}` : ""}`,
  );

  console.log("\nСтраж лицензии из упаковки:");
  const packedGuard = require(path.join(appDir, "electron", "license", "guard.cjs"));
  const guard = packedGuard.createGuard({
    appRoot: appDir,
    userDataDir: path.join(tempRoot, "userData"),
    machine: { machineId: "cd".repeat(32), quality: "high", source: "verify" },
    store: memoryStore(),
    // Целостность guard проверяет сам, своими корневыми хэшами из сборки.
  });
  const status = await guard.initialize();
  check("guard упаковки запускается", status && typeof status === "object");
  check("guard сам проверил целостность упаковки", status?.tampered === false, status?.tamperDetail ?? "");
  check("проверка целостности включена в сборке", status?.integrityEnabled === true);
  check("без кода приложение не активировано", status?.activated === false);
  check("лицензия бессрочная (expiration = null)", status?.permanent === true && status?.expiration === null);
  check("данные закрыты до активации", guard.gate("токен-наугад")?.code === guard.GATE.NOT_ACTIVATED);
  // Нагрузка настоящая (версия и продукт совпадают), подпись — выдуманная:
  // именно так выглядит попытка подобрать код.
  const forgedPayload = core.buildPayload({ keyId: 1 });
  const forged = core.formatCode(Buffer.concat([Buffer.from(forgedPayload), crypto.randomBytes(core.SIGNATURE_LENGTH)]));
  const rejected = await guard.activate(forged);
  check("подделанный код отклонён", rejected.ok === false && rejected.reason === "SIGNATURE", rejected.reason);

  console.log("\nElectron Fuses:");
  const exePath = path.join(UNPACKED, EXE_NAME);
  if (!existsSync(exePath)) {
    check(`${EXE_NAME} найден`, false, exePath);
  } else {
    const wire = await getCurrentFuseWire(exePath);
    const state = (option) => fuseState(wire?.[option]);
    check("RunAsNode выключен", state(FuseV1Options.RunAsNode) === "disabled", state(FuseV1Options.RunAsNode));
    check(
      "NODE_OPTIONS выключен",
      state(FuseV1Options.EnableNodeOptionsEnvironmentVariable) === "disabled",
      state(FuseV1Options.EnableNodeOptionsEnvironmentVariable),
    );
    check(
      "--inspect выключен",
      state(FuseV1Options.EnableNodeCliInspectArguments) === "disabled",
      state(FuseV1Options.EnableNodeCliInspectArguments),
    );
    check("код грузится только из app.asar", state(FuseV1Options.OnlyLoadAppFromAsar) === "enabled", state(FuseV1Options.OnlyLoadAppFromAsar));
    check("шифрование cookie включено", state(FuseV1Options.EnableCookieEncryption) === "enabled", state(FuseV1Options.EnableCookieEncryption));
    check(
      "file:// без лишних привилегий",
      state(FuseV1Options.GrantFileProtocolExtraPrivileges) === "disabled",
      state(FuseV1Options.GrantFileProtocolExtraPrivileges),
    );
  }
} finally {
  await rm(tempRoot, { recursive: true, force: true }).catch(() => {});
}

console.log(`\n${failures.length ? `✘ Провалено проверок: ${failures.length}` : `✔ Пройдено проверок: ${passed}`}`);
if (failures.length) {
  console.error(`  ${failures.join("\n  ")}\n`);
  process.exit(1);
}
console.log("");

/** Хранилище лицензии в памяти: проверка не должна трогать диск. */
function memoryStore() {
  return {
    fileName: "verify.license",
    STATUS: { NONE: "none", ACTIVE: "active", INVALID: "invalid" },
    async read() {
      return { status: "none" };
    },
    async write() {
      return { ok: true };
    },
    async quarantine() {
      return null;
    },
  };
}
