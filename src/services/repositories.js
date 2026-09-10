/**
 * Репозитории: сорта, наборы данных, отчёты, настройки.
 *
 * Все запросы параметризованы. Поиск экранируется для LIKE, чтобы символы
 * «%» и «_» в названии сорта не сработали как шаблоны.
 */

import { newUuid, stableId } from "../lib/ids.js";
import { parseJson, stringifyJson } from "../lib/json.js";

export const DEMO_SOURCE_LABEL = "Демонстрационные";

/* ── общие помощники ────────────────────────────────────────────────────── */

function likePattern(query) {
  const escaped = String(query)
    .trim()
    .replace(/[\\%_]/g, (char) => `\\${char}`);
  return `%${escaped}%`;
}

function orderClause(sort, allowed, fallback) {
  const key = allowed[sort?.key]?.sql ?? fallback.sql;
  const dir = sort?.dir === "desc" ? "DESC" : "ASC";
  return `${key} ${dir}`;
}

function isoNow() {
  return new Date().toISOString();
}

export function formatLabel(varietyName, startDate, endDate) {
  const ru = (iso) => {
    if (typeof iso !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) return "—";
    const [y, m, d] = iso.split("-");
    return `${d}.${m}.${y}`;
  };
  return `${varietyName || "—"} · ${ru(startDate)} — ${ru(endDate)}`;
}

/**
 * Ключ снимка результата: один и тот же прогноз сохраняется один раз,
 * повторное нажатие «Сохранить отчёт» не создаёт дубликат.
 */
export function computeResultKey(result) {
  const request = result?.request ?? {};
  const indicators = result?.indicators ?? {};
  return stableId("report", [
    result?.engineVersion ?? "?",
    Number.isFinite(request.lat) ? request.lat.toFixed(5) : "?",
    Number.isFinite(request.lon) ? request.lon.toFixed(5) : "?",
    request.varietyId ?? "?",
    request.rangeMonths ?? "?",
    request.targetDate ?? "?",
    result?.period?.startDate ?? "?",
    result?.period?.endDate ?? "?",
    result?.series?.length ?? 0,
    indicators.meanTemperatureC ?? "?",
    indicators.totalPrecipitationMm ?? "?",
    indicators.meanRelativeHumidityPct ?? "?",
  ]);
}

/** Устойчивый id набора данных из параметров запроса. */
export function computeDatasetId(result) {
  const request = result?.request ?? {};
  return stableId("dataset", [
    result?.engineVersion ?? "?",
    Number.isFinite(request.lat) ? request.lat.toFixed(5) : "?",
    Number.isFinite(request.lon) ? request.lon.toFixed(5) : "?",
    request.varietyId ?? "?",
    request.rangeMonths ?? "?",
    request.targetDate ?? "?",
  ]);
}

/* ── Сорта ──────────────────────────────────────────────────────────────── */

const VARIETY_SELECT = `
  SELECT id, name, type, breeder, fao, vegetation_days, notes, created_at, updated_at
  FROM varieties
`;

