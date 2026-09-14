/**
 * Настройки станции «Активация ключей».
 *
 * Станция работает в двух ситуациях:
 *
 *   1. РЯДОМ с клонированным проектом Weather_Cover (обычный случай у владельца):
 *      тогда используются его `secrets/license-key.json` (закрытый ключ),
 *      `secrets/ledger.csv` (журнал выдачи), `electron/license/keys.cjs`
 *      (открытые ключи и отзывы) и `release/AgroPrognoz-*.exe` (чтобы выдать
 *      ссылку на скачивание проверочной копии).
 *   2. ОТДЕЛЬНО от проекта (репозиторий «Активация ключей» cloned куда-то ещё):
 *      тогда всё то же самое читается из `data/` самой станции:
 *      `data/license-key.json`, `data/ledger.csv`, `data/keys.json`.
 *
 * Закрытый ключ никуда не отправляется: станция — локальный сервер, она только
 * подписывает код и возвращает в браузер результат. Каталог `data/` в
 * .gitignore, репозиторий может быть публичным.
 */

import { createRequire } from "node:module";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);

export const STATION_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const OUT_DIR_NAME = "out";

/** Имя файла проверочной копии: его читает приложение (electron/license/checkmode.cjs). */
export function checkExeName(instance) {
  return `AgroPrognoz-check-${instance}.exe`;
}

/** Идентификатор проверочного экземпляра: безопасные символы, длина ≤ 32. */
export function sanitizeInstance(raw) {
  const text = String(raw ?? "").trim().replace(/\s+/g, "-").replace(/[^A-Za-z0-9._-]/g, "");
  const cleaned = text.replace(/^[._-]+/, "").slice(0, 32).replace(/[._-]+$/, "");
  return cleaned.length >= 1 ? cleaned : "";
}

/** Новый уникальный идентификатор: каждая выдача — свежая песочница, код спрашивается заново. */
export function newInstance(now = Date.now()) {
  const stamp = new Date(now);
  const pad = (value) => String(value).padStart(2, "0");
  const date = `${pad(stamp.getDate())}${pad(stamp.getMonth() + 1)}`;
  const tail = Math.floor(now / 1000).toString(36).slice(-4);
  return sanitizeInstance(`t${date}-${tail}`) || "t0";
}

/** Ищём соседний клон проекта: ../Weather_Cover, ../weather_cover и AGRO_REPO. */
export function findProjectRepo({ stationRoot = STATION_ROOT, env = process.env, existsSync = fs.existsSync } = {}) {
  const candidates = [];
  if (env.AGRO_REPO) candidates.push(path.resolve(env.AGRO_REPO));
  const parent = path.dirname(stationRoot);
  const grandparent = path.dirname(parent);
  const names = ["Weather_Cover", "weather_cover", "Weather-Cover"];
  for (const base of [parent, grandparent]) {
    for (const name of names) candidates.push(path.join(base, name));
  }
  for (const candidate of candidates) {
    if (existsSync(path.join(candidate, "electron", "license", "keys.cjs"))) return candidate;
  }
  return null;
}

/**
 * @param {{root?:string, repo?:string|null, env?:object, existsSync?:(p:string)=>boolean}} [options]
 */
