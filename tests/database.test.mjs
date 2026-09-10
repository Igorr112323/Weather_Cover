/**
 * SQLite (sql.js): миграции, CRUD сортов, наборы данных, отчёты.
 * Запуск: npm test
 *
 * База создаётся в памяти; персистентность здесь не тестируется —
 * она проверяется smoke-тестом и ручной проверкой перезапуска.
 */

import { describe, it, before } from "node:test";
import assert from "node:assert/strict";

import initSqlJs from "sql.js";
import { generateForecast } from "../calculations/forecast_engine.js";
import { createHandle } from "../src/services/database.js";
import { LATEST_VERSION, migrate, readVersion } from "../src/services/migrations.js";
import {
  clearDatasets,
  clearReports,
  computeResultKey,
  deleteDataset,
  deleteReport,
  deleteVariety,
  findReportByKey,
  getDataset,
  getReport,
  getSetting,
  getVariety,
  insertDatasetSnapshot,
  insertReportSnapshot,
  insertVariety,
  listDatasetRows,
  listDatasets,
  listReports,
  listVarieties,
  setSetting,
  updateVariety,
  varietySnapshot,
} from "../src/services/repositories.js";
import { validateVariety, varietyToForm } from "../src/services/validation.js";

let SQL = null;

before(async () => {
  SQL = await initSqlJs();
});

/** Новая база с применёнными миграциями. */
function freshDb() {
  const raw = new SQL.Database();
  raw.run("PRAGMA foreign_keys = ON");
  const db = createHandle(raw);
  const migration = migrate(db);
  return { db, migration };
}

const REQUEST = Object.freeze({
  lat: 55.7558,
  lon: 37.6173,
  varietyId: "00000000-0000-4000-8000-000000000001",
  varietyName: "Демонстрационный сорт",
  rangeMonths: 1,
  targetDate: "2026-10-01",
});

describe("migrate", () => {
  it("применяет все миграции и доводит версию до LATEST_VERSION", () => {
    const { db, migration } = freshDb();
    assert.deepEqual(migration.applied, [1, 2]);
    assert.equal(migration.version, LATEST_VERSION);
    assert.equal(migration.fresh, true);
    assert.equal(readVersion(db), LATEST_VERSION);
    db.close();
  });

  it("повторный запуск ничего не применяет", () => {
    const { db } = freshDb();
    const again = migrate(db);
    assert.deepEqual(again.applied, []);
    assert.equal(again.fresh, false);
    db.close();
  });

  it("создаёт демонстрационный сорт только на новой базе", () => {
    const { db } = freshDb();
    const varieties = listVarieties(db, {});
    assert.equal(varieties.length, 1);
    assert.equal(varieties[0].name, "Демонстрационный сорт");
    assert.equal(varieties[0].type, "sort");
    db.close();
  });

  it("не сеет сорт повторно после удаления всех сортов", () => {
    const { db } = freshDb();
    for (const variety of listVarieties(db, {})) deleteVariety(db, variety.id);
    assert.equal(listVarieties(db, {}).length, 0);
    migrate(db);
    assert.equal(listVarieties(db, {}).length, 0);
    db.close();
  });

  it("включает внешние ключи и каскад строк набора", () => {
    const { db } = freshDb();
    const pragmas = db.all("PRAGMA foreign_keys");
    assert.equal(Number(pragmas[0]?.foreign_keys ?? 0), 1);
    db.close();
  });
});

