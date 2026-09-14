/**
 * Разбор того, что присылает покупатель.
 *
 * Заявка приходит в свободной форме: текст с экрана активации, файл
 * `.agrorequest`, сообщение в мессенджере («здравствуйте, код ZZG5-9ZKT,
 * Иван, +7 960 484-34-63»). Станция должна из любого из этого вытащить
 * идентификатор компьютера — остальное (имя, телефон, почта) только полезно
 * для журнала выдачи.
 *
 * Чистые функции: файловая система и сеть не нужны, поэтому разбор проверяется
 * unit-тестами (tests/station.test.mjs) на любых текстах.
 */

import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const core = require(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "vendor", "core.cjs"));

/** Подписи, после которых обычно стоит код компьютера. */
const SHORT_ID_LABELS = [
  "код\\s*(?:\\w+\\s+){0,2}?(?:компьютера|машины|устройства|пк|системы)",
  "(?:id|идентификатор)\\s*(?:компьютера|машины|устройства)",
  "machine(?:id)?",
  "hwid",
];

const FULL_ID_LABELS = ["полный\\s*(?:\\w+\\s+)?идентификатор(?:\\s*(?:компьютера|машины))?", "full\\s*(?:machine\\s*)?id", "machineguid"];

/** 8 символов base32 (Crockford) — код компьютера с экрана. */
const SHORT_TOKEN = new RegExp(`[0-9A-HJKMNP-TVZ]{4}\\s*[-–—]?\\s*[0-9A-HJKMNP-TVZ]{4}`, "gi");
const HEX64 = /\b[0-9a-f]{64}\b/gi;
const EMAIL = /\b[\w.+-]+@[\w-]+\.[a-zA-Z]{2,}\b/;
// Телефон: предпочитаем полный набор с кодом страны (+7 960 484-34-63),
// иначе — то, что нашлось. Цифр должно быть не меньше 10, чтобы не поймать
// фрагмент дата/версии.
const PHONE = /\+?\d{1,3}[\s(-]*\d{3}[\s)-]*[\s-]*\d{3}[\s-]*\d{2}[\s-]*\d{2}\b/g;
const VERSION = /\b\d+\.\d+\.\d+\b/;
const NAME_PATTERNS = [
  /(?:меня зовут|моё имя|мое имя|имя)\s*[:\-]?\s*([А-ЯЁA-Z][\wА-ЯЁа-яё-]*(?:\s+[А-ЯЁA-Z][\wА-ЯЁа-яё-]+)?)/i,
  /^([А-ЯЁA-Z][а-яёa-z]{2,}(?:\s+[А-ЯЁA-Z][а-яёa-z]{2,})?)\s*[,!]/,
];

/** Длина полного идентификатора компьютера в hex. */
const FULL_HEX_LENGTH = 64;

/** Цепочка hex-символов, между которыми мог встать пробел, дефис или перенос. */
const HEX_LOOSE = /[0-9a-fA-F][0-9a-fA-F \t\r\n-]*[0-9a-fA-F]/g;

/**
 * Самый длинный «шестнадцатеричный» кусок текста, склеенный в hex-строку.
 * Нужен потому, что полный идентификатор при пересылке режут: мессенджер
 * вставляет перенос строки, узкое поле — перенос, кто-то разносит пробелами.
 * Поиск «64 hex подряд» на таком тексте ничего не находит.
 */
function longestHexRun(text) {
  let best = "";
  for (const match of String(text ?? "").matchAll(HEX_LOOSE)) {
    const compact = match[0].replace(/[^0-9a-fA-F]/g, "").toLowerCase();
    if (compact.length > best.length) best = compact;
  }
  return best;
}

/**
 * Попадает ли фрагмент внутрь длинного hex-идентификатора. Нужно, чтобы
 * восемь символов из разорванного полного кода не принимались за «код
 * компьютера»: base32-алфавит почти целиком совпадает с hex-символами.
 */
