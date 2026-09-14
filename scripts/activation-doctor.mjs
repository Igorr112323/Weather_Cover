#!/usr/bin/env node
/**
 * Доктор активации — проверка и сброс активации НА СВОЁМ компьютере.
 *
 * Проблема, которую он решает: файл лицензии лежит в профиле приложения
 * (`%APPDATA%\AgroPrognoz\agroprognoz.license`) и он общий для всех копий
 * программы. Поэтому на компьютере, где активация уже прошла, новый EXE
 * экран ввода кода не покажет — проверить активацию «вживую» невозможно.
 *
 * Команды:
 *
 *   npm run license:status            где лежит лицензия, читается ли, каким
 *                                     шифром защищена и спросит ли приложение код
 *   npm run license:machine           код этого компьютера (XXXX-XXXX) — его
 *                                     просят в заявке на персональный код
 *   npm run license:reset             убрать сохранённую лицензию → приложение
 *                                     снова покажет экран активации (файл
 *                                     сохраняется рядом как *.bak-<дата>)
 *   npm run license:reset -- --purge  удалить без резервной копии
 *   npm run license:reset -- --instance demo   только проверочную копию
 *                                     AgroPrognoz-check-demo.exe
 *   npm run activation:selftest       полный сценарий активации на боевом коде
 *                                     стража, во временном каталоге и с выдуманным
 *                                     ключом: чистая машина → код принят →
 *                                     перезапуск → чужая машина → сброс → отзыв
 *
 * Никаких секретов команда не читает и не отправляет: закрытый ключ нужен только
 * selftest, и там он выдумывается на месте (secrets/ не трогается).
 *
 * Флаги: --json (машиночитаемый вывод), --dir <путь> (искать ещё и здесь),
 *        --help.
 */

import { createRequire } from "node:module";
import crypto from "node:crypto";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import {
  buildLicenseCode,
  privateKeyObject,
} from "./license-shared.mjs";
import {
  inspectActivation,
  isLiveLicenseFile,
  licenseDirectoryCandidates,
  resetLicenseFiles,
  runActivationSelfTest,
} from "./activation-doctor-lib.mjs";

const require = createRequire(import.meta.url);
const core = require("../electron/license/core.cjs");
const checkmode = require("../electron/license/checkmode.cjs");
const { createMachineIdentity } = require("../electron/license/machine.cjs");
const { createGuard } = require("../electron/license/guard.cjs");

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const USAGE = `Доктор активации — «АгроПрогноз — Кукуруза».

  npm run license:status                     состояние лицензии на этом ПК
  npm run license:machine                    код этого компьютера для заявки
  npm run license:reset                      сбросить активацию (с копией файла)
  npm run activation:selftest                проверить весь сценарий активации

Полезные флаги:
  --json                вывод одним JSON (для скриптов)
  --dir <путь>          добавить каталог профиля (повторяемый)
  --purge               при сбросе удалить без резервной копии
  --instance <id>       сбросить только проверочную копию AgroPrognoz-check-<id>.exe
  --all                 сбросить и карантинные/резервные файлы тоже
  --dry-run             показать, что будет сделано, ничего не меняя`;

/* ── Аргументы ───────────────────────────────────────────────────────────── */

function parseArgs(argv) {
  const [command = "status", ...rest] = argv;
  const flags = { dirs: [] };
  for (let index = 0; index < rest.length; index += 1) {
    const item = rest[index];
    if (item === "--json") flags.json = true;
    else if (item === "--purge") flags.purge = true;
    else if (item === "--all") flags.all = true;
    else if (item === "--dry-run") flags["dry-run"] = true;
    else if (item === "--dir" || item === "--license-dir") flags.dirs.push(path.resolve(String(rest[++index] ?? ".")));
    else if (item.startsWith("--dir=")) flags.dirs.push(path.resolve(item.slice(6)));
    else if (item.startsWith("--instance=")) flags.instance = item.slice(11);
    else if (item === "--instance") flags.instance = String(rest[++index] ?? "");
    else if (item === "--help" || item === "-h") flags.help = true;
    else if (!item.startsWith("--")) flags.positional = (flags.positional ?? []).concat(item);
  }
  return { command, flags };
}

function out(text) {
  process.stdout.write(`${text}\n`);
}

function fail(message) {
  process.stderr.write(`\n✘ ${message}\n\n`);
  process.exit(1);
}

