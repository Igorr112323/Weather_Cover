#!/usr/bin/env node
/**
 * Станция «Активация ключей» — выдача кодов и проверочных EXE.
 *
 *   npm start                     запустить и открыть в браузере
 *   npm start -- --port 9000      конкретный порт
 *   npm start -- --repo C:\proj\Weather_Cover   путь к проекту приложения
 *   npm start -- --exe D:\builds\AgroPrognoz-0.2.1-portable.exe   из чего делать проверочную копию
 *   npm start -- --exe-url https://github.com/…/download/v0.2.1/AgroPrognoz-0.2.1-portable.exe
 *                                 ссылка для покупателя (файл он переименует)
 *   npm start -- --lan            слушать всю сеть: ссылку можно открыть с
 *                                 другого компьютера (только доверенная сеть!)
 *   npm start -- --no-open        не открывать браузер
 *
 * Закрытый ключ читается с этого же компьютера (secrets/license-key.json проекта
 * или data/license-key.json станции) и в браузер не отдаётся: страница получает
 * только готовый код. Каталог с ключом и журналом в .gitignore — репозиторий
 * станции можно делать публичным.
 */

import crypto from "node:crypto";
import { execFile } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { STATION_ROOT, createConfig } from "./config.mjs";
import { createStation } from "./backend.mjs";
import { startStationServer } from "./server.mjs";

function parseArgs(argv) {
  const flags = { port: undefined, host: undefined, open: true, help: false, repo: undefined, exe: [], exeUrl: undefined, out: undefined, allowHost: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    const next = () => String(argv[(index += 1)] ?? "");
    if (item === "--port" || item === "--port=") flags.port = Number(next());
    else if (item.startsWith("--port=")) flags.port = Number(item.slice(7));
    else if (item === "--host") flags.host = next();
    else if (item === "--lan") flags.host = "0.0.0.0";
    else if (item === "--allow-host") flags.allowHost.push(next());
    else if (item.startsWith("--allow-host=")) flags.allowHost.push(item.slice(13));
    else if (item === "--repo") flags.repo = path.resolve(next());
    else if (item.startsWith("--repo=")) flags.repo = path.resolve(item.slice(7));
    else if (item === "--exe") flags.exe.push(path.resolve(next()));
    else if (item.startsWith("--exe=")) flags.exe.push(path.resolve(item.slice(6)));
    else if (item === "--exe-url") flags.exeUrl = next();
    else if (item.startsWith("--exe-url=")) flags.exeUrl = item.slice(10);
    else if (item === "--out") flags.out = path.resolve(next());
    else if (item.startsWith("--out=")) flags.out = path.resolve(item.slice(6));
    else if (item === "--no-open") flags.open = false;
    else if (item === "--help" || item === "-h") flags.help = true;
  }
  return flags;
}

function openBrowser(url) {
  const commands = {
    win32: { file: "cmd", args: ["/c", "start", "", url] },
    darwin: { file: "open", args: [url] },
    linux: { file: "xdg-open", args: [url] },
  }[process.platform];
  if (!commands) return;
  execFile(commands.file, commands.args, () => {
    /* браузер не открылся — ссылка уже напечатана в консоли */
  });
}

const flags = parseArgs(process.argv.slice(2));
if (flags.help) {
  process.stdout.write(
    "\nСтанция «Активация ключей» — выдача кодов активации и проверочных EXE.\n\n" +
      "  npm start                      запустить (страница откроется сама)\n" +
      "  npm start -- --port 9000       конкретный порт\n" +
      "  npm start -- --repo <путь>     путь к проекту Weather_Cover\n" +
      "  npm start -- --exe <путь>      EXE, из которого делать проверочную копию\n" +
      "  npm start -- --exe-url <url>   ссылка на EXE для покупателя\n" +
      "  npm start -- --lan             доступ из локальной сети (осторожно)\n" +
      "  npm start -- --no-open         не открывать браузер\n\n",
  );
  process.exit(0);
}

const env = { ...process.env };
if (flags.exe.length) env.AGRO_EXE = flags.exe.join(path.delimiter);
if (flags.exeUrl) env.AGRO_EXE_URL = flags.exeUrl;
if (flags.out) env.AGRO_STATION_OUT = flags.out;
if (flags.repo) env.AGRO_REPO = flags.repo;

