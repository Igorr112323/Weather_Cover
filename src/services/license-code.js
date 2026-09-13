/**
 * Форматирование кода активации на стороне интерфейса.
 *
 * Модуль без DOM и без импортов: его можно проверить обычными unit-тестами
 * (tests/license.test.mjs), что важно — экран активации человек видит ровно в
 * тот момент, когда ошибиться нельзя.
 *
 * Правила совпадают с проверкой в main process (electron/license/core.cjs):
 * регистр не важен, разделители не важны, I/L читаются как 1, O — как 0.
 * Здесь это только приведение к печатному виду «AGRO-XXXXXXXX-XXXXXXXX-…»,
 * само решение принимает main process.
 */

/** Длина тела кода: 80 байт лицензии → 128 символов base32. */
export const CODE_BODY_LENGTH = 128;
/** Размер группы в печатном виде. */
export const GROUP_SIZE = 8;
/** Префикс кода. */
export const CODE_PREFIX = "AGRO";

const ALIASES = { I: "1", L: "1", O: "0" };
const NOT_ALLOWED = /[^0-9A-Z]/g;

/**
 * Тело кода из произвольного ввода: без префикса, без разделителей, с поправкой
 * на опечатки и обрезкой до нужной длины. Все функции ниже считают именно тело,
 * поэтому префикс «AGRO-» никогда не попадает в счётчик символов.
 * @param {string} raw
 * @returns {string}
 */
export function codeBody(raw) {
  return String(raw ?? "")
    .toUpperCase()
    .replace(NOT_ALLOWED, "")
    .replace(/^AGR[O0]/, "")
    .replace(/[ILO]/g, (char) => ALIASES[char] ?? char)
    .slice(0, CODE_BODY_LENGTH);
}

/**
 * Приведение введённого/вставленного текста к печатному виду кода.
 * Пустой ввод даёт пустую строку (а не «AGRO-»), чтобы поле не «жило своей жизнью».
 * @param {string} raw
 * @returns {string}
 */
export function formatCodeText(raw) {
  const body = codeBody(raw);
  if (!body) return "";
  const groups = body.match(new RegExp(`.{1,${GROUP_SIZE}}`, "g")) ?? [];
  return `${CODE_PREFIX}-${groups.join("-")}`;
}

/** Сколько символов тела кода уже введено (0…128). */
export function codeProgress(raw) {
  return codeBody(raw).length;
}

/** Код введён целиком — можно активировать. */
export function isCodeComplete(raw) {
  return codeBody(raw).length === CODE_BODY_LENGTH;
}

/** Короткое описание для человека: чего не хватает. */
export function codeHint(raw) {
  const filled = codeProgress(raw);
  if (filled === 0) return "Введите или вставьте код активации.";
  if (filled < CODE_BODY_LENGTH) return `Не хватает символов: ${filled} из ${CODE_BODY_LENGTH}.`;
  return "Код введён целиком.";
}
