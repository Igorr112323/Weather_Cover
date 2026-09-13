/**
 * Диапазон доступных месяцев начала периода: январь 1990 … текущий месяц.
 *
 * Будущее недоступно — прогноз строится от прошлого и текущего месяца.
 * Значение месяца — ISO-дата первого числа ("YYYY-MM-01"), поэтому движку
 * и архиву не нужно ничего знать о «месяцах» как отдельной сущности.
 */

import { isValidIsoDate, monthIndex, startOfMonth, todayIso } from "./date-period.js";

/** Самый ранний доступный месяц. */
export const EARLIEST_MONTH = "1990-01-01";

/** Текущий месяц (первое число) — самый поздний доступный. */
export function currentMonthIso(now = new Date()) {
  return startOfMonth(todayIso(now));
}

/** @returns {{minMonth:string, maxMonth:string}} */
export function monthRange(now = new Date()) {
  return { minMonth: EARLIEST_MONTH, maxMonth: currentMonthIso(now) };
}

/**
 * Приводит сохранённое значение к допустимому месяцу.
 * Некорректная дата → текущий месяц (adjusted: false — нечего было сохранять);
 * дата вне диапазона → текущий месяц (adjusted: true — пользователю стоит сказать).
 *
 * @returns {{value:string, adjusted:boolean}}
 */
export function normalizeStartMonth(saved, now = new Date()) {
  const { minMonth, maxMonth } = monthRange(now);
  if (!isValidIsoDate(saved)) return { value: maxMonth, adjusted: false };
  const month = startOfMonth(saved);
  const index = monthIndex(month);
  if (index < monthIndex(minMonth) || index > monthIndex(maxMonth)) return { value: maxMonth, adjusted: true };
  return { value: month, adjusted: false };
}
