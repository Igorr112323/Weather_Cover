#!/usr/bin/env node
/**
 * Подготовка защищённой сборки main process'а — `npm run harden`.
 *
 * Что делает:
 *   1. копирует electron/**.cjs в hardened/electron (исходники не меняются);
 *   2. обфусцирует их javascript-obfuscator'ом (профиль зависит от роли файла:
 *      модули лицензии — максимально жёсткий, preload — щадящий, потому что
 *      работает в sandbox'е без Node-API);
 *   3. считает SHA-256 каждого файла dist/ и hardened/electron/ и складывает
 *      манифест в hardened/electron/license/integrity-data.cjs;
 *   4. зашивает корневые хэши манифеста прямо в обфусцированный guard.cjs —
 *      так подмена манифеста не помогает: его корневой хэш лежит в другом
 *      файле, защищённом самопроверкой (selfDefending);
 *   5. самопроверяет результат: обфусцированные модули загружаются в Node,
 *      цепочка целостности сходится, а испорченный байт ловится.
 *
 * В сборку electron-builder уходит hardened/electron, а не electron/:
 * см. build.files в package.json. Порядок обязателен:
 *   npm run build → npm run harden → npm run dist:win
 *
 * Обфускация детерминирована (seed зависит от версии и имени файла): одна и та
 * же сборка даёт байт в байт тот же результат, поэтому хэши воспроизводимы.
 */

import { createRequire } from "node:module";
import { copyFile, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import process from "node:process";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

import JavaScriptObfuscator from "javascript-obfuscator";

const require = createRequire(import.meta.url);
const integrity = require("../electron/license/integrity.cjs");
const core = require("../electron/license/core.cjs");
const pkg = require("../package.json");

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIST_DIR = path.join(ROOT, "dist");
const SOURCE_ELECTRON = path.join(ROOT, "electron");
const OUT_DIR = path.join(ROOT, "hardened");
const OUT_ELECTRON = path.join(OUT_DIR, "electron");
const GUARD_RELATIVE = integrity.GUARD_RELATIVE_PATH; // "license/guard.cjs"
const MANIFEST_FILE = "license/integrity-data.cjs";

/** Заполнители в исходнике guard.cjs: на их место встают корневые хэши. */
const PLACEHOLDER_DIST = "__AGRO_DIST_ROOT__";
const PLACEHOLDER_ELECTRON = "__AGRO_ELECTRON_ROOT__";

/* ── Профили обфускации ──────────────────────────────────────────────────── */

const BASE = {
  compact: true,
  simplify: true,
  renameGlobals: false, // переименование глобальных имён ломает require/module
  identifierNamesGenerator: "hexadecimal",
  log: false,
};

/**
 * Модули лицензии: максимум защиты. selfDefending ломает код при попытке
 * привести его к читаемому виду (beautify), controlFlowFlattening прячет
 * порядок проверок, unicodeEscapeSequence убирает из бандла русские строки,
 * по которым проще всего найти проверку лицензии.
 */
const PROFILE_LICENSE = {
  ...BASE,
  target: "node",
  stringArray: true,
  stringArrayThreshold: 1,
  stringArrayEncoding: ["base64"],
  stringArrayRotate: true,
  stringArrayShuffle: true,
  stringArrayIndexShift: true,
  splitStrings: true,
  splitStringsChunkLength: 4,
  controlFlowFlattening: true,
  controlFlowFlatteningThreshold: 0.6,
  deadCodeInjection: true,
  deadCodeInjectionThreshold: 0.2,
  numbersToExpressions: true,
  transformObjectKeys: true,
  unicodeEscapeSequence: true,
  selfDefending: true,
};

/** Основной процесс: жёстко, но без selfDefending — здесь важна надёжность запуска. */
const PROFILE_MAIN = {
  ...BASE,
  target: "node",
  stringArray: true,
  stringArrayThreshold: 0.9,
  stringArrayEncoding: ["base64"],
  stringArrayRotate: true,
  stringArrayShuffle: true,
  splitStrings: true,
  splitStringsChunkLength: 8,
  controlFlowFlattening: true,
  controlFlowFlatteningThreshold: 0.35,
  deadCodeInjection: true,
  deadCodeInjectionThreshold: 0.1,
  numbersToExpressions: true,
  transformObjectKeys: false,
  unicodeEscapeSequence: false,
  selfDefending: false,
};

/**
 * Preload выполняется в sandbox'е: Node-API там урезан, поэтому кодирование
 * строк (оно использует Buffer/atob) выключено, а target — браузерный без eval.
 */
const PROFILE_PRELOAD = {
  ...BASE,
  target: "browser-no-eval",
  stringArray: true,
  stringArrayThreshold: 0.75,
  stringArrayEncoding: [],
  stringArrayRotate: true,
  stringArrayShuffle: true,
  splitStrings: true,
  splitStringsChunkLength: 12,
  controlFlowFlattening: false,
  deadCodeInjection: false,
  numbersToExpressions: true,
  transformObjectKeys: false,
  unicodeEscapeSequence: false,
  selfDefending: false,
};

/** Манифест целостности: данные, обфусцируются как ordinary-модуль. */
const PROFILE_DATA = {
  ...PROFILE_MAIN,
  controlFlowFlattening: false,
  deadCodeInjection: false,
  transformObjectKeys: true,
};

function profileFor(relativePath) {
  if (relativePath === "preload.cjs") return { name: "preload", options: PROFILE_PRELOAD };
  if (relativePath.startsWith("license/")) return { name: "license", options: PROFILE_LICENSE };
  return { name: "main", options: PROFILE_MAIN };
}

/** Детерминированный seed: одна сборка — один результат, хэши воспроизводимы. */
function seedFor(relativePath) {
  const digest = crypto.createHash("sha256").update(`${pkg.version}:${relativePath}`, "utf8").digest();
  return digest.readUInt32BE(0) % 2147483647;
}

function obfuscate(code, relativePath, profileOverride) {
  const profile = profileOverride ?? profileFor(relativePath);
  const result = JavaScriptObfuscator.obfuscate(code, { ...profile.options, seed: seedFor(relativePath) });
  return result.getObfuscatedCode();
}

/* ── Файлы ───────────────────────────────────────────────────────────────── */

async function walk(dir, base = dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const absolute = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await walk(absolute, base)));
    else if (entry.isFile()) files.push(path.relative(base, absolute).split(path.sep).join("/"));
  }
  return files.sort();
}

