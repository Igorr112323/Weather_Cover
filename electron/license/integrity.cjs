/**
 * Самопроверка целостности файлов приложения (main process).
 *
 * ASAR — это упаковка, а не защита: содержимое можно распаковать, поправить
 * и упаковать обратно. Этот модуль делает ровно то, чего упаковке не хватает:
 * сверяет SHA-256 каждого важного файла сборки с манифестом, а корневые хэши
 * манифеста — с константами, зашитыми в guard.cjs на этапе сборки
 * (scripts/harden.mjs). Получается двухуровневая проверка:
 *
 *   guard.cjs (обфусцирован, самопроверяющийся)
 *      └─ корневой хэш манифеста → integrity-data.cjs (манифест)
 *                                    └─ хэши файлов dist/ и electron/
 *
 * Подмена любого файла рвёт цепочку. Подмена самого манифеста не совпадёт с
 * корневым хэшем в guard.cjs. Единственная точка, которую придётся ломать
 * вручную, — обфусцированный guard.cjs.
 *
 * Манифеста в исходниках нет (его создаёт сборка), поэтому в режиме разработки
 * проверка честно пропускается: skipped = true.
 */

"use strict";

const crypto = require("node:crypto");
const fsp = require("node:fs/promises");
const path = require("node:path");

/** Значение-заполнитель из исходников: пока оно на месте, проверка выключена. */
const PLACEHOLDER = /^__AGRO_[A-Z_]+__$/;
const HASH_PATTERN = /^[0-9a-f]{64}$/;
/** Путь стража внутри раздела electron — исключение из корневого хэша. */
const GUARD_RELATIVE_PATH = "license/guard.cjs";

const REASON = Object.freeze({
  MANIFEST: "MANIFEST",
  FILE: "FILE",
  MISSING: "MISSING",
});

/** Канонический вид карты «путь → хэш»: сортировка, по одной записи на строку. */
function canonicalManifest(entries) {
  const map = entries && typeof entries === "object" ? entries : {};
  return Object.keys(map)
    .sort()
    .map((key) => `${key}:${map[key]}`)
    .join("\n");
}

/** Корневой хэш раздела манифеста — то, что зашивается в guard.cjs. */
function manifestRootHash(entries) {
  return crypto.createHash("sha256").update(canonicalManifest(entries), "utf8").digest("hex");
}

/**
 * Файл стража не входит в собственный корневой хэш (иначе хэш зависел бы сам
 * от себя), но в манифест он попадает целиком: подмена guard.cjs ловится
 * сверкой файла с манифестом, а подмена манифеста — сверкой корневого хэша.
 */
function electronRootHash(entries) {
  const map = entries && typeof entries === "object" ? entries : {};
  const subset = {};
  for (const key of Object.keys(map)) {
    if (key === GUARD_RELATIVE_PATH) continue;
    subset[key] = map[key];
  }
  return manifestRootHash(subset);
}

function hashBytes(bytes) {
  return crypto.createHash("sha256").update(Buffer.from(bytes)).digest("hex");
}

function isUsableHash(value) {
  return typeof value === "string" && HASH_PATTERN.test(value);
}

/**
 * @param {object} options
 * @param {string} options.root корень приложения (в сборке — внутри app.asar)
 * @param {{dist?:Object<string,string>, electron?:Object<string,string>}} options.manifest
 * @param {{dist?:string, electron?:string}} options.rootHashes корневые хэши из guard.cjs
 * @param {(file:string)=>Promise<Uint8Array>} [options.readFile]
 * @param {(...args:any[])=>void} [options.log]
 */
function createIntegrityChecker({ root, manifest, rootHashes = {}, readFile, log = () => {} }) {
  const read =
    typeof readFile === "function"
      ? readFile
      : (file) => fsp.readFile(file);

  const sections = ["dist", "electron"];
  const enabled = sections.some((section) => isUsableHash(rootHashes?.[section]));

  /**
   * @returns {Promise<{ok:boolean, skipped:boolean, reason?:string, mismatches:string[], checked:number}>}
   */
  async function verify() {
    if (!enabled) {
      // Исходники без сборки: манифеста и корневых хэшей нет, проверять нечего.
      return { ok: true, skipped: true, mismatches: [], checked: 0 };
    }
    if (!manifest || typeof manifest !== "object") {
      return { ok: false, skipped: false, reason: REASON.MANIFEST, mismatches: ["manifest"], checked: 0 };
    }

    // Сначала корневые хэши: если манифест подменён целиком, файлы можно не читать.
    for (const section of sections) {
      const expected = rootHashes[section];
      if (!isUsableHash(expected)) continue;
      const actual = section === "electron" ? electronRootHash(manifest[section]) : manifestRootHash(manifest[section]);
      if (actual !== expected) {
        log(`integrity: корневой хэш раздела ${section} не совпал`);
        return { ok: false, skipped: false, reason: REASON.MANIFEST, mismatches: [`${section}:root`], checked: 0 };
      }
    }

    const mismatches = [];
    let checked = 0;
    for (const section of sections) {
      const entries = manifest[section] ?? {};
      for (const relative of Object.keys(entries).sort()) {
        const expected = entries[relative];
        if (!isUsableHash(expected)) {
          mismatches.push(`${section}/${relative}`);
          continue;
        }
        const absolute = path.join(root, section, relative);
        try {
          const bytes = await read(absolute);
          checked += 1;
          if (hashBytes(bytes) !== expected) mismatches.push(`${section}/${relative}`);
        } catch (error) {
          log(`integrity: ${section}/${relative} не читается (${error?.code ?? error?.message})`);
          mismatches.push(`${section}/${relative}`);
        }
      }
    }

    return { ok: mismatches.length === 0, skipped: false, mismatches, checked, reason: mismatches.length ? REASON.FILE : undefined };
  }

  return { verify, enabled, manifestRootHash };
}

module.exports = {
  GUARD_RELATIVE_PATH,
  PLACEHOLDER,
  REASON,
  canonicalManifest,
  createIntegrityChecker,
  electronRootHash,
  hashBytes,
  manifestRootHash,
};
