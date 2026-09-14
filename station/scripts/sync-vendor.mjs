#!/usr/bin/env node
/**
 * Обновление копий кода лицензирования в `vendor/`.
 *
 * Станция «Активация ключей» — отдельный репозиторий, а код формата кода,
 * идентификатора компьютера и хранилища лицензии должен быть ОДИН И ТОТ ЖЕ, что
 * в приложении: иначе станция может выдать код, который приложение не примет.
 * Поэтому файлы в `vendor/` — точные копии исходников проекта, а не пересказ:
 * их прижимает этот скрипт.
 *
 *   npm run sync                       # найти соседний проект Weather_Cover
 *   node scripts/sync-vendor.mjs --repo ../Weather_Cover
 *   node scripts/sync-vendor.mjs --check   # только проверить расхождение (CI)
 *
 * Единственная правка — путь импорта `core.cjs` в license-shared.mjs: в проекте и
 * в станции он лежит по-разному. Проверяется сравнением «как есть после правки».
 */

import { createRequire } from "node:module";
import crypto from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const STATION_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);

/**
 * relative-путь в проекте → файл станции. `patches` — единственные разрешённые
 * правки: пути импорта, потому что в проекте и в станции файлы лежат в разных
 * каталогах. Больше в копиях менять нельзя (для этого и --check).
 */
const IMPORT_PATCHES = [
  ['const core = require("../electron/license/core.cjs");', 'const core = require("./core.cjs");'],
  ['const store = require("../electron/license/store.cjs");', 'const store = require("./store.cjs");'],
  ['const core = require("../electron/license/core.cjs");', 'const core = require("./core.cjs");'],
  ['const checkmode = require("../electron/license/checkmode.cjs");', 'const checkmode = require("./checkmode.cjs");'],
];

const COPIES = [
  { from: "electron/license/core.cjs", to: "vendor/core.cjs" },
  { from: "electron/license/machine.cjs", to: "vendor/machine.cjs" },
  { from: "electron/license/store.cjs", to: "vendor/store.cjs" },
  { from: "electron/license/checkmode.cjs", to: "vendor/checkmode.cjs" },
  // guard.cjs станции не исполняет: из него берётся текст подсказок REJECT_MESSAGES
  { from: "electron/license/guard.cjs", to: "vendor/guard.cjs" },
  // открытые ключи приложения: единственная доверенная точка проверки подписи.
  // Нужна, чтобы автономная и личная страницы сверяли выданный код с тем же
  // списком ключей, что и EXE, а не с копией списка, вписанной руками.
  { from: "electron/license/keys.cjs", to: "vendor/keys.cjs" },
  { from: "scripts/license-shared.mjs", to: "vendor/license-shared.mjs", patches: IMPORT_PATCHES },
  { from: "scripts/activation-doctor-lib.mjs", to: "vendor/activation-doctor-lib.mjs", patches: IMPORT_PATCHES },
];

const HEADER = (relative, repo) =>
  `/* vendored: точная копия ${relative} из проекта ${repo ?? "Weather_Cover"}.\n * Не править руками — обновлять скриптом scripts/sync-vendor.mjs. */\n`;

function parseArgs(argv) {
  const flags = { repo: "", check: false };
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (item === "--repo") flags.repo = path.resolve(argv[index + 1] ?? "");
    else if (item.startsWith("--repo=")) flags.repo = path.resolve(item.slice(7));
    else if (item === "--check") flags.check = true;
  }
  return flags;
}

async function findRepo(explicit) {
  if (explicit) return explicit;
  const parent = path.dirname(STATION_ROOT);
  const candidates = [parent, path.dirname(parent)].flatMap((base) =>
    ["Weather_Cover", "weather_cover", "Weather-Cover"].map((name) => path.join(base, name)),
  );
  if (process.env.AGRO_REPO) candidates.unshift(path.resolve(process.env.AGRO_REPO));
  for (const candidate of candidates) {
    try {
      await fsp.access(path.join(candidate, "electron", "license", "core.cjs"));
      return candidate;
    } catch {
      /* следующий кандидат */
    }
  }
  return null;
}

