/**
 * Экспорт CSV.
 *
 * Формат: UTF-8 с BOM (иначе Excel читает кириллицу как «кракозябры»),
 * разделитель — запятая, десятичный разделитель — точка (числа остаются
 * числами при импорте), все поля при необходимости кавычатся.
 *
 * Текстовые поля, начинающиеся с =, +, -, @, табуляции или перевода строки,
 * получают префикс ' — защита от формульной интерпретации в табличном редакторе
 * (CSV injection).
 */

export const CSV_BOM = "\uFEFF";

const NEEDS_QUOTES = /[";\n\r,]/;
const FORMULA_START = /^[=+\-@\t\r]/;

function stringifyCell(value) {
  if (value === null || value === undefined) return "";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "";
  if (typeof value === "boolean") return value ? "1" : "0";
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

/** Экранирование одного поля с учётом формульной интерпретации. */
export function csvField(value) {
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "";
  let text = stringifyCell(value);
  if (FORMULA_START.test(text)) text = `'${text}`;
  if (NEEDS_QUOTES.test(text) || /^\s|\s$/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

/** @returns {string} CSV без BOM */
export function buildCsv({ columns, rows, header = null }) {
  const lines = [];
  if (header) lines.push(header.map(csvField).join(","));
  lines.push(columns.map((column) => csvField(column.title)).join(","));
  for (const row of rows) {
    lines.push(columns.map((column) => csvField(column.value ? column.value(row) : row[column.key])).join(","));
  }
  return `${lines.join("\r\n")}\r\n`;
}

/** Имя файла: только безопасные символы, без пути и управляющих последовательностей. */
export function safeFileName(name, extension = "csv") {
  const base = String(name ?? "export")
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "")
    .replace(/\s+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  const cleaned = base.length > 0 ? base : "export";
  const withoutExt = cleaned.replace(/\.csv$/i, "");
  return `${withoutExt}.${extension}`;
}

export const DATASET_CSV_COLUMNS = Object.freeze([
  { key: "date", title: "Дата" },
  { key: "temperatureMean", title: "Средняя температура, °C" },
  { key: "temperatureMin", title: "Минимальная температура, °C" },
  { key: "temperatureMax", title: "Максимальная температура, °C" },
  { key: "precipitationMm", title: "Осадки, мм" },
  { key: "relativeHumidityPct", title: "Влажность, %" },
]);

export function datasetCsv(dataset, rows) {
  const header = [
    ["Набор", dataset?.label ?? ""],
    ["Источник", dataset?.source ?? ""],
    ["Режим", "Демонстрационные данные"],
    ["Координаты", Number.isFinite(dataset?.lat) ? `${dataset.lat.toFixed(5)}, ${dataset.lon.toFixed(5)}` : ""],
    ["Сорт", dataset?.varietyName ?? ""],
    ["Период", `${dataset?.startDate ?? ""} — ${dataset?.endDate ?? ""}`],
  ];
  const meta = buildCsv({
    columns: [{ value: (row) => row[0] }, { value: (row) => row[1] }],
    rows: header,
  });
  const body = buildCsv({ columns: DATASET_CSV_COLUMNS, rows });
  return { content: `${meta}\r\n${body}`, fileName: safeFileName(`dataset-${dataset?.id?.slice(0, 8) ?? "export"}`) };
}

/**
 * Сохраняет файл: в Electron — через диалог записи (main process),
 * в браузере — загрузкой Blob'ом.
 */
export async function saveTextFile({ fileName, content }) {
  const payload = `${CSV_BOM}${content}`;
  const api = typeof window !== "undefined" ? window.agro : null;
  if (api?.saveFile) {
    const bytes = new TextEncoder().encode(payload);
    const result = await api.saveFile({ fileName: safeFileName(fileName), bytes });
    if (result && result.ok === false && result.code !== "canceled") {
      const error = new Error(result.message ?? "Не удалось записать файл");
      error.code = "FILE_WRITE_FAILED";
      throw error;
    }
    return { saved: Boolean(result && result.ok), canceled: Boolean(result && result.code === "canceled") };
  }

  const blob = new Blob([payload], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = safeFileName(fileName);
  link.rel = "noopener";
  document.body.append(link);
  link.click();
  link.remove();
  // ObjectURL освобождается асинхронно: в Safari синхронный revoke обрывает загрузку
  window.setTimeout(() => URL.revokeObjectURL(url), 10000);
  return { saved: true, canceled: false };
}