const VERDICTS = Object.freeze({
  ACTIVE: "лицензия есть → приложение код НЕ спросит",
  FOREIGN_MACHINE: "файл с другого компьютера → приложение спросит код",
  TAMPERED: "поля файла подменены (HMAC) → приложение спросит код",
  DAMAGED: "файл повреждён → приложение спросит код",
  ARCHIVE: "резервная копия или карантин — не активация",
});

const CIPHERS = Object.freeze({
  os: "системное хранилище (Windows DPAPI) — читается только этим приложением",
  "aes-gcm": "AES-256-GCM с ключом от идентификатора компьютера",
});

function pad(text, width) {
  const value = String(text ?? "");
  return value.length >= width ? value : value + " ".repeat(width - value.length);
}

/* ── Команды ─────────────────────────────────────────────────────────────── */

async function commandStatus(flags) {
  const machine = createMachineIdentity({ log: () => {} });
  const dirs = [...licenseDirectoryCandidates(), ...flags.dirs];
  const report = await inspectActivation({
    machineId: machine.machineId,
    dirs,
    listFiles: (dir) => fsp.readdir(dir),
    readFile: (file) => fsp.readFile(file, "utf8"),
  });
  const files = report.scanned.flatMap((item) => item.files);

  if (flags.json) {
    out(JSON.stringify({ ...report, machineQuality: machine.quality, machineSource: machine.source }, null, 2));
    return 0;
  }

  out("");
  out(`Код этого компьютера:  ${report.machineIdShort}`);
  out(`Источник идентификатора: ${machine.source} (качество: ${machine.quality})`);
  out(`Полный идентификатор:  ${machine.machineId}`);
  out("");
  out("Каталоги профиля, где ищем лицензию:");
  for (const dir of dirs) out(`  ${dir}`);
  out("");
  if (!files.length) {
    out("Файлов лицензии нет ни в одном каталоге → приложение запросит код активации.");
    out("");
    out("Проверить выдачу кода:  npm run license:issue -- --bind " + report.machineIdShort);
    return 0;
  }
  out("Найдено:");
  for (const item of files) {
    const where = path.join(item.dir ?? path.dirname(item.file), item.name);
    out(`  ${pad(item.name, 36)} ${VERDICTS[item.verdict] ?? item.verdict}`);
    out(`      ${where}`);
    if (item.cipher) out(`      шифр: ${CIPHERS[item.cipher] ?? item.cipher}`);
    if (item.verdict === "ACTIVE" && item.licenseReadableHere) {
      out(`      серийник: ${core.prettySerial(item.serialHex)} · привязка к машине: ${item.bound ? "да" : "нет"}`);
    }
  }
  out("");
  const mainActive = files.some((item) => !item.instance && item.verdict === "ACTIVE");
  if (mainActive) {
    out("Основная копия приложения активирована. Чтобы увидеть экран активации заново:");
    out("  npm run license:reset");
    out("После этого можно проверить и выдачу персонального кода, и его приём.");
  } else {
    out("Рабочей лицензии нет → ближайшее открытие приложения покажет экран ввода кода.");
  }
  out("");
  out("Проверочные копии (AgroPrognoz-check-<id>.exe) живут отдельно: у них свой файл");
  out("лицензии, и каждая новая копия спрашивает код, даже когда основная активирована.");
  out("");
  return 0;
}

async function commandMachine(flags) {
  const machine = createMachineIdentity({ log: () => {} });
  const shortId = core.prettyShortId(core.machineShortId(machine.machineId));
  if (flags.json) {
    out(JSON.stringify({ machineId: machine.machineId, machineIdShort: shortId, quality: machine.quality, source: machine.source }, null, 2));
    return 0;
  }
  out("");
  out(`Код компьютера для заявки на персональный код:  ${shortId}`);
  out(`Полный идентификатор (на случай вопросов):       ${machine.machineId}`);
  out(`Источник: ${machine.source}, качество: ${machine.quality}`);
  out("");
  out(`Выдать код этому компьютеру: npm run license:issue -- --bind ${shortId}`);
  if (machine.quality === "low") out("⚠ Стабильный идентификатор не найден — персональные коды могут не приняться.");
  out("");
  return 0;
}

