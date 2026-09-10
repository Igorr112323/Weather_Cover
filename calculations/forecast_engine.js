/**
 * Демонстрационный движок прогноза.
 *
 * ТОЧКА ЗАМЕНИЯ РЕАЛЬНЫХ РАСЧЁТОВ. Приложение знает только про
 * generateForecast(request) и validateForecastRequest(request), поэтому
 * переход на реальные вычисления — это правка этого файла (или подмена
 * импорта в src/services/forecast-service.js). Остальное приложение не меняется.
 *
 * Что здесь реализовано:
 *   - детерминированный синтетический суточный ряд погоды;
 *   - средние показатели, посчитанные из самого ряда;
 *   - risksStatus: "notCalculated" (риски не выдумываются).
 *
 * Чего здесь сознательно нет:
 *   - Math.random() и значений, меняющихся при каждом открытии;
 *   - суммы активных температур (САТ) и гидро­термического коэффициента (ГТК);
 *   - агрономических рекомендаций.
 *
 * Числа синтетические и не описывают реальную погоду.
 *
 * Зависимость только от ./date-period.js — без DOM, Electron, Leaflet, Chart.js.
 */

import { computePeriod, isValidIsoDate, listDates, toOrdinal } from "./date-period.js";

export const SCHEMA_VERSION = 1;
export const ENGINE_VERSION = "demo-1";
export const ENGINE_MODE = "demo";
export const ALLOWED_RANGE_MONTHS = Object.freeze([1, 3, 6]);

/**
 * Опорные климатические значения демонстрации по |широте|. Задают плавный
 * рост годовой амплитуды и снижение среднегодовой температуры к северу.
 */
const CLIMATE_ANCHORS = Object.freeze([
  { latAbs: 0, mean: 25.5, amplitude: 2.5 },
  { latAbs: 15, mean: 23.0, amplitude: 6.5 },
  { latAbs: 30, mean: 16.5, amplitude: 10.5 },
  { latAbs: 45, mean: 10.5, amplitude: 12.5 },
  { latAbs: 55, mean: 6.0, amplitude: 14.5 },
  { latAbs: 62, mean: 2.5, amplitude: 16.5 },
  { latAbs: 68, mean: -3.5, amplitude: 18.5 },
]);

/** Внутригодовое распределение осадков, множители по месяцам 1..12. */
const RAIN_MONTH_FACTOR = Object.freeze([0.6, 0.6, 0.8, 0.9, 1.15, 1.3, 1.25, 1.1, 0.95, 0.8, 0.7, 0.65]);

const WARMEST_DAY_OF_YEAR = 197; // середина июля — пик синусоиды сезона
const YEAR_LENGTH = 365.25;

const LIMITS = Object.freeze({
  lat: 90,
  lon: 180,
  varietyIdMax: 64,
  varietyNameMax: 200,
  precipitationMaxMm: 400,
});

function clamp(value, min, max) {
  return value < min ? min : value > max ? max : value;
}

/** Округление без «-0» и без накопления ошибок плавающей точки в CSV. */
function round(value, digits = 1) {
  if (!Number.isFinite(value)) return 0;
  const factor = 10 ** digits;
  const scaled = Math.round(value * factor + Number.EPSILON) / factor;
  return Object.is(scaled, -0) ? 0 : scaled;
}

/** FNV-1a 32 бита со смешиванием. Одна и та же строка — одно и то же число. */
function hash32(input) {
  const text = String(input);
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  h ^= h >>> 15;
  h = Math.imul(h, 0x5bd1e995) >>> 0;
  h ^= h >>> 13;
  return h >>> 0;
}

/** Детерминированное число [0, 1) от строки-семени. */
function unit(seed) {
  return hash32(seed) / 4294967296;
}

function lerpClimate(latAbs) {
  const lat = clamp(Math.abs(latAbs), 0, CLIMATE_ANCHORS[CLIMATE_ANCHORS.length - 1].latAbs);
  let low = CLIMATE_ANCHORS[0];
  let high = CLIMATE_ANCHORS[CLIMATE_ANCHORS.length - 1];
  for (let i = 0; i < CLIMATE_ANCHORS.length - 1; i += 1) {
    const next = CLIMATE_ANCHORS[i + 1];
    if (lat >= CLIMATE_ANCHORS[i].latAbs && lat <= next.latAbs) {
      low = CLIMATE_ANCHORS[i];
      high = next;
      break;
    }
  }
  const span = high.latAbs - low.latAbs || 1;
  const t = clamp((lat - low.latAbs) / span, 0, 1);
  return {
    mean: low.mean + (high.mean - low.mean) * t,
    amplitude: low.amplitude + (high.amplitude - low.amplitude) * t,
  };
}

