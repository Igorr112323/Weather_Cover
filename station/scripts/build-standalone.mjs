/**
 * Сборка автономной страницы «Активация ключей».
 *
 * Зачем: страница должна выдавать ровно те коды, которые принимает приложение.
 * Переписывать формат кода руками в JavaScript браузера нельзя — малейшее
 * расхождение даёт покупателю код, который приложение не примет. Поэтому
 * браузерная копия собирается автоматически:
 *
 *   · electron/license/core.cjs вставляется ЦЕЛИКОК (весь файл, кроме require и
 *     module.exports) — формат кода, base32, кандидаты, раскладка нагрузки;
 *   · из checkmode.cjs, license-shared.mjs и request.mjs берутся отдельные
 *     объявления по именам (имена перечислены ниже);
 *   · вместо node:crypto подставляется шим: SHA-256 на чистом JS (он нужен
 *     синхронно), Buffer, getRandomValues из WebCrypto.
 *
 * Криптография подписи остаётся браузерной (WebCrypto Ed25519) и живёт в
 * standalone/src/glue.js — она проверяется тестом на равенство вердиктов с
 * приложением.
 *
 * Запуск:
 *   node station/scripts/build-standalone.mjs           — собрать файл
 *   node station/scripts/build-standalone.mjs --check    — проверить, что файл актуален
 *
 * Выход: station/standalone/aktivaciya-klyuchey.html (готовая страница, один
 * файл, открывается двойным щелчком) и копия в station/public/, чтобы станция
 * отдавала её по ссылке /standalone/aktivaciya-klyuchey.html.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const STATION_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PROJECT_ROOT = path.resolve(STATION_ROOT, "..");

const SOURCES = {
  core: path.join(STATION_ROOT, "vendor", "core.cjs"),
  checkmode: path.join(STATION_ROOT, "vendor", "checkmode.cjs"),
  shared: path.join(STATION_ROOT, "vendor", "license-shared.mjs"),
  request: path.join(STATION_ROOT, "src", "request.mjs"),
  guard: path.join(STATION_ROOT, "vendor", "guard.cjs"),
};

const TEMPLATE = path.join(STATION_ROOT, "standalone", "template.html");
const GLUE = path.join(STATION_ROOT, "standalone", "src", "glue.js");
const OUT = [
  path.join(STATION_ROOT, "standalone", "aktivaciya-klyuchey.html"),
  path.join(STATION_ROOT, "public", "aktivaciya-klyuchey.html"),
];

/** Имена, которые берутся из файла выборкой (остальное в core не нужно вырезать). */
const CHECKMODE_NAMES = ["LICENSE_FILE_NAME", "CHECK_EXE_PREFIX", "INSTANCE_PATTERN", "sanitizeInstance", "licenseFileNameFor", "describeCheckInstance"];
const SHARED_NAMES = [
  "bindPayload",
  "LEDGER_COLUMNS",
  "LEDGER_HEADER",
  "ledgerCell",
  "legacyRow",
  "parseLedger",
  "serializeLedger",
  "ledgerNow",
  "buildBuyerMessage",
  "buildBuyerSms",
  "buildAgrolicContent",
  "agrolicFileName",
  "normalizeMachineCode",
];
const REQUEST_NAMES = [
  "SHORT_ID_LABELS",
  "FULL_ID_LABELS",
  "SHORT_TOKEN",
  "HEX64",
  "EMAIL",
  "PHONE",
  "VERSION",
  "NAME_PATTERNS",
  "insideLongToken",
  "clean",
  "tryResolve",
  "labeledMatch",
  "parseActivationRequest",
  "findActivationCode",
];
const GUARD_NAMES = ["REJECT_MESSAGES"];

/* ────────────────────────── разбор исходников ─────────────────────────── */

/**
 * Разбивает модуль на объявления верхнего уровня: {name, code}.
 * Стиль файлов проекта — объявления начинаются в нулевом столбце, поэтому
 * достаточно собирать строки до баланса скобок (строки и комментарии не
 * считаются). Так многострочные функции не режутся пополам.
 */
export function topLevelDeclarations(source) {
  const { code, delta } = analyse(source);
  const DECL = /^(?:export[ ]+)?(?:async[ ]+function|function|class|const|let|var)[ ]+([A-Za-z0-9_$]+)/;
  const raw = source.split("\n");
  const list = [];
  for (let index = 0; index < code.length; index += 1) {
    const match = DECL.exec(code[index]);
    if (!match) continue;
    let depth = 0;
    let last = index;
    while (last < code.length) {
      depth += delta[last];
      const trimmed = code[last].trimEnd();
      if (depth <= 0 && (trimmed.endsWith(";") || trimmed.endsWith("}"))) break;
      last += 1;
    }
    list.push({ name: match[1], code: raw.slice(index, last + 1).join("\n").trimEnd() });
    index = last;
  }
  return list;
}