function mapVariety(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    breeder: row.breeder ?? null,
    fao: row.fao === null || row.fao === undefined ? null : Number(row.fao),
    vegetationDays:
      row.vegetation_days === null || row.vegetation_days === undefined ? null : Number(row.vegetation_days),
    notes: row.notes ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export const VARIETY_SORTS = Object.freeze({
  name: { sql: "name COLLATE NOCASE", type: "text" },
  type: { sql: "type", type: "text" },
  fao: { sql: "CASE WHEN fao IS NULL THEN 1 ELSE 0 END, fao", type: "number" },
  vegetation: { sql: "CASE WHEN vegetation_days IS NULL THEN 1 ELSE 0 END, vegetation_days", type: "number" },
  created: { sql: "created_at", type: "date" },
});

export function listVarieties(db, { query = "", type = "all", sort = { key: "name", dir: "asc" } } = {}) {
  const where = [];
  const params = [];
  if (query && query.trim()) {
    const pattern = likePattern(query);
    where.push("(name LIKE ? ESCAPE '\\' OR breeder LIKE ? ESCAPE '\\' OR notes LIKE ? ESCAPE '\\')");
    params.push(pattern, pattern, pattern);
  }
  if (type === "sort" || type === "hybrid") {
    where.push("type = ?");
    params.push(type);
  }
  const sql = `${VARIETY_SELECT}${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY ${orderClause(
    sort,
    VARIETY_SORTS,
    { sql: "name COLLATE NOCASE" },
  )}, id ASC`;
  return db.all(sql, params).map(mapVariety);
}

export function getVariety(db, id) {
  return mapVariety(db.get(`${VARIETY_SELECT} WHERE id = ?`, [id]));
}

export function insertVariety(db, value, { id = newUuid() } = {}) {
  const now = isoNow();
  db.run(
    `INSERT INTO varieties (id, name, type, breeder, fao, vegetation_days, notes, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, value.name, value.type, value.breeder, value.fao, value.vegetationDays, value.notes, now, now],
  );
  return getVariety(db, id);
}

export function updateVariety(db, id, value) {
  db.run(
    `UPDATE varieties
        SET name = ?, type = ?, breeder = ?, fao = ?, vegetation_days = ?, notes = ?, updated_at = ?
      WHERE id = ?`,
    [value.name, value.type, value.breeder, value.fao, value.vegetationDays, value.notes, isoNow(), id],
  );
  return getVariety(db, id);
}

export function deleteVariety(db, id) {
  const { changes } = db.run("DELETE FROM varieties WHERE id = ?", [id]);
  return changes > 0;
}

/** Снимок сорта для отчёта — история не зависит от последующих правок справочника. */
export function varietySnapshot(variety) {
  if (!variety) {
    return { name: "Сорт удалён", type: null, breeder: null, fao: null, vegetationDays: null, deleted: true };
  }
  return {
    id: variety.id,
    name: variety.name,
    type: variety.type,
    breeder: variety.breeder,
    fao: variety.fao,
    vegetationDays: variety.vegetationDays,
    deleted: false,
  };
}

/* ── Наборы данных ───────────────────────────────────────────────────────── */

const DATASET_SELECT = `
  SELECT id, label, mode, source, engine_version, schema_version, lat, lon,
         variety_id, variety_name, range_months, start_date, end_date, row_count,
         indicators, risks, risks_status, provenance, created_at
  FROM datasets
`;

const DATASET_SORTS = Object.freeze({
  label: { sql: "label COLLATE NOCASE" },
  created: { sql: "created_at" },
  start: { sql: "start_date" },
  rows: { sql: "row_count" },
});

function mapDataset(row) {
  if (!row) return null;
  return {
    id: row.id,
    label: row.label,
    mode: row.mode,
    source: row.source,
    engineVersion: row.engine_version,
    schemaVersion: Number(row.schema_version),
    lat: Number(row.lat),
    lon: Number(row.lon),
    varietyId: row.variety_id,
    varietyName: row.variety_name,
    rangeMonths: Number(row.range_months),
    startDate: row.start_date,
    endDate: row.end_date,
    rowCount: Number(row.row_count),
    indicators: parseJson(row.indicators, {}),
    risks: parseJson(row.risks, []),
    risksStatus: row.risks_status,
    provenance: parseJson(row.provenance, {}),
    createdAt: row.created_at,
  };
}

export function listDatasets(db, { query = "", rangeMonths = "all", sort = { key: "created", dir: "desc" } } = {}) {
  const where = [];
  const params = [];
  if (query && query.trim()) {
    const pattern = likePattern(query);
    where.push("(label LIKE ? ESCAPE '\\' OR variety_name LIKE ? ESCAPE '\\')");
    params.push(pattern, pattern);
  }
  if (rangeMonths === 1 || rangeMonths === 3 || rangeMonths === 6) {
    where.push("range_months = ?");
    params.push(rangeMonths);
  }
  const sql = `${DATASET_SELECT}${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY ${orderClause(
    sort,
    DATASET_SORTS,
    { sql: "created_at" },
  )}, id ASC`;
  return db.all(sql, params).map(mapDataset);
}

export function getDataset(db, id) {
  return mapDataset(db.get(`${DATASET_SELECT} WHERE id = ?`, [id]));
}

export function listDatasetRows(db, datasetId, { sort = { key: "date", dir: "asc" } } = {}) {
  const column = {
    date: "date",
    temperatureMean: "temperature_mean",
    temperatureMin: "temperature_min",
    temperatureMax: "temperature_max",
    precipitationMm: "precipitation_mm",
    relativeHumidityPct: "relative_humidity_pct",
  }[sort.key] ?? "date";
  const dir = sort.dir === "desc" ? "DESC" : "ASC";
  return db
    .all(
      `SELECT date, temperature_mean, temperature_min, temperature_max, precipitation_mm, relative_humidity_pct
         FROM dataset_rows
        WHERE dataset_id = ?
        ORDER BY ${column} ${dir}, date ${dir}
        LIMIT 5000`,
      [datasetId],
    )
    .map((row) => ({
      date: row.date,
      temperatureMean: Number(row.temperature_mean),
      temperatureMin: Number(row.temperature_min),
      temperatureMax: Number(row.temperature_max),
      precipitationMm: Number(row.precipitation_mm),
      relativeHumidityPct: Number(row.relative_humidity_pct),
    }));
}

/**
 * Сохраняет снимок прогноза как набор данных. Повторный вызов с теми же
 * параметрами не создаёт второй набор — id устойчивый.
 * @returns {{id:string, created:boolean, rowCount:number}}
 */
export function insertDatasetSnapshot(db, result, { varietyId = null } = {}) {
  const id = computeDatasetId(result);
  const existing = db.get("SELECT id FROM datasets WHERE id = ?", [id]);
  if (existing) return { id, created: false, rowCount: Number(db.get("SELECT row_count AS c FROM datasets WHERE id = ?", [id])?.c ?? 0) };

  const createdAt = isoNow();
  const request = result.request ?? {};
  const label = formatLabel(request.varietyName, result.period?.startDate, result.period?.endDate);

  db.run(
    `INSERT INTO datasets (id, label, mode, source, engine_version, schema_version, lat, lon, variety_id,
                           variety_name, range_months, start_date, end_date, row_count, indicators, risks,
                           risks_status, provenance, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      label,
      result.mode ?? "demo",
      DEMO_SOURCE_LABEL,
      result.engineVersion ?? "demo-1",
      Number(result.schemaVersion ?? 1),
      Number(request.lat),
      Number(request.lon),
      varietyId,
      request.varietyName ?? "—",
      Number(request.rangeMonths),
      result.period?.startDate ?? null,
      result.period?.endDate ?? null,
      Array.isArray(result.series) ? result.series.length : 0,
      stringifyJson(result.indicators ?? {}),
      stringifyJson(result.risks ?? []),
      result.risksStatus ?? "notCalculated",
      stringifyJson(result.provenance ?? {}),
      createdAt,
    ],
  );

  for (const day of result.series ?? []) {
    db.run(
      `INSERT INTO dataset_rows (dataset_id, date, temperature_mean, temperature_min, temperature_max,
                                 precipitation_mm, relative_humidity_pct)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        day.date,
        Number(day.temperatureMean),
        Number(day.temperatureMin),
        Number(day.temperatureMax),
        Number(day.precipitationMm),
        Number(day.relativeHumidityPct),
      ],
    );
  }

  return { id, created: true, rowCount: (result.series ?? []).length };
}

export function deleteDataset(db, id) {
  const { changes } = db.run("DELETE FROM datasets WHERE id = ?", [id]);
  return changes > 0;
}

export function clearDatasets(db) {
  // dataset_rows удаляются каскадно (внешние ключи включены).
  const { changes } = db.run("DELETE FROM datasets");
  return changes;
}

/* ── Отчёты ─────────────────────────────────────────────────────────────── */

const REPORT_SELECT = `
  SELECT id, name, result_key, dataset_id, variety_id, variety_snapshot, result, mode,
         lat, lon, range_months, start_date, end_date, created_at, updated_at
  FROM reports
`;

const REPORT_SORTS = Object.freeze({
  created: { sql: "created_at" },
  name: { sql: "name COLLATE NOCASE" },
  start: { sql: "start_date" },
});

function mapReport(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    resultKey: row.result_key,
    datasetId: row.dataset_id,
    varietyId: row.variety_id,
    variety: parseJson(row.variety_snapshot, null),
    result: parseJson(row.result, null),
    mode: row.mode,
    lat: Number(row.lat),
    lon: Number(row.lon),
    rangeMonths: Number(row.range_months),
    startDate: row.start_date,
    endDate: row.end_date,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function listReports(db, { query = "", varietyId = "all", order = "desc", limit = 0 } = {}) {
  const where = [];
  const params = [];
  if (query && query.trim()) {
    const pattern = likePattern(query);
    where.push("(name LIKE ? ESCAPE '\\' OR variety_snapshot LIKE ? ESCAPE '\\')");
    params.push(pattern, pattern);
  }
  if (varietyId && varietyId !== "all") {
    where.push("variety_id = ?");
    params.push(varietyId);
  }
  const dir = order === "asc" ? "ASC" : "DESC";
  // limit — служебное число из настроек таблицы, пользовательский текст сюда не попадает
  const limitClause = Number.isFinite(Number(limit)) && Number(limit) > 0 ? ` LIMIT ${Math.trunc(Number(limit))}` : "";
  const sql = `${REPORT_SELECT}${where.length ? ` WHERE ${where.join(" AND ")}` : ""}` +
    ` ORDER BY created_at ${dir}, id ${dir}${limitClause}`;
  return db.all(sql, params).map(mapReport);
}

export function getReport(db, id) {
  return mapReport(db.get(`${REPORT_SELECT} WHERE id = ?`, [id]));
}

export function findReportByKey(db, resultKey) {
  return mapReport(db.get(`${REPORT_SELECT} WHERE result_key = ?`, [resultKey]));
}

/**
 * Сохраняет снимок результата вместе со снимком сорта.
 * @returns {{id:string, created:boolean}}
 */
export function insertReportSnapshot(db, result, { variety = null, datasetId = null, name = null } = {}) {
  const resultKey = computeResultKey(result);
  const existing = findReportByKey(db, resultKey);
  if (existing) return { id: existing.id, created: false };

  const id = newUuid();
  const now = isoNow();
  const request = result.request ?? {};
  const title = name ?? formatLabel(variety?.name ?? request.varietyName, result.period?.startDate, result.period?.endDate);

  db.run(
    `INSERT INTO reports (id, name, result_key, dataset_id, variety_id, variety_snapshot, result, mode,
                           lat, lon, range_months, start_date, end_date, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      title,
      resultKey,
      datasetId,
      variety?.id ?? null,
      stringifyJson(varietySnapshot(variety)),
      stringifyJson(result),
      result.mode ?? "demo",
      Number(request.lat),
      Number(request.lon),
      Number(request.rangeMonths),
      result.period?.startDate ?? null,
      result.period?.endDate ?? null,
      now,
      now,
    ],
  );
  return { id, created: true };
}

export function deleteReport(db, id) {
  const { changes } = db.run("DELETE FROM reports WHERE id = ?", [id]);
  return changes > 0;
}

export function clearReports(db) {
  const { changes } = db.run("DELETE FROM reports");
  return changes;
}

/* ── Настройки приложения ────────────────────────────────────────────────── */

export function getSetting(db, key, fallback = null) {
  const row = db.get("SELECT value FROM app_settings WHERE key = ?", [key]);
  if (!row) return fallback;
  const parsed = parseJson(row.value, null);
  return parsed === null ? fallback : parsed;
}

export function setSetting(db, key, value) {
  db.run(
    `INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    [key, stringifyJson(value), isoNow()],
  );
  return true;
}

export function deleteSetting(db, key) {
  db.run("DELETE FROM app_settings WHERE key = ?", [key]);
  return true;
}
