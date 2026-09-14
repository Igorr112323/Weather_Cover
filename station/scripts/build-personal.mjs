#!/usr/bin/env node
/**
 * Личная страница с ВШИТЫМ закрытым ключом: `npm run license:page`.
 *
 * Обычная страница (`station/personal/moy-klyuch.html` из репозитория) просит
 * закрытый ключ один раз в браузере. Этот скрипт делает вариант для владельца,
 * где спрашивать нечего: открыл файл, вставил «XXXX-XXXX (id)», нажал кнопку,
 * получил код. Два поля и одна кнопка — и ни слова про ключ.
 *
 *   node station/scripts/build-personal.mjs
 *   node station/scripts/build-personal.mjs --key ../secrets/license-key.json --key-id 2
 *   node station/scripts/build-personal.mjs --out ~/moy-klyuch.html
 *
 * Куда кладётся результат — важно:
 *
 *   · по умолчанию это `secrets/moy-klyuch.html`, а `secrets/` в `.gitignore`,
 *     потому что собранный файл содержит закрытый ключ;
 *   · в репозиторий, в issue, в чат и в мессенджер такой файл класть нельзя:
 *     у всякого, кто его получит, — право выписывать коды активации;
 *   · сам скрипт ключ не печатает и не отправляет: он только подставляет
 *     значение в разметку.
 *
 * Формат кода и проверка подписи при этом те же, что у приложения: страница
 * собирается из electron/license/* через build-standalone.mjs, а вшитый ключ
 * обязательно сверяется с electron/license/keys.cjs — не тот ключ не даст
 * выдать код, а не выдаст код, который EXE не примет.
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import process from "node:process";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const STATION_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PROJECT_ROOT = path.resolve(STATION_ROOT, "..");
const builder = await import(pathToFileURL(path.join(STATION_ROOT, "scripts", "build-standalone.mjs")).href);

/** Строка, которую заменяем: пустое значение = ключ не вшит (файл из репозитория). */
const MARKER = 'const BAKED_SECRET = "";';

/* ────────────────────────────── ключ владельца ───────────────────────────── */

/**
 * Читает из secrets/license-key.json одну запись { keyId, privateKey, publicKey }.
 * --key-id не указан — берём последнюю добавленную пару (свежая всегда новая).
 */
export function readKeyEntry(secretFile, keyId = 0) {
  if (!fs.existsSync(secretFile)) {
    throw new Error(`нет файла ключа: ${secretFile}\nСоздайте: npm run license:keygen`);
  }
  const parsed = JSON.parse(fs.readFileSync(secretFile, "utf8"));
  const list = (Array.isArray(parsed?.keys) ? parsed.keys : Array.isArray(parsed) ? parsed : [parsed]).filter(
    (entry) => entry && typeof entry.privateKey === "string" && entry.privateKey.trim(),
  );
  if (!list.length) throw new Error(`в ${secretFile} нет privateKey`);
  const wanted = Number(keyId) || 0;
  const entry = wanted ? list.find((item) => Number(item.keyId) === wanted) : list[list.length - 1];
  if (!entry) throw new Error(`в ${secretFile} нет ключа key-id=${wanted}; есть: ${list.map((item) => item.keyId).join(", ")}`);
  if (!entry.publicKey) throw new Error(`у ключа key-id=${entry.keyId} нет publicKey — сверка с приложением невозможна`);

  // Сверка с тем же списком открытых ключей, которым EXE проверяет подпись.
  const appKeys = require(path.join(PROJECT_ROOT, "electron", "license", "keys.cjs"));
  const trusted = (appKeys.keys ?? []).filter((item) => Number(item.keyId) === Number(entry.keyId));
  if (!trusted.length) {
    throw new Error(
      `ключ key-id=${entry.keyId} не добавлен в electron/license/keys.cjs — приложение такой код не примет.\n` +
        `Добавьте: npm run license:keygen -- --key-id ${entry.keyId} (или верните publicKey в keys.cjs)`,
    );
  }
  if (trusted[0].publicKey !== entry.publicKey) {
    throw new Error(`publicKey ключа key-id=${entry.keyId} не совпадает с electron/license/keys.cjs — страница бы выдавала коды, которые EXE отклоняет`);
  }
  return { keyId: Number(entry.keyId), privateKey: entry.privateKey.trim(), publicKey: entry.publicKey };
}