/**
 * Разбирает исходник на строки «только код» (содержимое строк, шаблонов,
 * комментариев и регулярных литералов вырезано) плюс дельта глубины скобок для
 * каждой строки. Нужно для того, чтобы `/[(){}]/g` в регулярке не сбивал
 * подсчёт скобок и многострочное объявление вырезалось целиком.
 */
function analyse(source) {
  const rawLines = source.split("\n");
  const code = [];
  const delta = [];
  let state = "code";
  let depth = 0;
  let prev = "";
  let inClass = false;
  for (const line of rawLines) {
    const before = depth;
    let out = "";
    let i = 0;
    while (i < line.length) {
      const char = line[i];
      const next = line[i + 1];
      if (state === "block") {
        if (char === "*" && next === "/") { state = "code"; i += 2; continue; }
        i += 1;
        continue;
      }
      if (state === "sq" || state === "dq" || state === "tpl") {
        if (char === "\\") { i += 2; continue; }
        if ((state === "sq" && char === "'") || (state === "dq" && char === '"') || (state === "tpl" && char === "`")) state = "code";
        i += 1;
        continue;
      }
      if (state === "regex") {
        if (char === "\\") { i += 2; continue; }
        if (char === "[") inClass = true;
        else if (char === "]") inClass = false;
        else if (char === "/" && !inClass) state = "code";
        i += 1;
        continue;
      }
      if (char === "/" && next === "*") { state = "block"; i += 2; continue; }
      if (char === "/" && next === "/") break;
      if (char === "'" || char === '"' || char === "`") { state = char === "'" ? "sq" : char === '"' ? "dq" : "tpl"; out += " "; i += 1; continue; }
      if (char === "/" && (prev === "" || "(,=:[!&|?{};+-*%~^<>".includes(prev))) { state = "regex"; inClass = false; i += 1; continue; }
      if (char === "{" || char === "(" || char === "[") depth += 1;
      else if (char === "}" || char === ")" || char === "]") depth -= 1;
      if (!/\s/.test(char)) prev = char;
      out += char;
      i += 1;
    }
    if (state === "line") state = "code";
    code.push(out);
    delta.push(depth - before);
  }
  return { code, delta };
}

/** Берёт объявления по именам, в исходном порядке, с удалением `export`. */
export function pick(source, names, { file = "" } = {}) {
  const declarations = topLevelDeclarations(source);
  const byName = new Map();
  for (const item of declarations) if (!byName.has(item.name)) byName.set(item.name, item);
  const missing = names.filter((name) => !byName.has(name));
  if (missing.length) throw new Error(`${file || "файл"}: не найдены объявления: ${missing.join(", ")}`);
  const chosen = declarations.filter((item) => names.includes(item.name));
  return chosen.map((item) => item.code.replace(/^export[ \t]+/, "").trimEnd()).join("\n\n");
}

/** Весь модуль кроме require/exports — так core.cjs попадает в браузер дословно. */
export function wholeModuleExceptCrypto(source) {
  const lines = source.split("\n");
  const kept = [];
  let inExports = false;
  for (const line of lines) {
    if (/^const crypto = require\("node:crypto"\);?$/.test(line.trim())) continue;
    if (/^"use strict";?$/.test(line.trim())) continue;
    if (/^(export )?module\.exports = \{/.test(line.trim())) {
      inExports = true;
      continue;
    }
    if (inExports) {
      if (/^\};?$/.test(line.trim())) inExports = false;
      continue;
    }
    kept.push(line);
  }
  const body = kept.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd();
  // экспортные имена берём из самого файла: список не должен расходиться
  const exportsBlock = /module\.exports = \{([\s\S]*?)\};/.exec(source);
  const names = exportsBlock
    ? exportsBlock[1]
        .split(",")
        .map((part) => part.trim().replace(/:.*$/, "").trim())
        .filter((part) => /^[A-Za-z0-9_$]+$/.test(part))
    : [];
  if (!names.length) throw new Error("в core.cjs не найден module.exports");
  return { body, names };
}

/* ───────────────────────────── шимы браузера ───────────────────────────── */

const PRIME = (index) => {
  let found = 0;
  for (let n = 2; ; n += 1) {
    let prime = true;
    for (let d = 2; d * d <= n; d += 1) if (n % d === 0) { prime = false; break; }
    if (prime) {
      found += 1;
      if (found === index) return n;
    }
  }
};
const frac = (root) => Math.floor((root - Math.floor(root)) * 4294967296) >>> 0;
const SHA_K = Array.from({ length: 64 }, (_, index) => frac(Math.cbrt(PRIME(index + 1))));
const SHA_H = Array.from({ length: 8 }, (_, index) => frac(Math.sqrt(PRIME(index + 1))));

