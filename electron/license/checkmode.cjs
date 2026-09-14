/**
 * Проверочный режим запуска (main process).
 *
 * Зачем: лицензия хранится в профиле приложения (`%APPDATA%\AgroPrognoz`), и
 * этот профиль ОБЩИЙ у всех копий программы на компьютере. Поэтому свежескачанный
 * EXE на уже активированной машине молча стартует активированным — экран ввода
 * кода больше не увидеть. Проверить активацию «по-честному» у себя на компьютере
 * при этом невозможно: файл лицензии-то один на все копии.
 *
 * Решение: у каждой ПРОВЕРОЧНОЙ копии своя песочница и свой файл лицензии.
 * Копия считается проверочной, если выполнено любое из условий:
 *
 *   1. файл программы называется `AgroPrognoz-check-<id>.exe`
 *      ( portable-сборка смотрит имя исходного файла, которое передаёт NSIS
 *      через AGRO_PORTABLE_EXE — см. scripts/patch-portable-nsi.mjs);
 *   2. задан переключатель `--check-instance=<id>` или просто `--check`;
 *   3. задана переменная окружения `AGRO_CHECK_INSTANCE=<id>`.
 *
 * Что это меняет ровно одно: имя файла лицензии (`agroprognoz-check-<id>.license`
 * вместо `agroprognoz.license`), то есть у проверочной копии нет уже сохранённой
 * лицензии, и она обязана запросить код. Больше ничего: подпись кода, привязка
 * к компьютеру, проверка целостности и отзывы работают так же. Обойти
 * активацию этим режимом нельзя — можно только заставить приложение ЧЕСТНО
 * спросить код ещё раз. Для базы данных каталог профиля остаётся общим:
 * проверочная копия видит те же данные, что и основная.
 *
 * Модуль не трогает Electron (только `node:path`), поэтому решётку режимов
 * проверяют unit-тесты в обычном Node (tests/activation-doctor.test.mjs).
 */

"use strict";

const path = require("node:path");

/** Имя файла лицензии по умолчанию — как его описывает license/store.cjs. */
const LICENSE_FILE_NAME = "agroprognoz.license";
/** Префикс имени проверочного EXE (регистр не важен). */
const CHECK_EXE_PREFIX = "agroprognoz-check-";
/** Идентификатор экземпляра: только безопасные символы, чтобы имя файла было предсказуемым. */
const INSTANCE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/;
/** Значение по умолчанию для `--check` без идентификатора. */
const DEFAULT_INSTANCE = "check";
/** Переключатели и переменные окружения, которыми включается режим. */
const FLAG_WITH_VALUE = "--check-instance";
const FLAG_PLAIN = "--check";
const ENV_NAME = "AGRO_CHECK_INSTANCE";
/** Переменная, которую portable-сборка NSIS заполняет путём скачанного файла. */
const ENV_PORTABLE_EXE = "AGRO_PORTABLE_EXE";

/**
 * Приводит произвольную строку к идентификатору экземпляра или возвращает "".
 * Пробелы превращаются в «-», всё, что не входит в разрешённый набор,
 * отбрасывается: имя файла лицензии всегда безопасно для файловой системы.
 */
function sanitizeInstance(raw) {
  const text = String(raw ?? "").trim().replace(/\s+/g, "-");
  if (!text) return "";
  const cleaned = text.replace(/[^A-Za-z0-9_-]/g, "").replace(/^[-_]+/, "");
  return INSTANCE_PATTERN.test(cleaned) ? cleaned : "";
}

/** Значение переключателя вида `--check-instance=ID` или `--check-instance ID`. */
function readFlag(argv, name) {
  const list = Array.isArray(argv) ? argv : [];
  const prefix = `${name}=`;
  for (let index = 0; index < list.length; index += 1) {
    const item = String(list[index] ?? "");
    if (item.startsWith(prefix)) return item.slice(prefix.length);
    if (item === name) {
      const next = String(list[index + 1] ?? "");
      // Следующий токен — другой переключатель: значит значение не передано.
      return next.startsWith("--") ? "" : next;
    }
  }
  return null;
}

/** Идентификатор из имени файла программы: `AgroPrognoz-check-<id>.exe`. */
function instanceFromExePath(execPath) {
  const name = String(execPath ?? "").split(/[\\/]/).pop().toLowerCase();
  if (!name.endsWith(".exe")) return "";
  const base = name.slice(0, -".exe".length);
  if (!base.startsWith(CHECK_EXE_PREFIX)) return "";
  return sanitizeInstance(base.slice(CHECK_EXE_PREFIX.length));
}

/**
 * Определяет проверочный режим по аргументам, окружению и имени программы.
 * Приоритет: явный переключатель → переменная окружения → имя EXE.
 *
 * @param {{argv?:string[], env?:object, execPath?:string}} [options]
 * @returns {{instance:string, source:string|null}} instance === "" — режим выключен
 */
function resolveCheckInstance(options = {}) {
  const env = options.env ?? process.env;

  const flagged = readFlag(options.argv ?? process.argv, FLAG_WITH_VALUE);
  if (flagged !== null) {
    const instance = sanitizeInstance(flagged) || DEFAULT_INSTANCE;
    return { instance, source: "flag" };
  }
  const plain = readFlag(options.argv ?? process.argv, FLAG_PLAIN);
  if (plain !== null) {
    return { instance: sanitizeInstance(plain) || DEFAULT_INSTANCE, source: "flag" };
  }

  const fromEnv = sanitizeInstance(env[ENV_NAME]);
  if (fromEnv) return { instance: fromEnv, source: "env" };

  // Сначала — исходное имя скачанного файла (его знает только portable-сборка),
  // потом — имя самого процесса: оно подходит для win-unpacked и разработки.
  const portable = instanceFromExePath(env[ENV_PORTABLE_EXE]);
  if (portable) return { instance: portable, source: "exe-name" };
  const fromExe = instanceFromExePath(options.execPath ?? process.execPath);
  if (fromExe) return { instance: fromExe, source: "exe-name" };

  return { instance: "", source: null };
}

/** Имя файла лицензии для экземпляра: "" → обычный общий файл. */
function licenseFileNameFor(instance) {
  const clean = sanitizeInstance(instance);
  return clean ? `agroprognoz-check-${clean}.license` : LICENSE_FILE_NAME;
}

/** Короткая строка в лог main process (без русских букв — лог читается в консоли Windows). */
function describeCheckInstance({ instance, source }) {
  if (!instance) return "";
  return `check mode on: instance "${instance}" via ${source ?? "unknown"}`;
}

module.exports = {
  CHECK_EXE_PREFIX,
  DEFAULT_INSTANCE,
  ENV_NAME,
  ENV_PORTABLE_EXE,
  FLAG_PLAIN,
  FLAG_WITH_VALUE,
  LICENSE_FILE_NAME,
  describeCheckInstance,
  instanceFromExePath,
  licenseFileNameFor,
  readFlag,
  resolveCheckInstance,
  sanitizeInstance,
};