/** «Климат» точки: считается один раз на запрос и определяет весь ряд. */
function locationProfile(key, lat, lon) {
  const latAbs = Math.abs(lat);
  const base = lerpClimate(latAbs);
  const continentality = clamp((lon - 20) / 80, 0, 1);
  return {
    latAbs,
    continentality,
    annualMean: base.mean + (unit(`${key}|site`) - 0.5) * 2.4 - 2.2 * continentality,
    amplitude: base.amplitude * (1 + 0.35 * continentality),
    monthlyPrecipitationMm: clamp(34 + 30 * unit(`${key}|mp`) - 10 * continentality, 12, 110),
  };
}

function dayOfYear(isoDate) {
  const year = Number(isoDate.slice(0, 4));
  return toOrdinal(isoDate) - toOrdinal(`${year}-01-01`) + 1;
}

/** Суточная запись — чистая функция точки, профиля и даты. */
function synthesizeDay(profile, key, isoDate) {
  const seed = `${key}|${isoDate}`;
  const doy = dayOfYear(isoDate);
  const month = Number(isoDate.slice(5, 7));

  const seasonal = profile.amplitude * Math.cos((2 * Math.PI * (doy - WARMEST_DAY_OF_YEAR)) / YEAR_LENGTH);
  const temperatureMean = round(profile.annualMean + seasonal + (unit(`${seed}|t`) - 0.5) * 2.6, 1);

  const wetProbability = clamp(
    0.3 * RAIN_MONTH_FACTOR[month - 1] + (unit(`${key}|rain`) - 0.5) * 0.12,
    0.05,
    0.62,
  );
  const wet = unit(`${seed}|rw`) < wetProbability;
  const expectedPerWetDay = profile.monthlyPrecipitationMm / (30 * wetProbability);
  const intensity = 0.2 + 1.9 * unit(`${seed}|ra`) ** 1.9;
  const precipitationMm = wet ? round(clamp(intensity * expectedPerWetDay, 0, LIMITS.precipitationMaxMm), 1) : 0;

  const humidityRaw =
    62 +
    (wet ? 16 : -6) -
    0.7 * (temperatureMean - 8) +
    0.15 * profile.latAbs -
    7 * profile.continentality +
    16 * (unit(`${seed}|h`) - 0.5);
  const relativeHumidityPct = clamp(Math.round(humidityRaw), 8, 99);

  // Облачность и влага сглаживают суточный ход температуры.
  const spreadBase = 3.2 + 3.8 * unit(`${seed}|s`) + 0.02 * (60 - Math.abs(profile.latAbs - 50));
  const spread = clamp(spreadBase * (1 - 0.45 * ((relativeHumidityPct - 50) / 100)), 1.6, 16);

  return {
    date: isoDate,
    temperatureMean,
    temperatureMin: Math.min(round(temperatureMean - spread * 0.62, 1), temperatureMean - 0.1),
    temperatureMax: Math.max(round(temperatureMean + spread * 0.5, 1), temperatureMean + 0.1),
    precipitationMm,
    relativeHumidityPct,
  };
}

/**
 * Проверка запроса к движку.
 *
 * @returns {{ok: true, value: object} | {ok: false, errors: Record<string,string>}}
 */