const SHIM = `/* ── шимы браузера (сгенерировано, не править руками) ──────────────────────
 * Ядро лицензирования написано под Node: им нужны createHash/createHMAC,
 * randomBytes, timingSafeEqual и Buffer. В браузере это даёт тот же результат:
 * SHA-256 считается на чистом JS (синхронно — иначе ядро не работает),
 * случайные байты берёт WebCrypto, сравнение байтов постоянное по времени.
 */
const webcrypto = globalThis.crypto;
const te = new TextEncoder();

class Buf extends Uint8Array {
  toString(encoding) {
    if (encoding === "hex") return Array.from(this, (byte) => byte.toString(16).padStart(2, "0")).join("");
    if (encoding === "base64") return btoa(String.fromCharCode(...this));
    if (encoding === "utf8" || encoding === undefined) return new TextDecoder().decode(this);
    throw new Error("Неизвестное кодирование: " + encoding);
  }
  static from(value, encoding) {
    if (typeof value === "string") {
      if (encoding === "base64") {
        const binary = atob(value.replace(/\\s+/g, ""));
        const bytes = new Uint8Array(binary.length);
        for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
        return new Buf(bytes);
      }
      return new Buf(te.encode(value));
    }
    if (value instanceof Uint8Array) return new Buf(value);
    return new Buf(Uint8Array.from(value));
  }
  static alloc(size) { return new Buf(new Uint8Array(size)); }
  static isBuffer(value) { return value instanceof Buf; }
}
const Buffer = Buf;

const SHA_K = new Uint32Array([${SHA_K.join(",")}]);
const SHA_H0 = new Uint32Array([${SHA_H.join(",")}]);

/** SHA-256 (FIPS 180-4). Тот же результат, что у crypto.createHash("sha256"). */
function sha256(message) {
  const bytes = typeof message === "string" ? te.encode(message) : message;
  const length = bytes.length;
  const withPadding = new Uint8Array((((length + 9) >> 6) + 1) << 6);
  withPadding.set(bytes);
  withPadding[length] = 0x80;
  const bits = length * 8;
  const view = new DataView(withPadding.buffer);
  view.setUint32(withPadding.length - 8, Math.floor(bits / 4294967296));
  view.setUint32(withPadding.length - 4, bits >>> 0);

  const h = SHA_H0.slice();
  const w = new Uint32Array(64);
  for (let offset = 0; offset < withPadding.length; offset += 64) {
    for (let index = 0; index < 16; index += 1) w[index] = view.getUint32(offset + index * 4);
    for (let index = 16; index < 64; index += 1) {
      const s0 = rotr(w[index - 15], 7) ^ rotr(w[index - 15], 18) ^ (w[index - 15] >>> 3);
      const s1 = rotr(w[index - 2], 17) ^ rotr(w[index - 2], 19) ^ (w[index - 2] >>> 10);
      w[index] = (w[index - 16] + s0 + w[index - 7] + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, hh] = h;
    for (let index = 0; index < 64; index += 1) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (hh + S1 + ch + SHA_K[index] + w[index]) >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (S0 + maj) >>> 0;
      hh = g; g = f; f = e; e = (d + temp1) >>> 0;
      d = c; c = b; b = a; a = (temp1 + temp2) >>> 0;
    }
    h[0] = (h[0] + a) >>> 0; h[1] = (h[1] + b) >>> 0; h[2] = (h[2] + c) >>> 0; h[3] = (h[3] + d) >>> 0;
    h[4] = (h[4] + e) >>> 0; h[5] = (h[5] + f) >>> 0; h[6] = (h[6] + g) >>> 0; h[7] = (h[7] + hh) >>> 0;
  }
  const out = new Uint8Array(32);
  const outView = new DataView(out.buffer);
  for (let index = 0; index < 8; index += 1) outView.setUint32(index * 4, h[index]);
  return out;
}
function rotr(value, bits) { return ((value >>> bits) | (value << (32 - bits))) >>> 0; }

function concatBytes(chunks) {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { out.set(chunk, offset); offset += chunk.length; }
  return out;
}

const crypto = {
  createHash() {
    const chunks = [];
    return {
      update(data) { chunks.push(typeof data === "string" ? te.encode(data) : new Uint8Array(data)); return this; },
      digest() { return new Buf(sha256(concatBytes(chunks))); },
    };
  },
  randomBytes(size) {
    const bytes = new Uint8Array(size);
    webcrypto.getRandomValues(bytes);
    return new Buf(bytes);
  },
  timingSafeEqual(a, b) {
    if (!(a instanceof Uint8Array) || !(b instanceof Uint8Array) || a.byteLength !== b.byteLength) return false;
    let diff = 0;
    for (let index = 0; index < a.byteLength; index += 1) diff |= a[index] ^ b[index];
    return diff === 0;
  },
  createPublicKey() {
    throw new Error("Открытый ключ в браузере импортирует WebCrypto (glue.js), не Node.");
  },
  verify() {
    throw new Error("Синхронная проверка подписи в браузере невозможна: используйте AGRO.verifyCode (он ждёт WebCrypto).");
  },
};`;