/* ─────────────────────────────── сборка файла ────────────────────────────── */

/** Вшивает ключ в собранную страницу. */
export function bake(html, entry) {
  if (!html.includes(MARKER)) throw new Error(`в странице нет метки ${MARKER} — шаблон изменился, поправьте скрипт`);
  const literal = JSON.stringify(JSON.stringify({ keyId: entry.keyId, privateKey: entry.privateKey, publicKey: entry.publicKey }));
  return html.replace(MARKER, `const BAKED_SECRET = ${literal};`);
}

/**
 * Снимает комментарии: убираются только строки, которые являются комментарием
 * целиком (block-комментарии отслеживаются состоянием), — код от этого короче и
 * читается легче. Это «не читать простыню», а не способ что-то спрятать: ключ
 * в файле остаётся ключом. Результат всё равно проверяется `node --check`
 * (см. main): не прошёл проверку — комментарии остаются.
 */
export function stripComments(html) {
  const out = [];
  let inBlock = false;
  for (const line of html.split("\n")) {
    const trimmed = line.trim();
    if (inBlock) {
      if (trimmed.endsWith("*/") || trimmed.endsWith("-->")) inBlock = false;
      continue;
    }
    if (trimmed.startsWith("/*") || trimmed.startsWith("<!--")) {
      const closed = trimmed.length > 4 && (trimmed.endsWith("*/") || trimmed.endsWith("-->"));
      inBlock = !closed;
      continue;
    }
    if (trimmed.startsWith("//")) continue;
    out.push(line);
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n");
}

/** Проверка, что после зачистки скрипт страницы всё ещё разбирается Node. */
function scriptParses(html) {
  const script = /<script>([\s\S]*)<\/script>/.exec(html);
  if (!script) return false;
  const temp = path.join(os.tmpdir(), `agro-personal-check-${process.pid}.cjs`);
  fs.writeFileSync(temp, script[1], "utf8");
  try {
    return require("node:child_process").spawnSync(process.execPath, ["--check", temp]).status === 0;
  } finally {
    fs.rmSync(temp, { force: true });
  }
}

/* ───────────────────────────────── CLI ──────────────────────────────────── */

function parseArgs(argv) {
  const flags = { key: "", "key-id": 0, out: "", keep: false };
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (item === "--key") flags.key = argv[++index] ?? "";
    else if (item.startsWith("--key=")) flags.key = item.slice(6);
    else if (item === "--key-id") flags["key-id"] = argv[++index] ?? 0;
    else if (item.startsWith("--key-id=")) flags["key-id"] = item.slice(9);
    else if (item === "--out") flags.out = argv[++index] ?? "";
    else if (item.startsWith("--out=")) flags.out = item.slice(6);
    else if (item === "--keep-comments") flags.keep = true;
  }
  return flags;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const flags = parseArgs(process.argv.slice(2));
  const secretFile = path.resolve(flags.key ? flags.key : path.join(PROJECT_ROOT, "secrets", "license-key.json"));
  let entry;
  try {
    entry = readKeyEntry(secretFile, flags["key-id"]);
  } catch (error) {
    console.error(`\n✘ ${error.message}\n`);
    process.exit(1);
  }
  const baked = bake(builder.buildPersonal(), entry);
  let output = baked;
  let stripped = false;
  if (!flags.keep) {
    const clean = stripComments(baked);
    if (scriptParses(clean)) {
      output = clean;
      stripped = true;
    } else {
      console.error("! зачистку комментариев отменил: страница перестала разбираться — оставляю комментарии");
    }
  }
  const target = path.resolve(flags.out ? flags.out.replace(/^~(?=$|\/)/, os.homedir()) : path.join(PROJECT_ROOT, "secrets", "moy-klyuch.html"));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, output, { encoding: "utf8", mode: 0o600 });
  console.log(`\n✔ Страница собрана: ${path.relative(PROJECT_ROOT, target) || target}`);
  console.log(`  размер ${(Buffer.byteLength(output) / 1024).toFixed(0)} КБ · ключ key-id=${entry.keyId} вшит · комментарии ${stripped ? "сняты" : "оставлены"}`);
  console.log("  Это файл с правом подписи: держите его у себя, в git и в переписку он попадать не должен.\n");
}
