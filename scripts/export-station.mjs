#!/usr/bin/env node
/**
 * Выгрузка станции «Активация ключей» в отдельный репозиторий.
 *
 *   npm run station:export                       → ..\agro-activation-keys
 *   npm run station:export -- --dest D:\keys     → указанный каталог
 *   npm run station:export -- --fresh              стереть и скопировать заново
 *
 * Копируется только то, что должно попасть в git: `data/` (закрытый ключ и
 * журнал) и `out/` (проверочные копии EXE) не копируются и в репозиторий
 * станции не попадают никогда — они в её .gitignore.
 */

import fsp from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE = path.join(ROOT, "station");
const SKIP = new Set(["data", "out", "node_modules", ".git", "screenshots"]);
const SKIP_FILES = /\.(agrolic|log|tmp)$/i;

function parseArgs(argv) {
  const flags = { dest: path.join(ROOT, "..", "agro-activation-keys"), fresh: false };
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (item === "--dest") flags.dest = path.resolve(String(argv[index + 1] ?? ""));
    else if (item.startsWith("--dest=")) flags.dest = path.resolve(item.slice(7));
    else if (item === "--fresh") flags.fresh = true;
    else if (item === "--help" || item === "-h") flags.help = true;
  }
  return flags;
}

async function copyTree(from, to, counter) {
  const entries = await fsp.readdir(from, { withFileTypes: true });
  await fsp.mkdir(to, { recursive: true });
  for (const entry of entries) {
    if (entry.isDirectory() && SKIP.has(entry.name)) continue;
    if (entry.isFile() && SKIP_FILES.test(entry.name)) continue;
    const source = path.join(from, entry.name);
    const target = path.join(to, entry.name);
    if (entry.isDirectory()) {
      await copyTree(source, target, counter);
    } else if (entry.isFile()) {
      await fsp.copyFile(source, target);
      counter.files += 1;
      counter.bytes += (await fsp.stat(target)).size;
    }
  }
}

const flags = parseArgs(process.argv.slice(2));
if (flags.help) {
  process.stdout.write(
    "\nВыгрузка станции «Активация ключей» в отдельный репозиторий.\n\n" +
      "  npm run station:export                    → ../agro-activation-keys\n" +
      "  npm run station:export -- --dest <путь>  → указанный каталог\n" +
      "  npm run station:export -- --fresh        → сначала очистить каталог\n\n",
  );
  process.exit(0);
}

const dest = path.resolve(flags.dest);
if (dest === SOURCE) {
  process.stderr.write("\n✘ Каталог назначения совпадает с исходным — укажите --dest.\n\n");
  process.exit(1);
}
if (flags.fresh) await fsp.rm(dest, { recursive: true, force: true });

const counter = { files: 0, bytes: 0 };
await copyTree(SOURCE, dest, counter);

// Актуальные копии кода лицензирования: станция обязана идти тем же кодом.
const { execFile } = await import("node:child_process");
const sync = await new Promise((resolve) => {
  execFile(process.execPath, [path.join(dest, "scripts", "sync-vendor.mjs"), "--repo", ROOT], (error, stdout, stderr) => {
    resolve({ ok: !error, out: `${stdout}${stderr}` });
  });
});

process.stdout.write(
  `\n✔ Станция выгружена: ${dest}\n` +
    `  Файлов: ${counter.files} · ${(counter.bytes / 1024).toFixed(0)} КБ\n` +
    (sync.ok ? "  Копии кода лицензирования обновлены из этого проекта.\n" : `  ⚠ sync-vendor не выполнен:\n${sync.out}\n`) +
    "\n  Дальше — отдельный репозиторий «Активация ключей»:\n\n" +
    `    cd "${dest}"\n` +
    "    git init -b main\n" +
    "    git add -A\n" +
    '    git commit -m "Станция выдачи кодов активации"\n' +
    "    gh repo create agro-activation-keys --public --source=. --push \\\n" +
    '      --description "Активация ключей: выдача кодов и проверочных EXE"\n\n' +
    "  Без gh: создайте пустой репозиторий на GitHub и выполните\n" +
    "    git remote add origin https://github.com/ЛОГИН/agro-activation-keys.git\n" +
    "    git push -u origin main\n\n" +
    "  В git не попадут: data/ (закрытый ключ, журнал) и out/ (проверочные EXE) — они в .gitignore.\n\n",
);