async function hashFile(absolute) {
  const bytes = await readFile(absolute);
  return integrity.hashBytes(bytes);
}

async function buildManifest(baseDir, files) {
  const manifest = {};
  for (const relative of files) manifest[relative] = await hashFile(path.join(baseDir, relative));
  return manifest;
}

function fail(message) {
  console.error(`\n✘ harden: ${message}\n`);
  process.exit(1);
}

/* ── Шаги ────────────────────────────────────────────────────────────────── */

async function prepareOutput() {
  if (!existsSync(DIST_DIR) || !(await walk(DIST_DIR)).length) {
    fail("нет dist/ — сначала выполните npm run build");
  }
  await rm(OUT_DIR, { recursive: true, force: true });
  await mkdir(OUT_ELECTRON, { recursive: true });
}

async function copySources() {
  const files = (await walk(SOURCE_ELECTRON)).filter((name) => name.endsWith(".cjs"));
  if (!files.length) fail("в electron/ не найдено ни одного .cjs");
  for (const relative of files) {
    const target = path.join(OUT_ELECTRON, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await copyFile(path.join(SOURCE_ELECTRON, relative), target);
  }
  return files;
}

async function obfuscateAll(files, { skip }) {
  const report = [];
  for (const relative of files) {
    if (skip.has(relative)) continue;
    const source = await readFile(path.join(SOURCE_ELECTRON, relative), "utf8");
    const profile = profileFor(relative);
    const code = obfuscate(source, relative);
    await writeFile(path.join(OUT_ELECTRON, relative), code, "utf8");
    report.push({ relative, profile: profile.name, source: source.length, output: code.length });
  }
  return report;
}

/** guard.cjs: подстановка корневых хэшей и обфускация последним. */
async function obfuscateGuard({ distRoot, electronRoot }) {
  const source = await readFile(path.join(SOURCE_ELECTRON, GUARD_RELATIVE), "utf8");
  if (!source.includes(PLACEHOLDER_DIST) || !source.includes(PLACEHOLDER_ELECTRON)) {
    fail(`в ${GUARD_RELATIVE} нет заполнителей корневых хэшей`);
  }
  const patched = source.replace(PLACEHOLDER_DIST, distRoot).replace(PLACEHOLDER_ELECTRON, electronRoot);
  const code = obfuscate(patched, GUARD_RELATIVE, { name: "license", options: PROFILE_LICENSE });
  await writeFile(path.join(OUT_ELECTRON, GUARD_RELATIVE), code, "utf8");
  return { source: patched.length, output: code.length };
}

async function writeManifestFile(manifest) {
  const source = `"use strict";

/**
 * Манифест целостности сборки. Создаётся scripts/harden.mjs, руками не правится.
 * Корневые хэши этого манифеста зашиты в license/guard.cjs: подменить манифест
 * незаметно не получится.
 */
module.exports = ${JSON.stringify({ version: 1, ...manifest }, null, 2)};
`;
  const code = obfuscate(source, MANIFEST_FILE, { name: "data", options: PROFILE_DATA });
  await writeFile(path.join(OUT_ELECTRON, MANIFEST_FILE), code, "utf8");
  return { source: source.length, output: code.length };
}

/* ── Самопроверка ────────────────────────────────────────────────────────── */

/**
 * Обфусцированные модули обязаны работать: проверяем их здесь, а не на машине
 * пользователя. Заодно проверяем, что порча файла действительно ловится.
 */
async function selfTest({ manifest, distRoot, electronRoot }) {
  const checks = [];
  const check = (name, condition, detail = "") => {
    checks.push({ name, ok: Boolean(condition), detail });
  };

  // 1. Синтаксис всех обфусцированных файлов (без выполнения: нужен Electron).
  const files = await walk(OUT_ELECTRON);
  for (const relative of files) {
    const code = await readFile(path.join(OUT_ELECTRON, relative), "utf8");
    try {
      new vm.Script(code, { filename: relative });
      check(`синтаксис ${relative}`, true);
    } catch (error) {
      check(`синтаксис ${relative}`, false, error.message);
    }
  }

  // 2. Ядро лицензий: формат кода и round-trip base32.
  const hardenedCore = require(path.join(OUT_ELECTRON, "license", "core.cjs"));
  check("core: длина лицензии 80 байт", hardenedCore.LICENSE_LENGTH === core.LICENSE_LENGTH);
  const bytes = crypto.randomBytes(hardenedCore.LICENSE_LENGTH);
  const text = hardenedCore.formatCode(bytes);
  check("core: код → байты без потерь", Buffer.compare(Buffer.from(hardenedCore.parseCode(text)), Buffer.from(bytes)) === 0, text.slice(0, 24));
  check("core: разбор кода из письма", hardenedCore.codeCandidates(`Ваш код: ${text} — спасибо`).includes(hardenedCore.normalizeCodeText(text)));

  // 3. Целостность: манифест сходится, порча ловится.
  const hardenedIntegrity = require(path.join(OUT_ELECTRON, "license", "integrity.cjs"));
  const readMapped = (absolute) => {
    const relative = path.relative(ROOT, absolute).split(path.sep).join("/");
    if (relative.startsWith("dist/")) return readFile(path.join(ROOT, relative));
    if (relative.startsWith("electron/")) return readFile(path.join(OUT_DIR, relative));
    return readFile(absolute);
  };
  const checker = hardenedIntegrity.createIntegrityChecker({
    root: ROOT,
    manifest,
    rootHashes: { dist: distRoot, electron: electronRoot },
    readFile: readMapped,
  });
  const good = await checker.verify();
  check("integrity: цепочка сходится", good.ok === true && good.skipped === false, JSON.stringify(good.mismatches ?? []).slice(0, 120));
  check("integrity: проверено файлов", good.checked >= Object.keys(manifest.dist).length + Object.keys(manifest.electron).length, String(good.checked));

  const firstDistFile = Object.keys(manifest.dist)[0];
  const corruptChecker = hardenedIntegrity.createIntegrityChecker({
    root: ROOT,
    manifest,
    rootHashes: { dist: distRoot, electron: electronRoot },
    readFile: async (absolute) => {
      const bytesRead = await readMapped(absolute);
      const relative = path.relative(path.join(ROOT, "dist"), absolute).split(path.sep).join("/");
      if (relative === firstDistFile) {
        const tampered = Buffer.from(bytesRead);
        tampered[0] = tampered[0] ^ 0xff;
        return tampered;
      }
      return bytesRead;
    },
  });
  const bad = await corruptChecker.verify();
  check("integrity: подмена файла ловится", bad.ok === false && bad.mismatches.length > 0, JSON.stringify(bad.mismatches ?? []).slice(0, 120));

  const fakeManifestChecker = hardenedIntegrity.createIntegrityChecker({
    root: ROOT,
    manifest: { dist: { "index.html": "0".repeat(64) }, electron: manifest.electron },
    rootHashes: { dist: distRoot, electron: electronRoot },
    readFile: readMapped,
  });
  const fakeManifest = await fakeManifestChecker.verify();
  check("integrity: подмена манифеста ловится", fakeManifest.ok === false && fakeManifest.reason === "MANIFEST");

  // 4. Страж: запускается, данных без активации не отдаёт, мусорный код не принимает.
  const hardenedKeys = require(path.join(OUT_ELECTRON, "license", "keys.cjs"));
  const hardenedGuard = require(path.join(OUT_ELECTRON, "license", "guard.cjs"));
  check("keys: открытый ключ на месте", Array.isArray(hardenedKeys.keys) && hardenedKeys.keys.length > 0);

  const memoryStore = createMemoryStore();
  const guard = hardenedGuard.createGuard({
    appRoot: ROOT,
    userDataDir: path.join(ROOT, "hardened", "selftest"),
    machine: { machineId: "ab".repeat(32), quality: "high", source: "selftest" },
    store: memoryStore,
    integrity: checker,
  });
  const initial = await guard.initialize();
  check("guard: без лицензии не активирован", initial.activated === false);
  check("guard: лицензия бессрочная в статусе", initial.permanent === true && initial.expiration === null);
  check("guard: данные закрыты до активации", guard.gate("любой-токен")?.code === guard.GATE.NOT_ACTIVATED);

  const rejected = await guard.activate("AGRO-0000-0000-0000-0000");
  check("guard: выдуманный код отклонён", rejected.ok === false && Boolean(rejected.reason));

  const garbage = await guard.activate("спасибо, но нет");
  check("guard: мусор на вводе отклонён", garbage.ok === false);

  // 5. Полный цикл активации настоящим кодом. Проверять надо именно
  // обфусцированный код, поэтому закрытый ключ берётся из любого источника:
  //   • на машине владельца — secrets/license-key.json (боевой ключ);
  //   • в CI — выдуманная пара AGRO_LICENSE_SECKEY + AGRO_LICENSE_PUBKEY,
  //     которая подменяет keyMaterial стража и НЕ попадает в сборку.
  const cycle = await activationSelfTestKey(hardenedKeys);
  if (!cycle) {
    console.log("• полный цикл активации не проверен: нет закрытого ключа (AGRO_LICENSE_SECKEY или secrets/license-key.json)");
  } else {
    {
      // Отдельный страж: у него свой keyMaterial, поэтому и токен свой —
      // проверять доступ к данным нужно именно у него.
      const { privateKey, keyMaterial, keyId } = cycle;
      const cycleGuard = hardenedGuard.createGuard({
        appRoot: ROOT,
        userDataDir: path.join(ROOT, "hardened", "selftest"),
        machine: { machineId: "ab".repeat(32), quality: "high", source: "selftest" },
        store: memoryStore,
        integrity: checker,
        keyMaterial,
      });
      await cycleGuard.initialize();
      const payload = core.buildPayload({ keyId });
      const signature = crypto.sign(null, Buffer.from(payload), privateKey);
      const code = core.formatCode(Buffer.concat([Buffer.from(payload), Buffer.from(signature)]));
      const activated = await cycleGuard.activate(code);
      check("guard: действительный код принимается", activated.ok === true, activated.message ?? activated.status?.message ?? "");
      check("guard: после активации выдаётся токен", typeof activated.token === "string" && activated.token.length > 0);
      check("guard: с токеном данные доступны", cycleGuard.gate(activated.token) === null);
      check("guard: чужой токен не проходит", cycleGuard.gate(`${activated.token}x`) !== null);
      check("guard: статус без токена", cycleGuard.status().token === undefined);

      const reread = await memoryStore.read();
      const secondGuard = hardenedGuard.createGuard({
        appRoot: ROOT,
        userDataDir: path.join(ROOT, "hardened", "selftest"),
        machine: { machineId: "ab".repeat(32), quality: "high", source: "selftest" },
        store: memoryStore,
        integrity: checker,
        keyMaterial,
      });
      const restored = await secondGuard.initialize();
      check("guard: лицензия переживает перезапуск", restored.activated === true && reread.status === "active");
      check("guard: серийник совпадает", restored.serial === activated.status.serial);
      check("guard: статус после активации — бессрочная", restored.permanent === true && restored.expiration === null);
    }
  }

  return checks;
}

/**
 * Закрытый ключ для самопроверки полного цикла активации.
 * @returns {Promise<null | {privateKey:import("node:crypto").KeyObject, keyMaterial:{keys:Array,revokedSerials:Array}, keyId:number}>}
 */
async function activationSelfTestKey(hardenedKeys) {
  const envPrivate = process.env.AGRO_LICENSE_SECKEY;
  if (envPrivate) {
    const privateKey = crypto.createPrivateKey({ key: Buffer.from(envPrivate, "base64"), format: "der", type: "pkcs8" });
    // Открытый ключ: из окружения (CI) или выводим из закрытого (машина владельца).
    const publicKey =
      process.env.AGRO_LICENSE_PUBKEY ??
      crypto.createPublicKey(privateKey).export({ format: "der", type: "spki" }).toString("base64");
    const keyId = Number(process.env.AGRO_LICENSE_KEY_ID ?? 1);
    return {
      privateKey,
      keyId,
      keyMaterial: { keys: [{ keyId, label: "selftest", publicKey }], revokedSerials: [] },
    };
  }

  const secretFile = process.env.AGRO_LICENSE_KEY_FILE ?? path.join(ROOT, "secrets", "license-key.json");
  if (!existsSync(secretFile)) return null;
  const secret = JSON.parse(await readFile(secretFile, "utf8"));
  const entry = (secret.keys ?? []).find((item) => hardenedKeys.keys.some((key) => key.keyId === item.keyId));
  if (!entry) return null;
  return {
    privateKey: crypto.createPrivateKey({ key: Buffer.from(entry.privateKey, "base64"), format: "der", type: "pkcs8" }),
    keyId: entry.keyId,
    // Боевые открытые ключи из сборки: проверяется та же цепочка, что и у пользователя.
    keyMaterial: { keys: hardenedKeys.keys, revokedSerials: hardenedKeys.revokedSerials ?? [] },
  };
}

/** Хранилище лицензии в памяти: самопроверке диск не нужен. */
function createMemoryStore() {
  let record = null;
  return {
    fileName: "selftest.license",
    STATUS: { NONE: "none", ACTIVE: "active", INVALID: "invalid" },
    async read() {
      return record ? { status: "active", record } : { status: "none" };
    },
    async write(next) {
      record = next;
      return { ok: true };
    },
    async quarantine() {
      record = null;
      return "quarantined";
    },
  };
}

/* ── Запуск ──────────────────────────────────────────────────────────────── */

const startedAt = process.hrtime.bigint();
console.log("• harden: obfuscation + integrity manifest");

await prepareOutput();
const sourceFiles = await copySources();
console.log(`• скопировано файлов main process: ${sourceFiles.length}`);

const skipped = new Set([GUARD_RELATIVE]);
const report = await obfuscateAll(sourceFiles, { skip: skipped });

const distFiles = await walk(DIST_DIR);
const distManifest = await buildManifest(DIST_DIR, distFiles);
const distRoot = integrity.manifestRootHash(distManifest);

const electronFilesWithoutGuard = (await walk(OUT_ELECTRON)).filter((name) => name !== GUARD_RELATIVE);
const electronManifestWithoutGuard = await buildManifest(OUT_ELECTRON, electronFilesWithoutGuard);
const electronRoot = integrity.electronRootHash(electronManifestWithoutGuard);

const guardReport = await obfuscateGuard({ distRoot, electronRoot });

const electronManifest = {
  ...electronManifestWithoutGuard,
  [GUARD_RELATIVE]: await hashFile(path.join(OUT_ELECTRON, GUARD_RELATIVE)),
};
const manifest = { dist: distManifest, electron: electronManifest };
const manifestReport = await writeManifestFile(manifest);

console.log(`• манифест: dist ${Object.keys(distManifest).length} файлов, electron ${Object.keys(electronManifest).length} файлов`);
console.log(`• корневой хэш dist:     ${distRoot}`);
console.log(`• корневой хэш electron: ${electronRoot}`);

const checks = await selfTest({ manifest, distRoot, electronRoot });
const failed = checks.filter((check) => !check.ok);
for (const check of checks) {
  if (!check.ok) console.error(`  ✘ ${check.name}${check.detail ? ` — ${check.detail}` : ""}`);
}
if (failed.length) fail(`самопроверка не прошла: ${failed.length} из ${checks.length}`);
console.log(`• самопроверка: ${checks.length} проверок пройдено`);

const totalIn = report.reduce((sum, item) => sum + item.source, 0) + guardReport.source + manifestReport.source;
const totalOut = report.reduce((sum, item) => sum + item.output, 0) + guardReport.output + manifestReport.output;
for (const item of [...report, { relative: GUARD_RELATIVE, profile: "license", ...guardReport }, { relative: MANIFEST_FILE, profile: "data", ...manifestReport }]) {
  console.log(`  ${item.relative.padEnd(28)} ${item.profile.padEnd(8)} ${(item.source / 1024).toFixed(1)} КБ → ${(item.output / 1024).toFixed(1)} КБ`);
}
console.log(`• итог: ${(totalIn / 1024).toFixed(0)} КБ исходников → ${(totalOut / 1024).toFixed(0)} КБ защищённого кода`);
console.log(`• готово за ${(Number(process.hrtime.bigint() - startedAt) / 1e9).toFixed(1)} с → ${path.relative(ROOT, OUT_DIR)}/electron\n`);
