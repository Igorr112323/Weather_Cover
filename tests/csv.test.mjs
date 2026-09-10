/**
 * CSV-экспорт: экранирование, единицы в заголовках, защита от формул.
 * Запуск: npm test
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  buildCsv,
  csvField,
  datasetCsv,
  DATASET_CSV_COLUMNS,
  safeFileName,
} from "../src/services/export-service.js";

describe("csvField", () => {
  it("числа — как есть, пустые — пустой строкой", () => {
    assert.equal(csvField(12.5), "12.5");
    assert.equal(csvField(0), "0");
    assert.equal(csvField(null), "");
    assert.equal(csvField(undefined), "");
    assert.equal(csvField(Number.NaN), "");
  });

  it("кавычки, запятые и переводы строк экранируются", () => {
    assert.equal(csvField('слово "в кавычках"'), '"слово ""в кавычках"""');
    assert.equal(csvField("a,b"), '"a,b"');
    assert.equal(csvField("a\nb"), '"a\nb"');
    assert.equal(csvField("  края  "), '"  края  "');
    assert.equal(csvField("простое"), "простое");
  });

  it("формульные префиксы обезвреживаются апострофом", () => {
    for (const dangerous of ["=1+1", "+cmd", "-2+3", "@sum", "\tindented"]) {
      const field = csvField(dangerous);
      assert.ok(field.startsWith("'") || field.startsWith("\"'"), `${dangerous} → ${field}`);
    }
    // Обычный минус внутри текста не трогаем
    assert.equal(csvField("число -5 внутри"), "число -5 внутри");
  });
});

describe("buildCsv", () => {
  it("CRLF, заголовок и строки", () => {
    const csv = buildCsv({
      columns: [
        { key: "a", title: "A, первая" },
        { key: "b", title: "B" },
      ],
      rows: [{ a: "x", b: 1 }],
    });
    assert.equal(csv, '"A, первая",B\r\nx,1\r\n');
  });
});

describe("datasetCsv", () => {
  const dataset = {
    id: "abcdef12-0000-4000-8000-000000000000",
    label: 'Набор "=опасный"',
    source: "Демонстрационные",
    lat: 55.75581,
    lon: 37.61732,
    varietyName: "Демонстрационный сорт",
    startDate: "2026-10-01",
    endDate: "2026-10-31",
  };
  const rows = [
    {
      date: "2026-10-01",
      temperatureMean: 8.5,
      temperatureMin: 5.1,
      temperatureMax: 12.3,
      precipitationMm: 0,
      relativeHumidityPct: 72,
    },
  ];

  it("единицы в заголовках и метаданные набора", () => {
    const { content, fileName } = datasetCsv(dataset, rows);
    const titles = DATASET_CSV_COLUMNS.map((column) => column.title);
    assert.deepEqual(titles, [
      "Дата",
      "Средняя температура, °C",
      "Минимальная температура, °C",
      "Максимальная температура, °C",
      "Осадки, мм",
      "Влажность, %",
    ]);
    for (const title of titles) assert.ok(content.includes(`"${title}"`) || content.includes(title));
    assert.ok(content.includes("Демонстрационные данные"));
    assert.ok(content.includes("55.75581"));
    assert.ok(content.includes("2026-10-01,8.5,5.1,12.3,0,72"));
    assert.match(fileName, /^dataset-abcdef12\.csv$/);
  });

  it("опасный текст набора обезврежен", () => {
    const { content } = datasetCsv({ ...dataset, label: "=опасная+формула" }, rows);
    // Поле начинается с апострофа — табличный редактор не выполнит формулу
    assert.ok(content.includes("'=опасная+формула"));
    assert.ok(!content.includes(",=опасная"));
  });
});

describe("safeFileName", () => {
  it("вырезает путь и запрещённые символы", () => {
    assert.equal(safeFileName("../../etc/passwd"), "....etcpasswd.csv");
    assert.equal(safeFileName("Отчёт: сорт / осень?"), "Отчёт-сорт-осень.csv");
    assert.equal(safeFileName(""), "export.csv");
  });
});
