#!/usr/bin/env node
/**
 * Диагноз падения CI — публикация хвостов логов в обсуждение.
 *
 * Зачем: логи GitHub Actions лежат на отдельном хосте, который не всегда
 * доступен (корпоративные прокси, песочницы), а api.github.com доступен почти
 * всегда. Поэтому при падении job'а хвосты логов уходят комментарием в PR
 * (или новой задачей, если запускалось по push) — их можно прочитать через API.
 *
 * Логи берутся из каталогов ci-logs/ и tests/smoke/debug/ (все *.log), каждый
 * обрезается до последних строк, весь отчёт — до лимита комментария GitHub.
 *
 * Переменные окружения:
 *   GH_TOKEN      — токен для gh (обязательно)
 *   PR_NUMBER     — номер pull request; если пусто, создаётся задача
 *   CI_REPORT_LINES — строк на файл (по умолчанию 120)
 *   CI_REPORT_BYTES — предел размера отчёта (по умолчанию 60000)
 *
 * Скрипт никогда не роняет job: любая ошибка — сообщение и выход с кодом 0.
 */

import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, statSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LOG_DIRS = ["ci-logs", path.join("tests", "smoke", "debug")];
const LINES_PER_FILE = Number(process.env.CI_REPORT_LINES ?? 120);
const MAX_BYTES = Number(process.env.CI_REPORT_BYTES ?? 60000);

function collectLogs() {
  const found = [];
  for (const dir of LOG_DIRS) {
    const absolute = path.join(ROOT, dir);
    let entries = [];
    try {
      entries = readdirSync(absolute);
    } catch {
      continue;
    }
    for (const entry of entries.sort()) {
      if (!entry.endsWith(".log")) continue;
      const file = path.join(absolute, entry);
      try {
        if (!statSync(file).isFile()) continue;
      } catch {
        continue;
      }
      found.push({ name: path.posix.join(dir.split(path.sep).join("/"), entry), file });
    }
  }
  return found;
}

function tail(file, lines) {
  try {
    const text = readFileSync(file, "utf8").replace(/\r\n/g, "\n");
    const all = text.split("\n");
    const wanted = all.slice(-lines);
    const dropped = all.length - wanted.length;
    return (dropped > 0 ? `… (пропущено строк выше: ${dropped})\n` : "") + wanted.join("\n");
  } catch (error) {
    return `лог не читается: ${error?.message ?? error}`;
  }
}

function buildReport() {
  const job = process.env.GITHUB_JOB ?? "job";
  const run = process.env.GITHUB_RUN_NUMBER ?? "?";
  const ref = process.env.GITHUB_REF_NAME ?? process.env.GITHUB_REF ?? "?";
  const sha = (process.env.GITHUB_SHA ?? "").slice(0, 7);
  const logs = collectLogs();

  const parts = [`### CI: падение — «${job}» (прогон ${run}, ${ref}${sha ? ` @ ${sha}` : ""})`, ""];
  if (!logs.length) {
    parts.push("Логи шагов не сохранены: смотреть вывод job'а в Actions.", "");
  }
  for (const log of logs) {
    parts.push(`<details><summary><code>${log.name}</code></summary>`, "", "```text", tail(log.file, LINES_PER_FILE), "```", "", "</details>", "");
  }
  parts.push(`_Опубликовано автоматически скриптом \`scripts/ci-report.mjs\`._`);

  let body = parts.join("\n");
  if (Buffer.byteLength(body) > MAX_BYTES) {
    body = `${body.slice(0, MAX_BYTES)}\n\n… (отчёт обрезан по размеру)\n`;
  }
  return body;
}

function main() {
  const token = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN;
  if (!token) {
    console.log("ci-report: нет GH_TOKEN — публикация пропускается");
    return;
  }
  const body = buildReport();
  const dir = mkdtempSync(path.join(os.tmpdir(), "agro-ci-report-"));
  const file = path.join(dir, "report.md");
  writeFileSync(file, body, "utf8");

  const prNumber = process.env.PR_NUMBER ?? "";
  const args = prNumber
    ? ["pr", "comment", prNumber, "--repo", repo(), "--body-file", file]
    : [
        "issue",
        "create",
        "--repo",
        repo(),
        "--title",
        `[CI] падение «${process.env.GITHUB_JOB ?? "job"}» (прогон ${process.env.GITHUB_RUN_NUMBER ?? "?"})`,
        "--body-file",
        file,
      ];

  try {
    const output = execFileSync("gh", args, {
      encoding: "utf8",
      env: { ...process.env, GH_TOKEN: token },
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 120000,
    });
    console.log(`ci-report: опубликовано ${String(output).trim() || "(комментарий)"}`);
  } catch (error) {
    console.log(`ci-report: публикация не удалась (${error?.message ?? error})`);
    console.log(body.slice(0, 4000));
  } finally {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* не важно */
    }
  }
}

function repo() {
  const slug = process.env.GITHUB_REPOSITORY;
  if (slug) return slug;
  try {
    const url = execFileSync("git", ["remote", "get-url", "origin"], { encoding: "utf8", cwd: ROOT }).trim();
    const match = url.match(/github\.com[:/]([^/]+\/[^/.]+)/);
    return match ? match[1] : "";
  } catch {
    return "";
  }
}

main();