describe("validateVariety", () => {
  it("принимает минимальную запись", () => {
    const checked = validateVariety({ name: "Сорт", type: "sort" });
    assert.equal(checked.ok, true);
  });

  it("требует название и известный тип", () => {
    assert.equal(validateVariety({ name: "", type: "sort" }).ok, false);
    assert.equal(validateVariety({ name: "Сорт", type: "unknown" }).ok, false);
  });

  it("ФАО и вегетация — только положительные целые", () => {
    assert.equal(validateVariety({ name: "С", type: "sort", fao: 0 }).ok, false);
    assert.equal(validateVariety({ name: "С", type: "sort", fao: -3 }).ok, false);
    assert.equal(validateVariety({ name: "С", type: "sort", fao: 2.5 }).ok, false);
    assert.equal(validateVariety({ name: "С", type: "sort", vegetationDays: 0 }).ok, false);
    assert.equal(validateVariety({ name: "С", type: "hybrid", fao: 250, vegetationDays: 120 }).ok, true);
  });

  it("не выдумывает научных диапазонов: большие числа допустимы", () => {
    assert.equal(validateVariety({ name: "С", type: "sort", fao: 99999 }).ok, true);
  });

  it("varietyToForm читает вегетацию из объекта записи и из строки БД", () => {
    assert.equal(varietyToForm({ vegetationDays: 115 }).vegetationDays, "115");
    assert.equal(varietyToForm({ vegetation_days: 120 }).vegetationDays, "120");
    assert.equal(varietyToForm({}).vegetationDays, "");
  });
});

describe("varieties CRUD", () => {
  it("создание, чтение, обновление, удаление", () => {
    const { db } = freshDb();
    const created = insertVariety(db, {
      name: "Тестовый гибрид",
      type: "hybrid",
      breeder: "Оригинатор",
      fao: 230,
      vegetationDays: 115,
      notes: "Заметка",
    });
    const id = created.id;
    assert.equal(created.name, "Тестовый гибрид");
    assert.equal(created.type, "hybrid");
    assert.equal(created.fao, 230);

    updateVariety(db, id, { ...created, name: "Переименован", fao: null });
    const updated = getVariety(db, id);
    assert.equal(updated.name, "Переименован");
    assert.equal(updated.fao, null);

    deleteVariety(db, id);
    assert.equal(getVariety(db, id), null);
    db.close();
  });

  it("поиск и фильтр типа; LIKE-символы экранируются", () => {
    const { db } = freshDb();
    insertVariety(db, { name: "100% урожай_ный", type: "hybrid" });
    assert.equal(listVarieties(db, { query: "100%" }).length, 1);
    assert.equal(listVarieties(db, { query: "100" }).length, 1);
    assert.equal(listVarieties(db, { query: "урожай_ный" }).length, 1);
    assert.equal(listVarieties(db, { query: "несорт" }).length, 0);
    assert.equal(listVarieties(db, { type: "hybrid" }).length, 1);
    assert.equal(listVarieties(db, { type: "sort" }).length, 1);
    db.close();
  });

  it("CHECK-ограничения отклоняют мусор на уровне базы", () => {
    const { db } = freshDb();
    assert.throws(() => insertVariety(db, { name: "X", type: "sort", fao: -1 }));
    db.close();
  });
});

describe("datasets", () => {
  it("снимок результата: устойчивый id, строки, сортировка всего набора", async () => {
    const { db } = freshDb();
    const result = await generateForecast({ ...REQUEST });
    const first = insertDatasetSnapshot(db, result, { varietyId: REQUEST.varietyId });
    const second = insertDatasetSnapshot(db, result, { varietyId: REQUEST.varietyId });
    assert.equal(first.id, second.id, "повторная вставка того же результата не плодит наборы");
    assert.equal(second.created, false);

    const dataset = getDataset(db, first.id);
    assert.equal(dataset.rowCount, result.series.length);
    assert.equal(dataset.source, "Демонстрационные");

    const asc = listDatasetRows(db, first.id, { sort: { key: "date", dir: "asc" } });
    const desc = listDatasetRows(db, first.id, { sort: { key: "date", dir: "desc" } });
    assert.equal(asc.length, result.series.length);
    assert.equal(asc[0].date, result.period.startDate);
    assert.equal(desc[0].date, result.period.endDate);

    const byTemp = listDatasetRows(db, first.id, { sort: { key: "temperatureMean", dir: "desc" } });
    for (let i = 1; i < byTemp.length; i += 1) {
      assert.ok(byTemp[i - 1].temperatureMean >= byTemp[i].temperatureMean, "числа сортируются как числа");
    }
    db.close();
  });

  it("удаление набора каскадно удаляет строки; очистка считает", async () => {
    const { db } = freshDb();
    const one = await generateForecast({ ...REQUEST });
    const two = await generateForecast({ ...REQUEST, lat: 43.0, lon: 44.0 });
    const first = insertDatasetSnapshot(db, one, {});
    insertDatasetSnapshot(db, two, {});
    assert.equal(listDatasets(db, {}).length, 2);

    deleteDataset(db, first.id);
    assert.equal(getDataset(db, first.id), null);
    assert.equal(listDatasetRows(db, first.id, {}).length, 0);

    const cleared = clearDatasets(db);
    assert.equal(cleared, 1);
    assert.equal(listDatasets(db, {}).length, 0);
    db.close();
  });
});