async function commandReset(flags) {
  const machine = createMachineIdentity({ log: () => {} });
  const dirs = [...licenseDirectoryCandidates(), ...flags.dirs];
  const report = await inspectActivation({
    machineId: machine.machineId,
    dirs,
    listFiles: (dir) => fsp.readdir(dir),
    readFile: (file) => fsp.readFile(file, "utf8"),
  });
  const wanted = report.scanned
    .flatMap((item) => item.files.map((file) => ({ ...file, dir: item.dir })))
    .filter((item) => (flags.all ? true : isLiveLicenseFile(item.name)))
    .filter((item) => (flags.instance === undefined ? !item.instance : item.instance === checkmode.sanitizeInstance(flags.instance)));

  if (!wanted.length) {
    if (flags.json) out(JSON.stringify({ ok: true, changed: [], message: "файлов лицензии не найдено" }, null, 2));
    else out(`\nНечего сбрасывать: ${flags.instance ? `файла проверочной копии «${flags.instance}»` : "файлов лицензии"} не найдено.\n`);
    return 0;
  }

  if (flags["dry-run"]) {
    out("");
    out("Будет сделано (пока только показываем):");
    for (const item of wanted) out(`  ${path.join(item.dir, item.name)}  →  ${flags.purge ? "удаление" : "перенос в *.bak-<дата>"}`);
    out("");
    return 0;
  }

  const changed = await resetLicenseFiles({
    files: wanted,
    purge: flags.purge === true,
    rename: (from, to) => fsp.rename(from, to),
    unlink: (file) => fsp.rm(file, { force: true }),
  });

  if (flags.json) {
    out(JSON.stringify({ ok: true, changed }, null, 2));
    return 0;
  }
  out("");
  for (const item of changed) {
    out(`  ${path.basename(item.file)}  →  ${item.action === "deleted" ? "удалён" : `сохранён как ${path.basename(item.to)}`}`);
  }
  out("");
  out("✔ Активация сброшена. Следующий запуск приложения спросит код активации.");
  out("  Проверить можно так:  release\\AgroPrognoz-<version>-portable.exe");
  out("  Вернуть как было: закрыть приложение и вернуть файл из резервной копии.");
  out("");
  return 0;
}

async function commandSelfTest(flags) {
  const keyId = 1;
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
  const revokedBytes = crypto.randomBytes(core.SERIAL_BYTES);
  const material = {
    keyId,
    keyMaterial: {
      keys: [{ keyId, label: "selftest", publicKey: publicKey.export({ format: "der", type: "spki" }).toString("base64") }],
      revokedSerials: [],
    },
    revokedSerial: Uint8Array.from(revokedBytes),
    revokedSerialHex: revokedBytes.toString("hex"),
  };
  const signer = privateKeyObject(privateKey.export({ format: "der", type: "pkcs8" }).toString("base64"));

  const result = await runActivationSelfTest({
    mkdtemp: async (prefix) => fsp.mkdtemp(path.join(await fsp.realpath(os.tmpdir()), prefix)),
    mkdir: (dir) => fsp.mkdir(dir, { recursive: true }),
    rm: (dir) => fsp.rm(dir, { recursive: true, force: true }),
    rmFile: (file) => fsp.rm(file, { force: true }),
    readFile: (file) => fsp.readFile(file, "utf8"),
    writeFile: (file, body) => fsp.writeFile(file, body, "utf8"),
    copyFile: (from, to) => fsp.copyFile(from, to),
    keys: () => material,
    issue: (input) => buildLicenseCode({ privateKey: signer, ...input }),
    guard: (options) => createGuard(options),
  });

  if (flags.json) {
    out(JSON.stringify(result, null, 2));
    return result.passed ? 0 : 1;
  }
  out("");
  out("Самопроверка активации — на реальном коде стража, во временном каталоге.");
  out("Ключ выдумывается на месте: secrets/ и боевые коды не читаются и не меняются.\n");
  for (const item of result.checks) {
    out(`  ${item.ok ? "✔" : "✘"} ${item.name}${item.detail ? `  — ${item.detail}` : ""}`);
  }
  out("");
  out(result.passed ? `✔ Пройдено проверок: ${result.total}` : `✘ Провалено: ${result.checks.filter((item) => !item.ok).length} из ${result.total}`);
  out("");
  return result.passed ? 0 : 1;
}

/* ── Запуск ──────────────────────────────────────────────────────────────── */

const { command, flags } = parseArgs(process.argv.slice(2));
if (flags.help) {
  out(`\n${USAGE}\n`);
  process.exit(0);
}

let code = 0;
try {
  switch (command) {
    case "status":
      code = await commandStatus(flags);
      break;
    case "machine":
      code = await commandMachine(flags);
      break;
    case "reset":
      code = await commandReset(flags);
      break;
    case "selftest":
      code = await commandSelfTest(flags);
      break;
    case "help":
      out(`\n${USAGE}\n`);
      break;
    default:
      await fail(`Неизвестная команда «${command}».\n\n${USAGE}`);
  }
} catch (error) {
  await fail(String(error?.message ?? error));
}
process.exit(code);
