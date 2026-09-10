/** Форматирование чисел, дат и подписей. Никаких сторонних библиотек. */

import { isValidIsoDate } from "../../calculations/date-period.js";

export const MONTHS_NOMINATIVE = Object.freeze([
  "январь",
  "февраль",
  "март",
  "апрель",
  "май",
  "июнь",
  "июль",
  "август",
  "сентябрь",
  "октябрь",
  "ноябрь",
  "декабрь",
]);

export const MONTHS_GENITIVE = Object.freeze([
  "января",
  "февраля",
  "марта",
  "апреля",
  "мая",
  "июня",
  "июля",
  "августа",
  "сентября",
  "октября",
  "ноября",
  "декабря",
]);

export const MONTHS_SHORT = Object.freeze([
  "янв",
  "фев",
  "мар",
  "апр",
  "май",
  "июн",
  "июл",
  "авг",
  "сен",
  "окт",
  "ноя",
  "дек",
]);

export const WEEKDAYS_SHORT = Object.freeze(["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"]);

export const NOT_AVAILABLE = "—";

/** Русские множественные формы. */
export function plural(count, forms) {
  const n = Math.abs(Math.trunc(count));
  const mod10 = n % 10;
  const mod100 = n % 100;
  let index = 2;
  if (mod10 === 1 && mod100 !== 11) index = 0;
  else if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) index = 1;
  return forms[index] ?? forms[2];
}

export function withCount(count, forms) {
  return `${fmtInt(count)} ${plural(count, forms)}`;
}

export function fmtInt(value) {
  if (!Number.isFinite(value)) return NOT_AVAILABLE;
  return new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 0 }).format(value);
}

/** Число с фиксированным числом знаков; null/NaN → «—». */
export function fmtNum(value, digits = 1) {
  if (typeof value !== "number" || !Number.isFinite(value)) return NOT_AVAILABLE;
  return new Intl.NumberFormat("ru-RU", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(value);
}

/** Со знаком плюс для температур около нуля. */
export function fmtSigned(value, digits = 1) {
  if (typeof value !== "number" || !Number.isFinite(value)) return NOT_AVAILABLE;
  const sign = value > 0 ? "+" : "";
  return sign + fmtNum(value, digits);
}

/** Пять знаков после запятой — только для отображения. */
export function fmtCoord(lat, lon, digits = 5) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return NOT_AVAILABLE;
  return `${lat.toFixed(digits)}, ${lon.toFixed(digits)}`;
}

export function fmtCoordPair(lat, lon) {
  return fmtCoord(lat, lon);
}

export function fmtDateRu(iso) {
  if (!isValidIsoDate(iso)) return NOT_AVAILABLE;
  const [y, m, d] = iso.split("-");
  return `${d}.${m}.${y}`;
}

export function fmtDateRuShort(iso) {
  if (!isValidIsoDate(iso)) return NOT_AVAILABLE;
  const [y, m, d] = iso.split("-");
  return `${Number(d)} ${MONTHS_SHORT[Number(m) - 1]}`;
}

/** Метка дня для оси графика: «1 июн». */
export function fmtDateAxis(iso) {
  return fmtDateRuShort(iso);
}

/** Из ISO-8601 с временем (UTC) — локальные дата и время для колонок «Создан». */
export function fmtDateTimeRu(isoTimestamp) {
  const date = new Date(isoTimestamp);
  if (!Number.isFinite(date.getTime())) return NOT_AVAILABLE;
  const pad = (n) => String(n).padStart(2, "0");
  return (
    `${pad(date.getDate())}.${pad(date.getMonth() + 1)}.${date.getFullYear()}` +
    ` ${pad(date.getHours())}:${pad(date.getMinutes())}`
  );
}

export function monthLabel(year, monthOneBased) {
  return `${MONTHS_NOMINATIVE[monthOneBased - 1] ?? "?"} ${year}`;
}

export function fmtPeriodRu(startDate, endDate) {
  if (!isValidIsoDate(startDate) || !isValidIsoDate(endDate)) return NOT_AVAILABLE;
  return `${fmtDateRu(startDate)} — ${fmtDateRu(endDate)}`;
}

export function fmtRangeMonths(months) {
  return `${months} мес.`;
}

/** Число с единицей: «12,4 °C». */
export function fmtWithUnit(value, unit, digits = 1) {
  const text = fmtNum(value, digits);
  if (text === NOT_AVAILABLE) return NOT_AVAILABLE;
  return unit ? `${text} ${unit}` : text;
}