function transform(source, { patches = [] } = {}) {
  let text = source;
  for (const [from, to] of patches) {
    if (!text.includes(from)) continue;
    text = text.split(from).join(to);
  }
  return text;
}

/** Сверяет хэши: станция не должна «слегка поправлять» чужую копию. */
export async function verifyVendor(repo) {
  const report = [];
  for (const item of COPIES) {
    const target = path.join(STATION_ROOT, item.to);
    let source;
    try {
      source = await fsp.readFile(path.join(repo, item.from), "utf8");
    } catch {
      report.push({ ...item, ok: false, detail: "нет исходника в проекте" });
      continue;
    }
    const expected = transform(source, item);
    // В файле есть шапка-комментарий: сравниваем тело без неё.
    const current = await fsp.readFile(target, "utf8").catch(() => null);
    if (current === null) {
      report.push({ ...item, ok: false, detail: "копии нет" });
      continue;
    }
    const body = current.replace(/^\/\* vendored:[\s\S]*?\*\/\n?/, "");
    const hash = (value) => crypto.createHash("sha256").update(value, "utf8").digest("hex").slice(0, 12);
    report.push({ ...item, ok: hash(body) === hash(expected), detail: `${hash(body)} vs ${hash(expected)}` });
  }
  return report;
}

const flags = parseArgs(process.argv.slice(2));
const repo = await findRepo(flags.repo);
if (!repo) {
  console.error("\n✘ Не найден проект Weather_Cover. Укажите путь: node scripts/sync-vendor.mjs --repo ..\\Weather_Cover\n");
  process.exit(1);
}

if (flags.check) {
  const report = await verifyVendor(repo);
  for (const item of report) console.log(`  ${item.ok ? "✔" : "✘"} ${item.to} — ${item.detail}`);
  process.exit(report.every((item) => item.ok) ? 0 : 1);
}

let changed = 0;
for (const item of COPIES) {
  const source = await fsp.readFile(path.join(repo, item.from), "utf8").catch(() => null);
  if (source === null) {
    console.error(`✘ Нет файла ${item.from} в ${repo}`);
    process.exit(1);
  }
  const target = path.join(STATION_ROOT, item.to);
  const body = `${HEADER(item.from, path.basename(repo))}${transform(source, item)}`;
  const current = await fsp.readFile(target, "utf8").catch(() => null);
  if (current === body) {
    console.log(`  • ${item.to} — без изменений`);
    continue;
  }
  await fsp.mkdir(path.dirname(target), { recursive: true });
  await fsp.writeFile(target, body, "utf8");
  console.log(`  ✓ ${item.to} ← ${item.from}`);
  changed += 1;
}

// Открытые ключи приложения (публичные) — чтобы станция умела проверять коды и
// без соседнего проекта. Закрытого ключа здесь нет и быть не должно.
try {
  const keysModule = require(path.join(repo, "electron", "license", "keys.cjs"));
  const payload = `${JSON.stringify({ keys: keysModule.keys ?? [], revokedSerials: keysModule.revokedSerials ?? [] }, null, 2)}\n`;
  const target = path.join(STATION_ROOT, "keys.json");
  const current = await fsp.readFile(target, "utf8").catch(() => null);
  if (current !== payload) {
    await fsp.writeFile(target, payload, "utf8");
    console.log("  ✓ keys.json ← electron/license/keys.cjs (только открытые ключи)");
    changed += 1;
  } else {
    console.log("  • keys.json — без изменений");
  }
} catch (error) {
  console.log(`  • открытые ключи не обновлены (${error.message})`);
}

console.log(`\n${changed ? `✔ Обновлено файлов: ${changed}` : "✔ Копии актуальны"}  (источник: ${repo})\n`);
