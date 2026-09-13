/**
 * Идентификатор компьютера (main process).
 *
 * Нужен для двух вещей:
 *   1. персональные коды активации — отпечаток из 4 байт (core.cjs);
 *   2. запасной ключ шифрования файла лицензии, если safeStorage недоступен.
 *
 * Берутся только стабильные идентификаторы, которые не меняются от переименования
 * компьютера, смены IP или обновления драйверов: на Windows это MachineGuid из
 * реестра (меняется только при переустановке системы), на Linux — /etc/machine-id,
 * на macOS — IOPlatformUUID. Внешние команды вызываются списком аргументов без
 * оболочки (никаких интерпретируемых строк) и с таймаутом.
 *
 * Если стабильный идентификатор получить не удалось, quality = "low": приложение
 * продолжает работать (общие коды от машины не зависят), но персональный код
 * проверять нечем, и об этом честно сообщается на экране активации.
 */

"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const { execFileSync } = require("node:child_process");

/** Домен отделения идентификатора: позволяет сменить схему, не трогая железо. */
const DOMAIN = "agro:machine:1:";
const COMMAND_TIMEOUT_MS = 4000;
const LINUX_MACHINE_ID_FILES = ["/etc/machine-id", "/var/lib/dbus/machine-id"];

function runCommand(command, args, log = () => {}) {
  try {
    const output = execFileSync(command, args, {
      encoding: "utf8",
      timeout: COMMAND_TIMEOUT_MS,
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
    });
    return typeof output === "string" ? output : "";
  } catch (error) {
    log(`machine: ${command} недоступен (${error?.code ?? error?.message ?? "ошибка"})`);
    return "";
  }
}

function readWindowsGuid(log) {
  const output = runCommand(
    "reg",
    ["query", "HKLM\\SOFTWARE\\Microsoft\\Cryptography", "/v", "MachineGuid", "/reg:64"],
    log,
  );
  const match = output.match(/MachineGuid\s+REG_SZ\s+([0-9a-fA-F-]{8,64})/);
  return match ? match[1].toLowerCase() : "";
}

function readMacUuid(log) {
  const output = runCommand("ioreg", ["-rd1", "-c", "IOPlatformExpertDevice"], log);
  const match = output.match(/"IOPlatformUUID"\s*=\s*"([^"]+)"/);
  return match ? match[1].toLowerCase() : "";
}

function readLinuxMachineId(log) {
  for (const file of LINUX_MACHINE_ID_FILES) {
    try {
      const value = fs.readFileSync(file, "utf8").trim();
      if (value.length >= 16) return value.toLowerCase();
    } catch (error) {
      log(`machine: ${file} не читается (${error?.code ?? error?.message})`);
    }
  }
  return "";
}

/**
 * Запасной вариант: сведения, которые почти не меняются, но и гарантий не дают.
 * Используется, только если системный идентификатор недоступен.
 */
function fallbackSeed() {
  const cpu = os.cpus?.()[0]?.model ?? "cpu";
  const memory = Math.round(os.totalmem() / 1024 / 1024 / 512) * 512; // округление до 512 МБ
  return `fallback:${os.hostname()}:${cpu}:${memory}:${os.platform()}`;
}

/**
 * @param {{platform?:string, log?:(...args:any[])=>void, readFile?:(p:string)=>string}} [options]
 */
function createMachineIdentity(options = {}) {
  const platform = options.platform ?? process.platform;
  const log = options.log ?? (() => {});
  let cached = null;

  function readPrimary() {
    if (platform === "win32") return readWindowsGuid(log);
    if (platform === "darwin") return readMacUuid(log);
    return readLinuxMachineId(log);
  }

  function identity() {
    if (cached) return cached;
    const primary = readPrimary();
    const stable = Boolean(primary);
    const seed = stable ? primary : fallbackSeed();
    const machineId = crypto.createHash("sha256").update(`${DOMAIN}${seed}`, "utf8").digest("hex");
    cached = Object.freeze({
      machineId,
      quality: stable ? "high" : "low",
      source: stable ? (platform === "win32" ? "MachineGuid" : platform === "darwin" ? "IOPlatformUUID" : "machine-id") : "fallback",
      platform,
    });
    return cached;
  }

  return {
    /** Полный идентификатор (64 hex-символа). */
    get machineId() {
      return identity().machineId;
    },
    /** "high" — идентификатор системный и стабильный, "low" — приблизительный. */
    get quality() {
      return identity().quality;
    },
    get source() {
      return identity().source;
    },
    identity,
  };
}

module.exports = { createMachineIdentity, fallbackSeed, DOMAIN };