describe("reports", () => {
  it("сохранение и восстановление снимка; дедупликация по ключу", async () => {
    const { db } = freshDb();
    const result = await generateForecast({ ...REQUEST });
    const variety = getVariety(db, REQUEST.varietyId);
    const key = computeResultKey(result);

    const saved = insertReportSnapshot(db, result, {
      variety: varietySnapshot(variety),
      datasetId: null,
      name: "Демонстрационный сорт · 01.10.2026 — 31.10.2026",
    });
    assert.ok(saved.id);

    const found = findReportByKey(db, key);
    assert.equal(found.id, saved.id);

    const restored = getReport(db, saved.id);
    assert.deepEqual(restored.result.series, result.series);
    assert.deepEqual(restored.result.indicators, result.indicators);
    // Снимок сорта заморожен на момент расчёта
    assert.equal(restored.variety.name, "Демонстрационный сорт");
    db.close();
  });

  it("отчёт переживает удаление сорта и набора данных", async () => {
    const { db } = freshDb();
    const result = await generateForecast({ ...REQUEST });
    const variety = insertVariety(db, { name: "Временный", type: "sort" });
    const varietyId = variety.id;
    const dataset = insertDatasetSnapshot(db, result, { varietyId });
    const saved = insertReportSnapshot(db, result, {
      variety: varietySnapshot(variety),
      datasetId: dataset.id,
      name: "Временный · период",
    });

    deleteVariety(db, varietyId);
    deleteDataset(db, dataset.id);

    const restored = getReport(db, saved.id);
    assert.ok(restored, "отчёт не исчез после удаления сорта и набора");
    assert.deepEqual(restored.result.series, result.series);
    assert.equal(restored.variety.name, "Временный");
    db.close();
  });

  it("очистка наборов не трогает отчёты; очистка отчётов считает", async () => {
    const { db } = freshDb();
    const result = await generateForecast({ ...REQUEST });
    const dataset = insertDatasetSnapshot(db, result, {});
    insertReportSnapshot(db, result, { variety: varietySnapshot(null), datasetId: dataset.id, name: "Отчёт" });

    clearDatasets(db);
    assert.equal(listDatasets(db, {}).length, 0);
    assert.equal(listReports(db, {}).length, 1, "отчёты переживают очистку данных");

    const cleared = clearReports(db);
    assert.equal(cleared, 1);
    assert.equal(listReports(db, {}).length, 0);
    deleteReport(db, "missing-id");
    db.close();
  });

  it("поиск и фильтр сорта в архиве", async () => {
    const { db } = freshDb();
    const result = await generateForecast({ ...REQUEST });
    insertReportSnapshot(db, result, {
      variety: varietySnapshot(getVariety(db, REQUEST.varietyId)),
      datasetId: null,
      name: "Демонстрационный сорт · октябрь",
    });
    assert.equal(listReports(db, { query: "октябрь" }).length, 1);
    assert.equal(listReports(db, { query: "декабрь" }).length, 0);
    assert.equal(listReports(db, { varietyId: REQUEST.varietyId }).length, 1);
    db.close();
  });
});

describe("settings", () => {
  it("get/set round-trip", () => {
    const { db } = freshDb();
    assert.equal(getSetting(db, "map", null), null);
    setSetting(db, "map", { zoom: 5 });
    assert.deepEqual(getSetting(db, "map", null), { zoom: 5 });
    db.close();
  });
});
