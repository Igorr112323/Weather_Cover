#!/usr/bin/env node
/**
 * Подготовка защищённой сборки main process'а — `npm run harden`.
 *
 * Что делает:
 *   1. копирует electron/**.cjs в hardened/electron (исходники не меняются);
 *   2. обфусцирует их javascript-obfuscator'ом (профиль зависит от роли файла:
 *      модуль защиты от отладки — максимально жёсткий, preload — щадящий,
 *      потому что работает в sandbox'е без Node-API);
 *   3. самопроверяет результат: обфусцированные модули загружаются в Node,
 *      мост preload цел, а модуль защиты от отладки принимает те же решения,
 *      что и исходник.
 *
 * В сборку electron-builder уходит hardened/electron, а не electron/:
 * см. build.files в package.json. Порядок обязателен:
 *   npm run build → npm run harden → npm run dist:win
 *
 * Обфускация детерминирована (seed зависит от версии и имени файла): одна и та
 * же сборка даёт байт в байт тот же результат.
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
const shield = require("../electron/shield.cjs");
const pkg = require("../package.json");

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIST_DIR = path.join(ROOT, "dist");
const SOURCE_ELECTRON = path.join(ROOT, "electron");
const OUT_DIR = path.join(ROOT, "hardened");
const OUT_ELECTRON = path.join(OUT_DIR, "electron");
/** Модуль защиты от отладки: обфусцируется жёстче остальных. */
const SHIELD_RELATIVE = "shield.cjs";

/* ── Профили обфускации ──────────────────────────────────────────────────── */

const BASE = {
  compact: true,
  simplify: true,
  // Имена верхнего уровня переименовываются: в main.cjs нет конструкций,
  // зависящих от имён (eval, new Function, global[...], разбор стека), а
  // module.exports/require работают по строкам и свойствам — их обфускация не трогает.
  // Проверено самопроверкой ниже (загрузка preload и прогон shield).
  renameGlobals: true,
  identifierNamesGenerator: "hexadecimal",
  log: false,
};

/**
 * Модуль защиты от отладки: максимум защиты. selfDefending ломает код при
 * попытке привести его к читаемому виду (beautify), controlFlowFlattening
 * прячет порядок проверок, unicodeEscapeSequence убирает из бандла русские
 * строки, по которым проще всего найти проверки.
 */
