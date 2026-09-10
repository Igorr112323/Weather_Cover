/** Разбор сохранённого JSON с отказом вместо падения (данные могли повредиться). */

export function parseJson(text, fallback = null) {
  if (typeof text !== "string" || text.length === 0) return fallback;
  try {
    const value = JSON.parse(text);
    return value === undefined ? fallback : value;
  } catch {
    return fallback;
  }
}

export function stringifyJson(value, fallback = "null") {
  try {
    return JSON.stringify(value) ?? fallback;
  } catch {
    return fallback;
  }
}
