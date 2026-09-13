/**
 * Проверка условий запуска и защита от отладки (main process).
 *
 * Electron удобно взламывать, не трогая сам код приложения: достаточно
 * запустить его с `--inspect`, подсунуть `NODE_OPTIONS=--require ./patch.js`,
 * выставить `ELECTRON_RUN_AS_NODE` и получить REPL с правами процесса или
 * подключить отладчик к renderer'у. Здесь эти пути закрываются на уровне
 * запуска — до создания окон. Основной слой всё же не этот файл, а
 * electronFuses в package.json (RunAsNode, NodeOptions, NodeCliInspect
 * выключаются в самом бинарнике, и обойти их правкой JavaScript нельзя).
 *
 * Модуль намеренно «чистый»: решения принимаются по переданным argv/env,
 * поэтому их можно проверить unit-тестами без Electron.
 */

"use strict";

const fs = require("node:fs");
const path = require("node:path");

/**
 * Командные переключатели, которые дают отладчику или инъекции доступ к
 * процессу. Проверяются только в упакованном приложении: в разработке
 * --inspect — обычный рабочий инструмент.
 */
const BANNED_SWITCHES = Object.freeze([
  "inspect",
  "inspect-brk",
  "inspect-port",
  "inspect-publish-uid",
  "remote-debugging-port",
  "remote-debugging-pipe",
  "remote-debugging-address",
  "js-flags",
  "allow-file-access-from-files",
  "disable-web-security",
  "unsafely-treat-insecure-origin-as-secure",
]);

/**
 * Переменные окружения, которыми можно подменить код процесса извне.
 * Основную защиту даёт не этот список, а electronFuses (RunAsNode и NodeOptions
 * выключены в самом бинарнике): здесь — второй слой и внятная диагностика.
 * Отказывать в запуске по ним нельзя: NODE_OPTIONS встречается у разработчиков
 * как общесистемная переменная, а на приложение после фьюзов она не влияет.
 */
const SUSPECT_ENV = Object.freeze([
  "ELECTRON_RUN_AS_NODE",
  "NODE_OPTIONS",
  "NODE_REPL_EXTERNAL_MODULE",
  "ELECTRON_EXTRA_LAUNCH_ARGS",
]);

/**
 * Внутренние переменные разработки. В упакованном приложении их быть не может —
 * это всегда попытка запустить приложение в «развёрнутом» режиме: AGRO_DEV
 * разрешает запуск из исходников, AGRO_DEV_SERVER подменяет адрес загрузки окна.
 * Случайно такие имена не появляются, поэтому по ним запуск прерывается.
 */
const DEV_ENV = Object.freeze(["AGRO_DEV", "AGRO_DEV_SERVER", "AGRO_LICENSE_DISABLED"]);

/** Файл, который есть только в исходниках и отсутствует внутри app.asar. */
const SOURCE_MARKER = "vite.config.js";

function switchName(argument) {
  const text = String(argument ?? "");
  if (!text.startsWith("--")) return null;
  const body = text.slice(2);
  const eq = body.indexOf("=");
  return (eq === -1 ? body : body.slice(0, eq)).toLowerCase();
}

/**
 * @param {object} params
 * @param {string[]} params.argv аргументы процесса
 * @param {NodeJS.ProcessEnv} params.env окружение
 * @param {boolean} params.packaged app.isPackaged
 * @param {boolean} [params.inspectorOpen] подключён ли инспектор к main-процессу
 * @param {string} [params.root] корень приложения
 * @returns {{ok:boolean, problems:string[], allowUnpacked:boolean}}
 */
function inspectLaunchEnvironment({ argv = [], env = {}, packaged = true, inspectorOpen = false, root = "" }) {
  const problems = [];
  const warnings = [];

  // Инспектор запрещён всегда: в рабочем приложении ему взяться неоткуда.
  if (inspectorOpen) problems.push("inspector");

  if (packaged) {
    // В разработке --inspect — обычный инструмент, в упаковке — способ
    // перехватить процесс, поэтому переключатели проверяются только здесь.
    for (const argument of argv) {
      const name = switchName(argument);
      if (name && BANNED_SWITCHES.includes(name)) problems.push(`--${name}`);
    }

    for (const name of SUSPECT_ENV) {
      const value = env[name];
      if (typeof value === "string" && value.trim().length > 0) warnings.push(name);
    }
    for (const name of DEV_ENV) {
      const value = env[name];
      if (typeof value === "string" && value.trim().length > 0) problems.push(name);
    }
  }

  // Запуск не из упаковки допустим только в исходниках разработчика:
  // там рядом лежит vite.config.js, а в распакованном app.asar его нет.
  const sourceCheckout = Boolean(root) && fs.existsSync(path.join(root, SOURCE_MARKER));
  const allowUnpacked = !packaged && (sourceCheckout || env.AGRO_DEV === "1");

  return {
    ok: problems.length === 0,
    problems: [...new Set(problems)],
    warnings: [...new Set(warnings)],
    allowUnpacked,
    sourceCheckout,
  };
}

/**
 * Полное решение о запуске: либо приложение стартует, либо причина отказа.
 * @returns {{ok:boolean, problems:string[]}}
 */
function decideLaunch({ argv = [], env = {}, packaged = true, inspectorOpen = false, root = "" }) {
  const inspected = inspectLaunchEnvironment({ argv, env, packaged, inspectorOpen, root });
  if (!inspected.ok) return { ok: false, problems: inspected.problems, warnings: inspected.warnings };
  if (!packaged && !inspected.allowUnpacked) {
    return { ok: false, problems: ["unpacked-without-source"], warnings: inspected.warnings };
  }
  return { ok: true, problems: [], warnings: inspected.warnings };
}

/**
 * Защита webContents: отладчик в упакованном приложении не открывается совсем
 * (devTools: false в webPreferences), а здесь закрываются оставшиеся пути —
 * программное открытие и повторные попытки.
 *
 * @param {import("electron").WebContents} contents
 * @param {{packaged:boolean, onViolation?:()=>void, log?:(...args:any[])=>void}} options
 */
function hardenWebContentsAgainstDebugging(contents, { packaged, onViolation, log = () => {} }) {
  if (!packaged) return () => {};
  let violations = 0;
  const onDevtoolsOpened = () => {
    violations += 1;
    log(`shield: попытка открыть инструменты разработчика (${violations})`);
    try {
      contents.closeDevTools();
    } catch {
      /* уже закрыто */
    }
    if (violations >= 2) onViolation?.();
  };
  const onDevtoolsFocused = () => onDevtoolsOpened();
  contents.on("devtools-opened", onDevtoolsOpened);
  contents.on("devtools-focused", onDevtoolsFocused);
  return () => {
    contents.removeListener("devtools-opened", onDevtoolsOpened);
    contents.removeListener("devtools-focused", onDevtoolsFocused);
  };
}

module.exports = {
  BANNED_SWITCHES,
  DEV_ENV,
  SUSPECT_ENV,
  SOURCE_MARKER,
  decideLaunch,
  hardenWebContentsAgainstDebugging,
  inspectLaunchEnvironment,
  switchName,
};
