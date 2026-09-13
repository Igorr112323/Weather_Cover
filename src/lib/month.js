/**
 * Месяц как значение: форматирование и разбор ввода без DOM.
 *
 * Значение месяца всюду — ISO-дата первого числа ("YYYY-MM-01"), поэтому
 * движок прогноза и архив работают с обычной датой, а интерфейс показывает
 * только месяц и год.
 */

import { isValidIsoDate } from "../../calculations/date-period.js";
import { MONTHS_GENITIVE, MONTHS_NOMINATIVE, MONTHS_SHORT } from "./format.js";

/** «Сентябрь 2026» — подпись месяца в поле и подсказках. */
export function fmtMonthRu(iso) {
  if (!isValidIsoDate(iso)) return "";
  const name = MONTHS_NOMINATIVE[Number(iso.slice(5, 7)) - 1];
  return `${name.charAt(0).toUpperCase()}${name.slice(1)} ${iso.slice(0, 4)}`;
}

/**
 * Разбирает ввод пользователя: «09.2026», «9/2026», «2026-09», «сентябрь 2026», «сен 2026».
 * @returns {{ok:true,value:string}|{ok:false,error:string}} value — "YYYY-MM-01"
 */
export function parseUserMonth(raw) {
  const text = String(raw ?? "")
    .trim()
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/\s+/g, " ");
  if (!text) return { ok: false, error: "Укажите месяц и год" };

  const numeric = /^(\d{1,2})[.\/\-\s](\d{4})$/.exec(text);
  if (numeric) return monthResult(Number(numeric[2]), Number(numeric[1]));

  const isoLike = /^(\d{4})[.\/\-\s](\d{1,2})(?:[.\/\-\s]\d{1,2})?$/.exec(text);
  if (isoLike) return monthResult(Number(isoLike[1]), Number(isoLike[2]));

  const words = /^([а-я]+)\.? (\d{4})$/.exec(text);
  if (words) {
    const name = words[1];
    let month = MONTHS_NOMINATIVE.indexOf(name);
    if (month < 0) month = MONTHS_GENITIVE.indexOf(name);
    if (month < 0) month = MONTHS_SHORT.indexOf(name);
    if (month < 0 && name.length >= 3) month = MONTHS_NOMINATIVE.findIndex((label) => label.startsWith(name));
    if (month >= 0) return monthResult(Number(words[2]), month + 1);
    return { ok: false, error: "Не удалось распознать месяц" };
  }
  return { ok: false, error: "Формат: мм.гггг" };
}

function monthResult(year, month) {
  if (!Number.isInteger(month) || month < 1 || month > 12) return { ok: false, error: "Месяц — число от 1 до 12" };
  if (!Number.isInteger(year) || year < 1 || year > 9999) return { ok: false, error: "Такого года нет" };
  return { ok: true, value: `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-01` };
}
