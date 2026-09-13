#!/usr/bin/env node
/**
 * «Студия лицензий» — программа владельца приложения. Запуск:
 *
 *   npm run license:studio
 *
 * Что происходит:
 *   1. читается закрытый ключ из secrets/license-key.json (каталог в
 *      .gitignore; ключ не покидает этот компьютер);
 *   2. поднимается локальная страница 127.0.0.1 — форма выдачи кодов и журнал;
 *   3. браузер открывается сам (отключается флагом --no-open).
 *
 * Студия работает без интернета: выдать код, собрать сообщение, сохранить
 * .agrolic и отозвать лицензию можно офлайн. Интернет нужен только
 * необязательному модулю доставки (СМС/Telegram/почта) — и только тогда,
 * когда владелец сам нажимает «Отправить».
 *
 * Флаги:  --port N   слушать порт N (по умолчанию — первый свободный от 8791)
 *         --no-open  не открывать браузер
 */

import crypto from "node:crypto";
import { execFile } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { createStudio } from "./studio.mjs";
import { startStudioServer } from "./server.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const DEFAULT_PORT = Number(process.env.AGRO_STUDIO_PORT ?? 8791);

function parseArgs(argv) {
  const flags = { port: undefined, open: true, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (item === "--port") flags.port = Number(argv[index + 1]);
    else if (item.startsWith("--port=")) flags.port = Number(item.split("=")[1]);
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
  console.log("\nСтудия лицензий — выдача кодов активации «АгроПрогноз — Кукуруза».");
  console.log("\n  npm run license:studio                запустить студию");
  console.log("  npm run license:studio -- --port 9000 слушать конкретный порт");
  console.log("  npm run license:studio -- --no-open   не открывать браузер\n");
  process.exit(0);
}

const backend = createStudio({ root: ROOT });
const token = crypto.randomBytes(24).toString("hex");

async function listen(port) {
  return startStudioServer({ backend, token, port });
}

// Порт по умолчанию может быть занят прошлым запуском — пробуем соседние.
let server = null;
const wanted = Number.isInteger(flags.port) && flags.port > 0 ? flags.port : DEFAULT_PORT;
for (let candidate = wanted; candidate < wanted + 16 && !server; candidate += 1) {
  try {
    server = await listen(candidate);
  } catch (error) {
    if (error?.code !== "EADDRINUSE") throw error;
  }
}
if (!server) {
  console.error(`\n✘ Не удалось занять порт ${wanted} (и 15 следующих). Укажите свой: npm run license:studio -- --port 9000\n`);
  process.exit(1);
}

console.log(`
┌──────────────────────────────────────────────────────────────────┐
│  Студия лицензий — «АгроПрогноз — Кукуруза»                      │
│  Лицензии БЕССРОЧНЫЕ: поля «действует до» не существует          │
├──────────────────────────────────────────────────────────────────┤
│  Закрытый ключ: secrets/license-key.json (не покидает этот       │
│  компьютер, в репозиторий и сборку не попадает)                  │
│  Журнал выдачи: secrets/ledger.csv                               │
│  Страница:     ${server.url}
│                                                                  │
│  Остановить студию: Ctrl+C                                       │
└──────────────────────────────────────────────────────────────────┘
`);

if (flags.open) openBrowser(server.url);

const shutdown = () => {
  console.log("\nСтудия остановлена.");
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