function insideHexRun(text, index, length) {
  const hex = /[0-9a-fA-F]/;
  const step = /[0-9a-fA-F \t\r\n-]/;
  let start = index;
  let end = index + length;
  while (start > 0 && step.test(text[start - 1])) start -= 1;
  while (start < index && !hex.test(text[start])) start += 1;
  while (end < text.length && step.test(text[end])) end += 1;
  while (end > index + length && !hex.test(text[end - 1])) end -= 1;
  return text.slice(start, end).replace(/[^0-9a-fA-F]/g, "").length >= FULL_HEX_LENGTH / 2;
}

/** Принадлежит ли найденный фрагмент более длинному токену (код активации, hex-идентификатор). */
function insideLongToken(text, index, length) {
  const pattern = /[0-9A-Za-z-]/;
  let start = index;
  while (start > 0 && pattern.test(text[start - 1])) start -= 1;
  let end = index + length;
  while (end < text.length && pattern.test(text[end])) end += 1;
  return end - start > 20;
}

function clean(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

/**
 * Проверяет, похож ли обрывок текста на идентификатор компьютера, и приводит
 * его к короткому виду.
 * @returns {{shortId:string, source:'short'|'full'}|null}
 */
function tryResolve(text) {
  const candidate = clean(text).replace(/^[«"'`]+|[«"'`.]+$/g, "");
  if (!candidate) return null;
  // Сначала пробуем склеить hex-символы: разорванный переносом полный
  // идентификатор — частый случай, и он точнее короткого кода.
  const loose = longestHexRun(candidate);
  if (loose.length === FULL_HEX_LENGTH) {
    const fromHex = core.resolveBindTarget(loose);
    if (fromHex.ok) return { shortId: fromHex.shortId, source: "full" };
  }
  const resolved = core.resolveBindTarget(candidate);
  if (!resolved.ok) return null;
  return { shortId: resolved.shortId, source: candidate.replace(/[^0-9a-fA-F]/g, "").length === FULL_HEX_LENGTH ? "full" : "short" };
}

function labeledMatch(text, labels) {
  for (const label of labels) {
    const pattern = new RegExp(`${label}\\s*[:=]?\\s*(\\S[^\\n,.;)]*)`, "i");
    const match = pattern.exec(text);
    if (match) return { raw: clean(match[1]), label: clean(match[0]) };
  }
  return null;
}

/**
 * @param {string} input произвольный текст заявки (или содержимое .agrorequest)
 * @returns {{ok:boolean, shortId:string, pretty:string, machineId:string,
 *   version:string, name:string, phone:string, email:string,
 *   candidates:Array<{shortId:string, how:string}>, conflicts:string[], message:string}}
 */
export function parseActivationRequest(input) {
  const text = String(input ?? "");
  const trimmed = text.trim();
  const result = {
    ok: false,
    shortId: "",
    pretty: "",
    machineId: "",
    version: "",
    name: "",
    phone: "",
    email: "",
    candidates: [],
    conflicts: [],
    message: "",
  };
  if (!trimmed) {
    return { ...result, message: "Пусто: вставьте текст заявки или код компьютера" };
  }

  const addCandidate = (found, how) => {
    if (!found) return;
    const existing = result.candidates.find((item) => item.shortId === found.shortId);
    if (existing) return;
    result.candidates.push({ shortId: found.shortId, how, full: found.source === "full" });
  };

  // 1. Целиком введённый идентификатор — самый частый случай.
  const direct = tryResolve(trimmed);
  if (direct) addCandidate(direct, direct.source === "full" ? "полный идентификатор" : "код компьютера");

  // 2. Подписи из текста заявки («Код компьютера: …», «Полный идентификатор: …»).
  const shortLabeled = labeledMatch(text, SHORT_ID_LABELS);
  const shortResolved = tryResolve(shortLabeled?.raw);
  addCandidate(shortResolved, "подпись «Код компьютера»");
  const fullLabeled = labeledMatch(text, FULL_ID_LABELS);
  const fullResolved = tryResolve(fullLabeled?.raw);
  addCandidate(fullResolved, "подпись «Полный идентификатор»");
  if (fullLabeled && /^[0-9a-f]{64}$/i.test(clean(fullLabeled.raw))) result.machineId = clean(fullLabeled.raw).toLowerCase();

  // 3. Что-то похожее на код где угодно в тексте (письмо, пересланное сообщение).
  for (const match of text.matchAll(SHORT_TOKEN)) {
    // Код активации и полный идентификатор тоже содержат такие группы. Смотрим
    // на «соседей»: если вокруг непрерывная цепочка букв/цифр/дефисов длиннее
    // 20 символов — это кусок более длинного токена, а не код компьютера.
    if (insideLongToken(text, match.index ?? 0, match[0].length)) continue;
    if (insideHexRun(text, match.index ?? 0, match[0].length)) continue;
    addCandidate(tryResolve(match[0]), "похожий на код компьютера фрагмент");
  }
  for (const match of text.matchAll(HEX64)) {
    addCandidate(tryResolve(match[0]), "полный идентификатор в тексте");
    if (!result.machineId) result.machineId = match[0].toLowerCase();
  }
  // Полный идентификатор мог прийти с переносами внутри — тогда HEX64 его не
  // видит. Собираем hex-символы в одну строку и проверяем длину.
  if (!result.machineId) {
    const loose = longestHexRun(text);
    if (loose.length === FULL_HEX_LENGTH) {
      result.machineId = loose;
      addCandidate(tryResolve(loose), "полный идентификатор без переносов");
    }
  }

  if (!result.candidates.length) {
    return {
      ...result,
      message: "Не нашёл код компьютера. Нужен код вида XXXX-XXXX с экрана активации или полный идентификатор из 64 символов.",
    };
  }

  // Полная заявка приложения содержит оба идентификатора: сверяем. Взять нужно
  // ПОЛНЫЙ — короткий код приложение печатает из него же, значит полный точнее,
  // а в коротком легче опечататься при переписывании от руки.
  const chosen = result.candidates.find((item) => item.full) ?? result.candidates[0];
  if (chosen.full && shortResolved && shortResolved.shortId !== chosen.shortId) {
    result.conflicts.push(
      `Код компьютера ${core.prettyShortId(shortResolved.shortId)} не совпадает с полным идентификатором из заявки (там ${core.prettyShortId(chosen.shortId)}). Проверьте: привязка считается по полному.`,
    );
  }
  if (result.candidates.length > 1) {
    const others = result.candidates.filter((item) => item !== chosen).map((item) => core.prettyShortId(item.shortId));
    result.conflicts.push(`В тексте найдено несколько кодов компьютера: ${core.prettyShortId(chosen.shortId)}${others.length ? ` и ${others.join(", ")}` : ""}. Взят тот, что соответствует полному идентификатору.`);
  }

  result.shortId = chosen.shortId;
  result.pretty = core.prettyShortId(chosen.shortId);
  const version = VERSION.exec(text);
  if (version) result.version = version[0];
  const email = EMAIL.exec(text);
  if (email) result.email = email[0];
  const phones = [...text.matchAll(PHONE)].map((match) => match[0]).filter((value) => value.replace(/\D/g, "").length >= 10);
  if (phones.length) result.phone = clean(phones[0]);
  for (const pattern of NAME_PATTERNS) {
    const match = pattern.exec(text);
    if (match?.[1] && !/компьютер|идентификатор|заявк/i.test(match[1])) {
      result.name = clean(match[1]);
      break;
    }
  }

  return { ...result, ok: true, message: `Код компьютера: ${result.pretty}` };
}

/** Ищет в тексте готовый код активации (например, покупатель переслал своё же письмо). */
export function findActivationCode(input) {
  const text = String(input ?? "");
  if (!text.trim()) return "";
  const candidates = core.codeCandidates(text);
  for (const candidate of candidates) {
    try {
      const bytes = core.parseCode(candidate);
      if (core.parsePayload(bytes.subarray(0, core.PAYLOAD_LENGTH)).version === core.FORMAT_VERSION) return core.formatCode(bytes);
    } catch {
      /* следующий кандидат */
    }
  }
  return "";
}