const PROFILE_STRICT = {
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

/**
 * Основной процесс: жёстко, но без selfDefending — здесь важна надёжность запуска.
 * stringArrayThreshold = 1 и unicodeEscapeSequence = 1 обязательны: в main.cjs
 * живут русские строки (заголовок окна, сообщения об отказе) и имена IPC-каналов.
 * Если хоть часть строк остаётся на месте, бинарник читается как оглавление
 * приложения — это проверяет npm run verify:package.
 */
const PROFILE_MAIN = {
  ...BASE,
  target: "node",
  stringArray: true,
  stringArrayThreshold: 1,
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
  unicodeEscapeSequence: true,
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
  stringArrayThreshold: 1,
  stringArrayEncoding: [],
  stringArrayRotate: true,
  stringArrayShuffle: true,
  splitStrings: true,
  splitStringsChunkLength: 12,
  controlFlowFlattening: false,
  deadCodeInjection: false,
  numbersToExpressions: true,
  transformObjectKeys: false,
  unicodeEscapeSequence: true,
  selfDefending: false,
};

function profileFor(relativePath) {
  if (relativePath === "preload.cjs") return { name: "preload", options: PROFILE_PRELOAD };
  if (relativePath === SHIELD_RELATIVE) return { name: "strict", options: PROFILE_STRICT };
  return { name: "main", options: PROFILE_MAIN };
}

/** Детерминированный seed: одна сборка — один результат. */
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

async function obfuscateAll(files) {
  const report = [];
  for (const relative of files) {
    const source = await readFile(path.join(SOURCE_ELECTRON, relative), "utf8");
    const profile = profileFor(relative);
    const code = obfuscate(source, relative);
    await writeFile(path.join(OUT_ELECTRON, relative), code, "utf8");
    report.push({ relative, profile: profile.name, source: source.length, output: code.length });
  }
  return report;
}

/* ── Самопроверка ────────────────────────────────────────────────────────── */

/**
 * Обфусцированные модули обязаны работать: проверяем их здесь, а не на машине
 * пользователя.
 */
async function selfTest({ electronFiles }) {
  const checks = [];
  const check = (name, condition, detail = "") => {
    checks.push({ name, ok: Boolean(condition), detail });
  };

  // 1. Синтаксис всех обфусцированных файлов (без выполнения: нужен Electron).
  for (const relative of electronFiles) {
    const code = await readFile(path.join(OUT_ELECTRON, relative), "utf8");
    try {
      new vm.Script(code, { filename: relative });
      check(`синтаксис ${relative}`, true);
    } catch (error) {
      check(`синтаксис ${relative}`, false, error.message);
    }
  }

  // 2. Модуль защиты от отладки: обфусцированная копия решает то же, что
  // исходник (main.cjs вызывает decideLaunch до создания окон).
  const hardenedShield = require(path.join(OUT_ELECTRON, SHIELD_RELATIVE));
  const cases = [
    { name: "чистый запуск", argv: [], env: {}, packaged: true, want: true },
    { name: "--inspect", argv: ["--inspect"], env: {}, packaged: true, want: false },
    { name: "--remote-debugging-port", argv: ["--remote-debugging-port=9222"], env: {}, packaged: true, want: false },
    { name: "переменная разработки", argv: [], env: { AGRO_DEV_SERVER: "http://localhost:5173" }, packaged: true, want: false },
    { name: "распакованная копия без исходников", argv: [], env: {}, packaged: false, want: false },
  ];
  for (const item of cases) {
    const hardened = hardenedShield.decideLaunch({ ...item, inspectorOpen: false, root: path.join(ROOT, "hardened") });
    const original = shield.decideLaunch({ ...item, inspectorOpen: false, root: path.join(ROOT, "hardened") });
    check(`shield: ${item.name}`, hardened.ok === item.want && hardened.ok === original.ok, `obf=${hardened.ok} src=${original.ok}`);
  }
  check("shield: инспектор ловится", hardenedShield.decideLaunch({ argv: [], env: {}, packaged: true, inspectorOpen: true }).ok === false);
  check("shield: защита webContents на месте", typeof hardenedShield.hardenWebContentsAgainstDebugging === "function");

  // 3. Обфусцированный код исполняется. main.cjs и preload.cjs без Electron не
  // запустить — поэтому здесь хотя бы синтаксис каждого файла и загрузка
  // preload с подставным electron: переименование имён (renameGlobals) ломает
  // код именно на этапе выполнения.
  const preload = loadObfuscatedPreload(path.join(OUT_ELECTRON, "preload.cjs"));
  check("preload грузится с подставным electron", preload.error === null, preload.error ?? "");
  if (preload.error === null) {
    const bridge = preload.bridge;
    check("preload раскрыл мост window.agro", Boolean(bridge) && bridge.isElectron === true);
    check(
      "preload: каналы данных в мосте",
      ["getAppInfo", "notifyReady", "readDatabase", "writeDatabase", "preserveDatabase", "saveFile"].every(
        (name) => typeof bridge?.[name] === "function",
      ),
    );

    await bridge.readDatabase();
    const readCall = preload.calls.find((call) => call.channel === "agro:read-database");
    check("preload: чтение базы доходит до main process", Boolean(readCall));

    // Санитайзеры ввода: мусор не должен уходить в main process.
    const badWrite = await bridge.writeDatabase("не байты");
    check("preload: некорректная запись отклонена на месте", badWrite?.ok === false && badWrite?.code === "INVALID_INPUT");
    const badFile = await bridge.saveFile({ fileName: "../../evil.txt", bytes: new Uint8Array([1]) });
    check("preload: имя файла с путём отклонено", badFile?.ok === false && badFile?.code === "INVALID_INPUT");
    check("preload: каналы отклонённых вызовов не дёргались", !preload.calls.some((call) => call.channel === "agro:save-file" && String(call.payload?.fileName ?? "").includes("..")));
  }

  return checks;
}

/**
 * Загрузка обфусцированного preload.cjs с подставным модулем electron.
 * Полноценного renderer'а нет, но contextBridge и ipcRenderer достаточно, чтобы
 * выполнить код и проверить, что мост window.agro остался целым.
 * @returns {{bridge:any, calls:Array<{channel:string, payload:any}>, error:string|null}}
 */
function loadObfuscatedPreload(file) {
  const Module = require("node:module");
  const calls = [];
  const sent = [];
  let bridge = null;

  const responses = {
    "agro:get-app-info": { version: "0.0.0", dev: false },
    "agro:read-database": { ok: true, bytes: new Uint8Array([1, 2, 3]) },
    "agro:write-database": { ok: true },
    "agro:preserve-database": { ok: true },
    "agro:save-file": { ok: true },
  };

  const electron = {
    contextBridge: {
      exposeInMainWorld(key, api) {
        if (key === "agro") bridge = api;
      },
    },
    ipcRenderer: {
      invoke(channel, payload) {
        calls.push({ channel, payload });
        return Promise.resolve(structuredClone(responses[channel] ?? { ok: false, code: "NO_STUB" }));
      },
      send(channel, ...rest) {
        sent.push({ channel, rest });
      },
      on() {},
      once() {},
      removeAllListeners() {},
    },
  };

  const originalLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === "electron") return electron;
    return originalLoad.apply(this, arguments);
  };
  try {
    delete require.cache[path.resolve(file)];
    require(file);
    return { bridge, calls, sent, error: null };
  } catch (error) {
    return { bridge: null, calls, sent, error: `${error?.message ?? error}` };
  } finally {
    Module._load = originalLoad;
  }
}

/* ── Запуск ──────────────────────────────────────────────────────────────── */

const startedAt = process.hrtime.bigint();
console.log("• harden: obfuscation");

await prepareOutput();
const sourceFiles = await copySources();
console.log(`• скопировано файлов main process: ${sourceFiles.length}`);

const report = await obfuscateAll(sourceFiles);

const checks = await selfTest({ electronFiles: await walk(OUT_ELECTRON) });
const failed = checks.filter((check) => !check.ok);
for (const check of checks) {
  if (!check.ok) console.error(`  ✘ ${check.name}${check.detail ? ` — ${check.detail}` : ""}`);
}
if (failed.length) fail(`самопроверка не прошла: ${failed.length} из ${checks.length}`);
console.log(`• самопроверка: ${checks.length} проверок пройдено`);

const totalIn = report.reduce((sum, item) => sum + item.source, 0);
const totalOut = report.reduce((sum, item) => sum + item.output, 0);
for (const item of report) {
  console.log(`  ${item.relative.padEnd(28)} ${item.profile.padEnd(8)} ${(item.source / 1024).toFixed(1)} КБ → ${(item.output / 1024).toFixed(1)} КБ`);
}
console.log(`• итог: ${(totalIn / 1024).toFixed(0)} КБ исходников → ${(totalOut / 1024).toFixed(0)} КБ защищённого кода`);
console.log(`• готово за ${(Number(process.hrtime.bigint() - startedAt) / 1e9).toFixed(1)} с → ${path.relative(ROOT, OUT_DIR)}/electron\n`);
