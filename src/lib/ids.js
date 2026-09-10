/**
 * Идентификаторы записей.
 *
 * newUuid() — случайный v4 для записей, создаваемых пользователем.
 * stableId() — детерминированный идентификатор для наборов данных и снимков
 * прогноза: одинаковые параметры дают один и тот же id, поэтому повторный
 * показ результата не создаёт новый набор и не дублирует отчёт.
 */

const HEX = "0123456789abcdef";

function randomBytes(length) {
  const buffer = new Uint8Array(length);
  const webCrypto = globalThis.crypto;
  if (webCrypto && typeof webCrypto.getRandomValues === "function") {
    webCrypto.getRandomValues(buffer);
    return buffer;
  }
  // Аварийный путь для окружений без WebCrypto: crypto.randomUUID ниже тоже
  // недоступен, но приложение должно уметь создавать записи.
  for (let i = 0; i < length; i += 1) buffer[i] = Math.floor(Math.random() * 256);
  return buffer;
}

export function newUuid() {
  const webCrypto = globalThis.crypto;
  if (webCrypto && typeof webCrypto.randomUUID === "function") {
    return webCrypto.randomUUID();
  }
  const bytes = randomBytes(16);
  bytes[6] = (bytes[6] & 0x0f) | 0x40; // версия 4
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // варианты RFC 4122
  let out = "";
  for (let i = 0; i < 16; i += 1) {
    out += HEX[bytes[i] >> 4] + HEX[bytes[i] & 0x0f];
    if (i === 3 || i === 5 || i === 7 || i === 9) out += "-";
  }
  return out;
}

/** 32-битный FNV-1a со смешиванием — тот же алгоритм, что и в демодвижке. */
function fnv1a(text, seed) {
  let h = seed >>> 0;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  h ^= h >>> 15;
  h = Math.imul(h, 0x5bd1e995) >>> 0;
  h ^= h >>> 13;
  return h >>> 0;
}

/**
 * Устойчивый идентификатор формата UUID из перечисленных частей.
 * Детерминирован: одинаковый вход → одинаковый результат в любом окружении.
 */
export function stableId(prefix, parts) {
  const text = `${prefix}|${parts.map((part) => (part === null || part === undefined ? "∅" : String(part))).join("|")}`;
  let hex = "";
  for (let round = 0; round < 4; round += 1) {
    const value = fnv1a(`${round}#${text}`, 0x811c9dc5);
    hex += value.toString(16).padStart(8, "0");
  }
  // Помечаем вариант/версию как синтетический UUID v5-подобного вида.
  const chars = hex.split("");
  chars[12] = "5";
  chars[16] = HEX[8 + (Number.parseInt(hex[16], 16) % 4)];
  const s = chars.join("");
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20, 32)}`;
}

/** Короткая метка для заголовка набора/отчёта из устойчивого id. */
export function shortId(id) {
  return typeof id === "string" && id.length >= 8 ? id.slice(0, 8) : String(id ?? "");
}