export function createConfig(options = {}) {
  const root = options.root ?? STATION_ROOT;
  const env = options.env ?? process.env;
  const existsSync = options.existsSync ?? fs.existsSync;
  const repo = options.repo !== undefined ? options.repo : findProjectRepo({ stationRoot: root, env, existsSync });
  const repoLinked = Boolean(repo) && existsSync(path.join(repo, "electron", "license", "keys.cjs"));

  const dataDir = path.join(root, "data");
  const outDir = env.AGRO_STATION_OUT ? path.resolve(env.AGRO_STATION_OUT) : path.join(root, OUT_DIR_NAME);
  const linked = (relative) => (repoLinked ? path.join(repo, relative) : "");

  const secretCandidates = [env.AGRO_LICENSE_KEY_FILE, linked("secrets/license-key.json"), path.join(dataDir, "license-key.json")].filter(Boolean);
  const ledgerCandidates = [env.AGRO_LEDGER_FILE, linked("secrets/ledger.csv"), path.join(dataDir, "ledger.csv")].filter(Boolean);
  // Порядок важнее удобства: сначала проект (там самые свежие отзывы), потом
  // локальная копия владельца, потом то, что приехало вместе со станцией.
  const keysCandidates = [
    env.AGRO_APP_KEYS_FILE,
    linked("electron/license/keys.cjs"),
    path.join(dataDir, "keys.json"),
    path.join(root, "keys.json"),
  ].filter(Boolean);

  /** Где искать готовые EXE: каталоги и конкретные файлы (первый попавшийся — база для проверочной копии). */
  const exeSources = String(env.AGRO_EXE ?? "")
    .split(path.delimiter)
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => path.resolve(item));
  if (!exeSources.length && repoLinked) exeSources.push(path.join(repo, "release"));

  /** Куда записывать проверочные копии. */
  // Явно заданный переменной окружения путь важнее «что нашлось»: файл журнала
  // или ключа может быть ещё не создан (первая выдача), и тогда его надо создать
  // именно там, где сказал владелец, а не там, где что-то нашлось.
  const chosen = (explicit, candidates) =>
    explicit ? path.resolve(explicit) : firstExisting(candidates, existsSync) ?? candidates[0] ?? "";
  const files = {
    secret: chosen(env.AGRO_LICENSE_KEY_FILE, secretCandidates),
    secretIsProjectFile: Boolean(repoLinked) && firstExisting(secretCandidates, existsSync) === linked("secrets/license-key.json"),
    ledger: chosen(env.AGRO_LEDGER_FILE, ledgerCandidates) || (repoLinked ? linked("secrets/ledger.csv") : path.join(dataDir, "ledger.csv")),
    keys: chosen(env.AGRO_APP_KEYS_FILE, keysCandidates) || keysCandidates[keysCandidates.length - 1],
    outDir,
    dataDir,
  };

  return {
    root,
    repo: repoLinked ? repo : null,
    repoLinked,
    files,
    exeSources,
    /** Прямая ссылка на EXE (GitHub Release), если локального файла нет. */
    exeUrl: String(env.AGRO_EXE_URL ?? "").trim(),
    host: env.AGRO_STATION_HOST ?? "127.0.0.1",
    port: Number(env.AGRO_STATION_PORT ?? 8793),
    /** Дополнительные разрешённые Host-заголовки (адрес превью или туннеля). */
    allowedHosts: String(env.AGRO_STATION_ALLOW_HOST ?? "")
      .split(/[;,]/)
      .map((item) => `.${item.trim().replace(/^\./, "")}`)
      .filter((item) => item !== "."),
    product: {
      name: "АгроПрогноз — Кукуруза",
      /** Версия приложения берётся из соседнего проекта, если он есть. */
      version: repoLinked ? readVersion(repo) : "",
    },
  };
}

function firstExisting(list, existsSync) {
  for (const item of list) {
    if (item && existsSync(item)) return item;
  }
  return null;
}

function readVersion(repo) {
  try {
    const raw = fs.readFileSync(path.join(repo, "package.json"), "utf8");
    return String(JSON.parse(raw).version ?? "");
  } catch {
    return "";
  }
}

/** Открытые ключи приложения: из keys.cjs соседнего проекта или из data/keys.json. */
export async function readAppKeys(keysFile, { loadModule } = {}) {
  const empty = { keys: [], revokedSerials: [] };
  if (!keysFile || !fs.existsSync(keysFile)) return { ...empty, source: null, missing: true };
  if (keysFile.endsWith(".cjs")) {
    const loaded = typeof loadModule === "function" ? loadModule(keysFile) : require(keysFile);
    return {
      keys: Array.isArray(loaded?.keys) ? loaded.keys : [],
      revokedSerials: Array.isArray(loaded?.revokedSerials) ? loaded.revokedSerials : [],
      source: keysFile,
      missing: false,
    };
  }
  try {
    const parsed = JSON.parse(await fsp.readFile(keysFile, "utf8"));
    return {
      keys: Array.isArray(parsed?.keys) ? parsed.keys : [],
      revokedSerials: Array.isArray(parsed?.revokedSerials) ? parsed.revokedSerials : [],
      source: keysFile,
      missing: false,
    };
  } catch {
    return { ...empty, source: keysFile, missing: true, broken: true };
  }
}

export { fsp };