/* ─────────────────────────────── сборка ─────────────────────────────────── */

export function buildBundle({ indent = "      " } = {}) {
  const core = fs.readFileSync(SOURCES.core, "utf8");
  const { body: coreBody, names: coreNames } = wholeModuleExceptCrypto(core);
  const checkmode = pick(fs.readFileSync(SOURCES.checkmode, "utf8"), CHECKMODE_NAMES, { file: "checkmode.cjs" });
  const shared = pick(fs.readFileSync(SOURCES.shared, "utf8"), SHARED_NAMES, { file: "license-shared.mjs" });
  const request = pick(fs.readFileSync(SOURCES.request, "utf8"), REQUEST_NAMES, { file: "request.mjs" });
  const guard = pick(fs.readFileSync(SOURCES.guard, "utf8"), GUARD_NAMES, { file: "guard.cjs" });
  const glue = fs.readFileSync(GLUE, "utf8");

  const block = `/**
 * ══════════════════════════════════════════════════════════════════════════
 * ЭТОТ БЛОК СОБРАН АВТОМАТИЧЕСКИ: node station/scripts/build-standalone.mjs
 * Источник — electron/license/core.cjs (дословно), checkmode.cjs,
 * license-shared.mjs, request.mjs, guard.cjs + шимы для браузера.
 * Руками здесь править нельзя: правьте исходники проекта и пересоберите
 * страницу (в CI есть проверка --check).
 * ══════════════════════════════════════════════════════════════════════════
 */
const AGRO_CORE = (() => {
${SHIM}

${coreBody}

return { ${coreNames.join(", ")} };
})();

/* Имена REJECT → человеческие тексты (те же, что показывает приложение). */
const AGRO_MESSAGES = (() => {
const core = AGRO_CORE;
${guard}
return { REJECT_MESSAGES };
})();

/* Имя файла лицензии в проверочном режиме (тот же код, что в приложении). */
const AGRO_CM = (() => {
const path = { basename: (value) => String(value ?? "").split(/[\\\\/]/).pop() ?? "" };
${checkmode}
return { LICENSE_FILE_NAME, CHECK_EXE_PREFIX, sanitizeInstance, licenseFileNameFor, describeCheckInstance };
})();

/* Журнал выдачи и тексты покупателю — формат тот же, что у scripts/license-tool.mjs. */
const AGRO_L = (() => {
const core = AGRO_CORE;
${shared}
return { bindPayload, LEDGER_COLUMNS, LEDGER_HEADER, ledgerCell, parseLedger, serializeLedger, ledgerNow, buildBuyerMessage, buildBuyerSms, buildAgrolicContent, agrolicFileName, normalizeMachineCode };
})();

/* Разбор заявки покупателя (то же, что делает станция на сервере). */
const AGRO_R = (() => {
const core = AGRO_CORE;
${request}
return { parseActivationRequest, findActivationCode };
})();

/* Обвязка браузера: подпись и проверка кода через WebCrypto Ed25519. */
${glue.trimEnd()}
`;

  return block
    .split("\n")
    .map((line) => (line.length ? indent + line : line))
    .join("\n");
}

export function build() {
  const template = fs.readFileSync(TEMPLATE, "utf8");
  const marker = "<!-- @BUNDLE@ -->";
  if (!template.includes(marker)) throw new Error(`в шаблоне нет метки ${marker}`);
  return template.replace(marker, () => buildBundle());
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const check = process.argv.includes("--check");
  const output = build();
  if (check) {
    const stale = OUT.filter((file) => !fs.existsSync(file) || fs.readFileSync(file, "utf8") !== output);
    if (stale.length) {
      console.error(`Автономная страница устарела: ${stale.map((file) => path.relative(PROJECT_ROOT, file)).join(", ")}\nПересоберите: npm run station:standalone`);
      process.exit(1);
    }
    console.log("✔ автономная страница актуальна (совпадает со сборкой из исходников)");
  } else {
    for (const file of OUT) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, output, "utf8");
      console.log(`собрано: ${path.relative(PROJECT_ROOT, file)} (${(Buffer.byteLength(output) / 1024).toFixed(0)} КБ)`);
    }
  }
}