export function validateForecastRequest(request) {
  if (request === null || typeof request !== "object" || Array.isArray(request)) {
    return { ok: false, errors: { _: "Запрос должен быть объектом" } };
  }

  const errors = {};
  const number = (value) => (typeof value === "number" && Number.isFinite(value) ? value : NaN);

  const lat = number(request.lat);
  if (!Number.isFinite(lat) || Math.abs(lat) > LIMITS.lat) errors.lat = "Широта — число от −90 до 90";

  const lon = number(request.lon);
  if (!Number.isFinite(lon) || Math.abs(lon) > LIMITS.lon) errors.lon = "Долгота — число от −180 до 180";

  const varietyId = typeof request.varietyId === "string" ? request.varietyId.trim() : "";
  if (!varietyId) errors.varietyId = "Не выбран сорт";
  else if (varietyId.length > LIMITS.varietyIdMax) errors.varietyId = `Идентификатор сорта длиннее ${LIMITS.varietyIdMax} символов`;

  const varietyName = typeof request.varietyName === "string" ? request.varietyName.trim() : "";
  if (!varietyName) errors.varietyName = "Название сорта пусто";
  else if (varietyName.length > LIMITS.varietyNameMax) errors.varietyName = `Название сорта длиннее ${LIMITS.varietyNameMax} символов`;

  if (!ALLOWED_RANGE_MONTHS.includes(request.rangeMonths)) errors.rangeMonths = "Период — 1, 3 или 6 месяцев";

  if (!isValidIsoDate(request.targetDate)) errors.targetDate = "Дата начала — YYYY-MM-DD";

  if (Object.keys(errors).length > 0) return { ok: false, errors };

  return {
    ok: true,
    value: {
      lat,
      lon,
      varietyId,
      varietyName,
      rangeMonths: request.rangeMonths,
      targetDate: request.targetDate.trim(),
    },
  };
}

/**
 * Формирует демонстрационный прогноз.
 *
 * @param {{lat:number, lon:number, varietyId:string, varietyName:string,
 *          rangeMonths:1|3|6, targetDate:string}} request
 * @returns {Promise<object>} результат по контракту schemaVersion 1
 */
export async function generateForecast(request) {
  const checked = validateForecastRequest(request);
  if (!checked.ok) {
    const error = new TypeError("Запрос к движку не прошёл проверку");
    error.code = "INVALID_REQUEST";
    error.fields = checked.errors;
    throw error;
  }

  const value = checked.value;
  const key = `${round(value.lat, 5)},${round(value.lon, 5)}`;
  const profile = locationProfile(key, value.lat, value.lon);
  const period = computePeriod(value.targetDate, value.rangeMonths);
  const series = listDates(period.startDate, period.endDate).map((date) => synthesizeDay(profile, key, date));

  const count = series.length || 1;
  let sumMean = 0;
  let sumPrecip = 0;
  let sumHumidity = 0;
  for (const day of series) {
    sumMean += day.temperatureMean;
    sumPrecip += day.precipitationMm;
    sumHumidity += day.relativeHumidityPct;
  }

  return {
    schemaVersion: SCHEMA_VERSION,
    engineVersion: ENGINE_VERSION,
    mode: ENGINE_MODE,
    request: { ...value },
    period: {
      startDate: period.startDate,
      endDate: period.endDate,
    },
    series,
    indicators: {
      meanTemperatureC: round(sumMean / count, 1),
      totalPrecipitationMm: round(sumPrecip, 1),
      activeTemperatureSum: null,
      hydrothermalCoefficient: null,
      meanRelativeHumidityPct: Math.round(sumHumidity / count),
    },
    risks: [],
    risksStatus: "notCalculated",
    provenance: {
      source: "synthetic",
      generatedAt: new Date().toISOString(),
    },
  };
}

/**
 * Проверка целостности результата перед отрисовкой и в тестах.
 * Пустой список значит, что данные можно показывать.
 */
export function auditResult(result) {
  const problems = [];
  if (!result || typeof result !== "object") return ["Результат отсутствует"];
  const series = Array.isArray(result.series) ? result.series : [];
  if (series.length === 0) problems.push("Ряд пуст");

  let previous = Number.NaN;
  for (const day of series) {
    const ordinal = toOrdinal(day.date);
    if (!Number.isFinite(ordinal)) {
      problems.push(`Некорректная дата ${String(day.date)}`);
    } else if (Number.isFinite(previous) && ordinal !== previous + 1) {
      problems.push(ordinal === previous ? `Дубликат даты ${day.date}` : `Разрыв в датах перед ${day.date}`);
    }
    if (Number.isFinite(ordinal)) previous = ordinal;

    const { temperatureMin: lo, temperatureMean: mid, temperatureMax: hi } = day;
    if (!(lo <= mid && mid <= hi)) problems.push(`Температуры вне порядка на ${day.date}`);
    if (!(day.precipitationMm >= 0)) problems.push(`Отрицательные осадки на ${day.date}`);
    if (!(day.relativeHumidityPct >= 0 && day.relativeHumidityPct <= 100)) {
      problems.push(`Влажность вне диапазона на ${day.date}`);
    }
  }
  return problems;
}
