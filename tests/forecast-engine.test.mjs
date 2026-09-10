/**
 * Демонстрационный движок: контракт, детерминированность, границы значений.
 * Запуск: npm test
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  auditResult,
  ENGINE_VERSION,
  generateForecast,
  SCHEMA_VERSION,
  validateForecastRequest,
} from "../calculations/forecast_engine.js";
import { computePeriod, toOrdinal } from "../calculations/date-period.js";

const REQUEST = Object.freeze({
  lat: 55.7558,
  lon: 37.6173,
  varietyId: "00000000-0000-4000-8000-000000000001",
  varietyName: "Демонстрационный сорт",
  rangeMonths: 1,
  targetDate: "2026-10-01",
});

function checkContract(result, request) {
  assert.equal(result.schemaVersion, SCHEMA_VERSION);
  assert.equal(result.engineVersion, ENGINE_VERSION);
  assert.equal(result.mode, "demo");
  assert.deepEqual(result.request, request);
  assert.equal(result.risksStatus, "notCalculated");
  assert.deepEqual(result.risks, []);
  assert.equal(result.indicators.activeTemperatureSum, null);
  assert.equal(result.indicators.hydrothermalCoefficient, null);
  assert.equal(result.provenance.source, "synthetic");
  assert.ok(!Number.isNaN(Date.parse(result.provenance.generatedAt)));

  const expected = computePeriod(request.targetDate, request.rangeMonths);
  assert.equal(result.period.startDate, expected.startDate);
  assert.equal(result.period.endDate, expected.endDate);
  assert.equal(result.series.length, expected.days);
}

function checkSeries(series) {
  assert.ok(series.length > 0);
  const seen = new Set();
  let previous = null;
  for (const day of series) {
    assert.match(day.date, /^\d{4}-\d{2}-\d{2}$/);
    assert.ok(!seen.has(day.date), `дубликат даты ${day.date}`);
    seen.add(day.date);
    if (previous !== null) {
      assert.equal(toOrdinal(day.date), previous + 1, `разрыв перед ${day.date}`);
    }
    previous = toOrdinal(day.date);

    const { temperatureMin, temperatureMean, temperatureMax, precipitationMm, relativeHumidityPct } = day;
    for (const value of [temperatureMin, temperatureMean, temperatureMax, precipitationMm, relativeHumidityPct]) {
      assert.equal(typeof value, "number");
      assert.ok(Number.isFinite(value));
    }
    assert.ok(temperatureMin <= temperatureMean, `${day.date}: min > mean`);
    assert.ok(temperatureMean <= temperatureMax, `${day.date}: mean > max`);
    assert.ok(precipitationMm >= 0, `${day.date}: отрицательные осадки`);
    assert.ok(
      relativeHumidityPct >= 0 && relativeHumidityPct <= 100,
      `${day.date}: влажность вне 0–100`,
    );
  }
}

describe("validateForecastRequest", () => {
  it("принимает корректный запрос и обрезает пробелы", () => {
    const checked = validateForecastRequest({ ...REQUEST, varietyName: "  Сорт  " });
    assert.equal(checked.ok, true);
    assert.equal(checked.value.varietyName, "Сорт");
  });

  it("отклоняет координаты вне диапазона и мусор вместо чисел", () => {
    assert.equal(validateForecastRequest({ ...REQUEST, lat: 91 }).ok, false);
    assert.equal(validateForecastRequest({ ...REQUEST, lon: -181 }).ok, false);
    assert.equal(validateForecastRequest({ ...REQUEST, lat: Number.NaN }).ok, false);
    assert.equal(validateForecastRequest({ ...REQUEST, lat: "55" }).ok, false);
    assert.equal(validateForecastRequest({ ...REQUEST, lat: 90, lon: 180 }).ok, true);
  });

  it("требует сорт, период 1/3/6 и дату YYYY-MM-DD", () => {
    assert.equal(validateForecastRequest({ ...REQUEST, varietyId: "" }).ok, false);
    assert.equal(validateForecastRequest({ ...REQUEST, varietyName: "  " }).ok, false);
    assert.equal(validateForecastRequest({ ...REQUEST, rangeMonths: 2 }).ok, false);
    assert.equal(validateForecastRequest({ ...REQUEST, targetDate: "01.10.2026" }).ok, false);
    assert.equal(validateForecastRequest({ ...REQUEST, targetDate: "2026-02-30" }).ok, false);
    assert.equal(validateForecastRequest(null).ok, false);
  });
});

describe("generateForecast", () => {
  it("возвращает результат по контракту schemaVersion 1", async () => {
    const result = await generateForecast({ ...REQUEST });
    checkContract(result, { ...REQUEST });
    checkSeries(result.series);
    assert.deepEqual(auditResult(result), []);
  });

  it("детерминированный: одинаковые параметры — одинаковый ряд", async () => {
    const first = await generateForecast({ ...REQUEST });
    const second = await generateForecast({ ...REQUEST });
    assert.deepEqual(second.series, first.series);
    assert.deepEqual(second.indicators, first.indicators);
    assert.deepEqual(second.period, first.period);
  });

  it("разные точки дают разные ряды", async () => {
    const first = await generateForecast({ ...REQUEST });
    const other = await generateForecast({ ...REQUEST, lat: 43.0, lon: 44.0 });
    assert.notDeepEqual(other.series, first.series);
  });

  it("границы значений для всех периодов и крайних широт", async () => {
    for (const rangeMonths of [1, 3, 6]) {
      for (const [lat, lon, targetDate] of [
        [69.9, 30.0, "2026-01-15"],
        [55.7, 37.6, "2026-09-10"],
        [43.5, 39.7, "2024-02-29"],
        [-12.0, -77.0, "2026-07-01"],
      ]) {
        const result = await generateForecast({
          ...REQUEST,
          lat,
          lon,
          rangeMonths,
          targetDate,
        });
        checkContract(result, { ...REQUEST, lat, lon, rangeMonths, targetDate });
        checkSeries(result.series);
        assert.deepEqual(auditResult(result), []);
      }
    }
  });

  it("индикаторы посчитаны из ряда", async () => {
    const result = await generateForecast({ ...REQUEST, rangeMonths: 3 });
    const count = result.series.length;
    const mean = result.series.reduce((sum, day) => sum + day.temperatureMean, 0) / count;
    const precip = result.series.reduce((sum, day) => sum + day.precipitationMm, 0);
    const humidity = result.series.reduce((sum, day) => sum + day.relativeHumidityPct, 0) / count;
    assert.ok(Math.abs(result.indicators.meanTemperatureC - mean) < 0.11);
    assert.ok(Math.abs(result.indicators.totalPrecipitationMm - precip) < 0.11);
    assert.ok(Math.abs(result.indicators.meanRelativeHumidityPct - humidity) < 0.51);
  });

  it("бросает INVALID_REQUEST на плохом запросе", async () => {
    await assert.rejects(generateForecast({ ...REQUEST, rangeMonths: 2 }), (error) => {
      assert.equal(error.code, "INVALID_REQUEST");
      return true;
    });
  });
});
