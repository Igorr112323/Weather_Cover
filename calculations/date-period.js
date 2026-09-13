/**
 * Календарная арифметика для расчёта периода прогноза.
 *
 * Модуль не зависит от DOM, Electron, Leaflet и Chart.js — его используют
 * и демонстрационный движок, и интерфейс. Даты считаются по календарным дням
 * в UTC, поэтому часовой пояс пользователя не сдвигает даты.
 *
 * Формат даты — строка "YYYY-MM-DD".
 */

const MS_PER_DAY = 86400000;
const MONTH_LENGTHS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function isLeapYear(y) {
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
}

/** @param {number} y @param {number} m месяц 1..12 */
export function daysInMonth(y, m) {
  if (!Number.isInteger(y) || !Number.isInteger(m) || m < 1 || m > 12) return 0;
  return m === 2 && isLeapYear(y) ? 29 : MONTH_LENGTHS[m - 1];
}

/** Строка "YYYY-MM-DD" без проверки существования даты. */
export function isoFromParts(y, m, d) {
  return `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/** @returns {{y:number,m:number,d:number}|null} */
export function parseIsoDate(value) {
  if (typeof value !== "string") return null;
  const match = ISO_RE.exec(value.trim());
  if (!match) return null;
  const y = Number(match[1]);
  const m = Number(match[2]);
  const d = Number(match[3]);
  if (m < 1 || m > 12) return null;
  if (d < 1 || d > daysInMonth(y, m)) return null;
  return { y, m, d };
}

export function isValidIsoDate(value) {
  return parseIsoDate(value) !== null;
}

/** Порядковый номер дня, epoch = 1970-01-01. */
export function toOrdinal(iso) {
  const p = parseIsoDate(iso);
  if (!p) return NaN;
  return Math.round(Date.UTC(p.y, p.m - 1, p.d) / MS_PER_DAY);
}

/** @returns {{y:number,m:number,d:number}} */
export function fromOrdinal(ordinal) {
  const date = new Date(Math.trunc(ordinal) * MS_PER_DAY);
  return { y: date.getUTCFullYear(), m: date.getUTCMonth() + 1, d: date.getUTCDate() };
}

/** Прибавляет дни. Аргумент может быть отрицательным. */
export function addDays(iso, days) {
  const n = Math.trunc(Number(days));
  if (!Number.isFinite(n)) throw new RangeError(`Некорректное число дней: ${String(days)}`);
  const ordinal = toOrdinal(iso);
  if (!Number.isFinite(ordinal)) throw new RangeError(`Некорректная дата: ${String(iso)}`);
  const p = fromOrdinal(ordinal + n);
  return isoFromParts(p.y, p.m, p.d);
}

/**
 * Прибавляет календарные месяцы. День ограничивается последним днём
 * целевого месяца: 31.01 + 1 мес. = 28.02 (29.02 в високосном году).
 */
export function addMonths(iso, months) {
  const p = parseIsoDate(iso);
  if (!p) throw new RangeError(`Некорректная дата: ${String(iso)}`);
  const n = Math.trunc(Number(months));
  if (!Number.isFinite(n)) throw new RangeError(`Некорректное число месяцев: ${String(months)}`);

  const zeroBased = p.m - 1 + n;
  let y = p.y + Math.floor(zeroBased / 12);
  let m = zeroBased - Math.floor(zeroBased / 12) * 12 + 1;
  if (m < 1) {
    m += 12;
    y -= 1;
  }
  return isoFromParts(y, m, Math.min(p.d, daysInMonth(y, m)));
}

/**
 * Период прогноза: начало включительно, конец — день перед начальной датой
 * плюс выбранное число месяцев.
 *
 * @returns {{startDate:string, endDate:string, days:number}}
 */
export function computePeriod(startDate, rangeMonths) {
  const months = Math.trunc(Number(rangeMonths));
  if (![1, 3, 6].includes(months)) {
    throw new RangeError(`Период должен быть 1, 3 или 6 месяцев, получено ${String(rangeMonths)}`);
  }
  if (!isValidIsoDate(startDate)) {
    throw new RangeError(`Некорректная дата начала: ${String(startDate)}`);
  }
  const endDate = addDays(addMonths(startDate, months), -1);
  return {
    startDate,
    endDate,
    days: toOrdinal(endDate) - toOrdinal(startDate) + 1,
  };
}

/** Первый день месяца указанной даты: "2026-09-17" → "2026-09-01". */
export function startOfMonth(iso) {
  const p = parseIsoDate(iso);
  if (!p) throw new RangeError(`Некорректная дата: ${String(iso)}`);
  return isoFromParts(p.y, p.m, 1);
}

/**
 * Порядковый номер месяца (год × 12 + месяц − 1): сравнение и арифметика
 * «по месяцам» без учёта дней. Для некорректной даты — NaN.
 */
export function monthIndex(iso) {
  const p = parseIsoDate(iso);
  if (!p) return NaN;
  return p.y * 12 + (p.m - 1);
}

/** Обратное преобразование: номер месяца → первый день этого месяца. */
export function isoFromMonthIndex(index) {
  const n = Math.trunc(Number(index));
  if (!Number.isFinite(n) || n < 0) throw new RangeError(`Некорректный номер месяца: ${String(index)}`);
  return isoFromParts(Math.floor(n / 12), (n % 12) + 1, 1);
}

/** Список дат отрезка включительно. */
export function listDates(startDate, endDate) {
  const start = toOrdinal(startDate);
  const end = toOrdinal(endDate);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return [];
  const out = [];
  for (let o = start; o <= end; o += 1) {
    const p = fromOrdinal(o);
    out.push(isoFromParts(p.y, p.m, p.d));
  }
  return out;
}

/** Индекс столбца недели, где 0 — понедельник. */
export function weekdayIndexMonday(iso) {
  const p = parseIsoDate(iso);
  if (!p) return 0;
  return (new Date(Date.UTC(p.y, p.m - 1, p.d)).getUTCDay() + 6) % 7;
}

/** Календарное «сегодня» в локальной зоне пользователя. */
export function todayIso(now = new Date()) {
  return isoFromParts(now.getFullYear(), now.getMonth() + 1, now.getDate());
}