const config = { ...createConfig({ root: STATION_ROOT, repo: flags.repo, env }), env };
const backend = createStation({ config });
const token = crypto.randomBytes(20).toString("hex");

await fsp.mkdir(config.files.outDir, { recursive: true }).catch(() => {});

const wantedPort = Number.isInteger(flags.port) && flags.port > 0 ? flags.port : config.port;
const host = flags.host ?? config.host ?? "127.0.0.1";
let server = null;
for (let candidate = wantedPort; candidate < wantedPort + 16 && !server; candidate += 1) {
  try {
    // eslint-disable-next-line no-await-in-loop
    // Переменные окружения и флаги складываются; нормализация одна: «e2b.app»
    // и «.e2b.app» означают «эти хосты тоже хорошие».
    const allowedHosts = [...config.allowedHosts, ...flags.allowHost]
      .map((item) => String(item).trim().replace(/^\./, ""))
      .filter(Boolean);
    server = await startStationServer({
      backend,
      token,
      host: allowedHosts.length && host === "127.0.0.1" ? "0.0.0.0" : host,
      port: candidate,
      allowedHosts: allowedHosts.map((item) => (item.startsWith(".") ? item : `.${item}`)),
    });
  } catch (error) {
    if (error?.code !== "EADDRINUSE") {
      process.stderr.write(`\n✘ Не удалось запустить сервер: ${error?.message ?? error}\n\n`);
      process.exit(1);
    }
  }
}
if (!server) {
  process.stderr.write(`\n✘ Порт ${wantedPort} (и 15 следующих) занят. Свой порт: npm start -- --port 9100\n\n`);
  process.exit(1);
}

const state = await backend.state().catch(() => ({ secret: { available: false }, published: {}, exe: { sources: [] }, repoLinked: false, machine: {} }));
const lines = [
  "",
  "┌──────────────────────────────────────────────────────────────────────┐",
  "│  АКТИВАЦИЯ КЛЮЧЕЙ — АгроПрогноз — Кукуруза                            │",
  "│  Лицензии бессрочные: поля «действует до» не существует               │",
  "└──────────────────────────────────────────────────────────────────────┘",
  `  Страница:            ${server.url}`,
  `  Закрытый ключ:       ${state.secret?.available ? `есть — ${config.files.secret}` : `✘ нет — ${config.files.secret}`}`,
  `  Открытые ключи:      ${(state.published?.keyIds ?? []).join(", ") || "✘ не найдены"} (отзывов: ${state.published?.revokedCount ?? 0})`,
  `  Проект приложения:   ${config.repo ? config.repo : "не найден (станция работает со своими файлами в data/)"}`,
  `  Журнал выдачи:       ${config.files.ledger}${state.ledger?.total ? ` (${state.ledger.total} записей)` : ""}`,
  `  EXE для проверки:    ${(state.exe?.sources ?? []).map((item) => item.name).join(", ") || "не найдены — используйте ссылку"} `,
  `  Проверочные копии:    ${config.files.outDir}`,
  `  Код этого компьютера: ${state.machine?.shortId ?? "—"} (${state.machine?.source ?? "?"})`,
  `  Активация на нём:    ${state.license?.activated ? "есть — код не спрашивается (сброс на вкладке «Мой ПК»)" : "нет — приложение спросит код"}`,
  "",
  host === "0.0.0.0" ? "  ⚠ Станция слушает всю сеть: держите ссылку при себе, токен обязателен.\n" : "",
  "  Остановить: Ctrl+C",
  "",
];
process.stdout.write(`${lines.filter(Boolean).join("\n")}\n`);

if (flags.open) openBrowser(server.url);

if (!fs.existsSync(config.files.secret)) {
  process.stdout.write(
    "  Подсказка: чтобы выписывать коды, нужен закрытый ключ. В проекте приложения:\n" +
      "  npm run license:keygen (один раз) — файл secrets/license-key.json. Без него\n" +
      "  станция умеет только разбирать заявки и проверять готовые коды.\n\n",
  );
}

const shutdown = () => {
  process.stdout.write("\nСтанция остановлена.\n");
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
