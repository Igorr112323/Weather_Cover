/* vendored: точная копия scripts/activation-doctor-lib.mjs из проекта Weather_Cover.
 * Не править руками — обновлять скриптом scripts/sync-vendor.mjs. */
/**
 * Диагностика и сброс активации — логическая часть (без Electron).
 *
 * Нужна, чтобы владелец приложения мог проверить работу активации у себя на
 * компьютере, где она уже один раз сработала: файл лицензии лежит в профиле
 * приложения (`%APPDATA%\AgroPrognoz\agroprognoz.license`) и он общий для всех
 * копий программы, поэтому свежескачанный EXE обычно стартует уже
 * активированным, и экран ввода кода не показывается.
 *
 * Здесь собраны чистые функции с внедрённым файловым слоем, поэтому их проверяют
 * unit-тесты (tests/activation-doctor.test.mjs), а CLI scripts/activation-doctor.mjs
 * — тонкая обёртка над ними.
 *
 * Что важно для безопасности: ни одна функция отсюда не умеет «разрешить»
 * приложение. Сброс только убирает сохранённую лицензию — после него код нужно
 * ввести, и страж проверит его точно так же, как при первой активации.
 */

import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);
const store = require("./store.cjs");
const core = require("./core.cjs");
const checkmode = require("./checkmode.cjs");

// Все имена файлов лицензий, которые умеет создавать приложение, — из одного
// места (electron/license/checkmode.cjs), чтобы диагностика и проверка не
// разъезжались с тем, что реально пишет страж.
const { LICENSE_FILE_NAME, licenseFileNameFor } = checkmode;

/** Имя каталога профиля, которое задают productName (сборка) и name (dev). */
const PROFILE_NAMES = Object.freeze(["AgroPrognoz", "agroprognoz-corn"]);

/**
 * Файлы, которые приложение создаёт вокруг лицензии: сама лицензия, карантин
 * стража (`agroprognoz.license.MAC.bad`) и копия после сброса (`*.bak-*`).
 */
const LICENSE_ARTIFACT = /^agroprognoz.*\.license(\..+)?$/i;

/**
 * Каталоги, где приложение может хранить профиль на этой системе.
 * Возвращаются все кандидаты (в том числе несуществующие): так `license:status`
 * честно говорит, где искал.
 *
 * @param {{platform?:string, env?:object, home?:string}} [options]
 */
export function licenseDirectoryCandidates(options = {}) {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const home = options.home ?? (platform === "win32" ? env.USERPROFILE : env.HOME) ?? "";
  const roots = [];
  if (platform === "win32") {
    if (env.APPDATA) roots.push(env.APPDATA);
    // Редко, но бывает: переменная APPDATA не задана — пробуем путь рядом с локальным каталогом.
    if (env.LOCALAPPDATA) roots.push(path.join(env.LOCALAPPDATA, "..", "Roaming"));
  } else if (platform === "darwin") {
    if (home) roots.push(path.join(home, "Library", "Application Support"));
  } else {
    if (env.XDG_CONFIG_HOME) roots.push(env.XDG_CONFIG_HOME);
    else if (home) roots.push(path.join(home, ".config"));
  }
  // Portable-сборка пишет лицензию рядом со своим EXE (PORTABLE_EXECUTABLE_DIR
  // задаёт electron-builder, AGRO_PORTABLE_EXE — наш NSIS-скрипт): этот каталог
  // смотрим как есть, без подкаталога профиля.
  const portable = portableLicenseDir(env);

  const seen = new Set();
  const candidates = [];
  if (portable) {
    seen.add(portable);
    candidates.push(portable);
  }
  for (const root of roots) {
    for (const profile of PROFILE_NAMES) {
      const dir = path.normalize(path.join(root, profile));
      if (seen.has(dir)) continue;
      seen.add(dir);
      candidates.push(dir);
    }
  }
  return candidates;
}

/** Каталог рядом с portable-EXE (или ""), чтобы `license:status` видел и его. */
export function portableLicenseDir(env = process.env) {
  const fromDir = String(env.PORTABLE_EXECUTABLE_DIR ?? "").trim();
  if (fromDir) return fromDir;
  const fromExe = String(env.AGRO_PORTABLE_EXE ?? "").trim();
  return dirOf(fromExe);
}

/** Каталог файла по пути; и «\\», и «/» — Windows-путь разбирается и на Linux. */
function dirOf(filePath) {
  const text = String(filePath ?? "").replace(/[\\/]+$/, "");
  const index = Math.max(text.lastIndexOf("/"), text.lastIndexOf("\\"));
  if (index <= 0) return "";
  const head = text.slice(0, index);
  return /^[A-Za-z]:$/.test(head) ? `${head}${text[index]}` : head;
}

/** Похоже ли имя файла на файл лицензии приложения (включая карантин и бэкапы). */
function isLicenseArtifact(fileName) {
  return LICENSE_ARTIFACT.test(String(fileName));
}

/** Файл, который приложение примет как активацию: карантин стража и бэкапы — нет. */
function isLiveLicenseFile(fileName) {
  return String(fileName).endsWith(".license");
}

/** Идентификатор проверочного экземпляра из имени файла; "" — обычная (общая) лицензия. */
function instanceOfLicenseFile(fileName) {
  const match = /^agroprognoz-check-([A-Za-z0-9_-]+?)\.license(?:\..*)?$/.exec(String(fileName));
  return match ? match[1] : "";
}

/**
 * Что лежит в профиле: файлы лицензий и их состояние.
 *
 * `verdict` — человеческий вывод:
 *   ABSENT            файла нет → приложение спросит код;
 *   ACTIVE            конверт читается этим компьютером → код НЕ спросит;
 *   FOREIGN_MACHINE   файл с другой машины (копия перенесена) → спросит код;
 *   TAMPERED          поля конверта подменены (HMAC не совпал) → спросит код;
 *   DAMAGED           файл повреждён или в неизвестном формате → спросит код.
 *
 * Расшифровать содержимое может только то же приложение на том же компьютере:
 * на Windows это DPAPI через safeStorage. Поэтому `licenseReadableHere === false`
 * при cipher === "os" — это норма, а не поломка.
 *
 * @param {{dir:string, machineId:string, listFiles?:(dir:string)=>Promise<string[]>, readFile?:(file:string)=>Promise<string>}} options
 */
export async function inspectLicenseDirectory({ dir, machineId, listFiles, readFile }) {
  const names = await listFiles(dir).catch(() => []);
  const files = [];
  for (const name of names.filter(isLicenseArtifact)) {
    const file = path.join(dir, name);
    const raw = await readFile(file).catch(() => null);
    if (raw === null) {
      files.push({ file, name, instance: instanceOfLicenseFile(name), verdict: "DAMAGED", reason: "READ_FAILED" });
      continue;
    }
    if (!isLiveLicenseFile(name)) {
      files.push({ file, name, instance: instanceOfLicenseFile(name), verdict: "ARCHIVE", isArchive: true });
      continue;
    }
    const inspected = store.inspectEnvelope(machineId, raw);
    if (!inspected.ok) {
      const verdict = inspected.reason === "MACHINE" ? "FOREIGN_MACHINE" : inspected.reason === "MAC" ? "TAMPERED" : "DAMAGED";
      files.push({ file, name, instance: instanceOfLicenseFile(name), verdict, reason: inspected.reason });
      continue;
    }
    let record = null;
    if (inspected.cipher === store.CIPHER.FALLBACK) {
      // Запасной шифр выводится из идентификатора компьютера — он доступен и
      // вне Electron, поэтому в этом случае можно показать и содержимое.
      try {
        const cipher = store.createFallbackCipher(machineId);
        const decode = (value) => Uint8Array.from(Buffer.from(String(value ?? ""), "base64"));
        const bytes = cipher.decrypt(decode(inspected.envelope.salt), decode(inspected.envelope.iv), decode(inspected.envelope.data), decode(inspected.envelope.tag));
        record = JSON.parse(Buffer.from(bytes).toString("utf8"));
      } catch {
        record = null;
      }
    }
    files.push({
      file,
      name,
      instance: instanceOfLicenseFile(name),
      verdict: "ACTIVE",
      cipher: inspected.cipher,
      licenseReadableHere: record !== null,
      bound: record?.bound ?? null,
      serialHex: record?.serialHex ?? null,
      keyId: record?.keyId ?? null,
    });
  }
  return { dir, files };
}

/** Ищем файлы во всех подходящих каталогах профиля. */
export async function inspectActivation({ machineId, dirs, ...fsTools }) {
  const list = dirs?.length ? dirs : licenseDirectoryCandidates();
  const results = [];
  for (const dir of list) {
    const inspected = await inspectLicenseDirectory({ dir, machineId, ...fsTools });
    if (inspected.files.length) results.push(inspected);
  }
  return {
    machineId,
    machineIdShort: core.prettyShortId(core.machineShortId(machineId)),
    dirs: list,
    scanned: results,
    /** Файл общей лицензии: его наличие = «приложение уже активировано». */
    mainFile: results.flatMap((item) => item.files).find((item) => !item.instance && item.verdict !== "ARCHIVE") ?? null,
  };
}

/**
 * Сброс активации: файл лицензии переименовывается (или удаляется при purge).
 *
 * @param {{files:Array<{file:string}>, purge?:boolean, now?:()=>Date, rename?:Function, unlink?:Function}} options
 * @returns {Promise<Array<{file:string, action:string, to?:string}>>}
 */
export async function resetLicenseFiles({ files, purge = false, now = () => new Date(), rename, unlink }) {
  const date = typeof now === "function" ? now() : now ?? new Date();
  const parts = new Date(date);
  const pad2 = (value) => String(value).padStart(2, "0");
  const stamp = `${parts.getFullYear()}${pad2(parts.getMonth() + 1)}${pad2(parts.getDate())}-${pad2(parts.getHours())}${pad2(parts.getMinutes())}${pad2(parts.getSeconds())}`;
  const done = [];
  for (const item of files) {
    const file = item.file ?? item;
    if (purge) {
      await unlink(file);
      done.push({ file, action: "deleted" });
      continue;
    }
    const target = `${file}.bak-${stamp}`;
    await rename(file, target);
    done.push({ file, action: "moved", to: target });
  }
  return done;
}

/**
 * Полный самопроверочный сценарий активации на реальном коде стража
 * (electron/license/guard.cjs + license/store.cjs + license/core.cjs), в
 * временном каталоге и с выдуманным ключом. Ни одна боевая лицензия не
 * затрагивается: каталог и ключевая пара — свои.
 *
 * Сценарий ровно тот, который владелец хочет увидеть глазами:
 *   чистый компьютер → просит код → код принят → повторный запуск активен →
 *   перенос файла на другую машину → снова просит код → сброс → снова просит.
 *
 * @param {{mkdtemp:(prefix:string)=>Promise<string>, mkdir:(dir:string)=>Promise<void>, rm:(dir:string)=>Promise<void>, rmFile:(file:string)=>Promise<void>, readFile:(file:string)=>Promise<string>, writeFile:(file:string, body:string)=>Promise<void>, copyFile:(from:string, to:string)=>Promise<void>, issue:(options:object)=>{code:string, serialHex:string}, guard:(options:object)=>object, keys:()=>object}} tools
 */
/** Меняет последний символ кода: подпись гарантированно перестаёт сходиться. */
function flipLastChar(code) {
  const text = String(code ?? "");
  const alphabet = core.ALPHABET;
  for (let index = text.length - 1; index >= 0; index -= 1) {
    const char = text[index].toUpperCase();
    const position = alphabet.indexOf(char);
    if (position === -1) continue;
    const next = alphabet[(position + 1) % alphabet.length];
    return `${text.slice(0, index)}${next}${text.slice(index + 1)}`;
  }
  return `${text}0`;
}

export async function runActivationSelfTest(tools) {
  const dir = await tools.mkdtemp("agro-activation-selftest-");
  const checks = [];
  const check = (name, ok, detail = "") => checks.push({ name, ok: Boolean(ok), detail: String(detail ?? "") });
  try {
    const material = tools.keys();
    const machineA = "a".repeat(64);
    const machineB = "b".repeat(64);
    const optionsFor = (id, licenseDir) => ({
      keyMaterial: material.keyMaterial,
      machine: {
        machineId: id,
        quality: "high",
        source: "selftest",
        identity: () => ({ machineId: id, quality: "high", source: "selftest", platform: "selftest" }),
      },
      userDataDir: licenseDir ?? dir,
      appRoot: dir,
      safeStorage: {},
      integrity: { enabled: false, verify: async () => ({ ok: true, skipped: true, mismatches: [], checked: 0 }) },
      log: () => {},
    });
    const fileName = LICENSE_FILE_NAME;
    const licenseFile = path.join(dir, fileName);

    // 1. Чистый компьютер: файла нет → приложение не активировано и просит код.
    const first = tools.guard(optionsFor(machineA));
    const beforeActivate = await first.initialize();
    check("без файла лицензии приложение требует код активации", beforeActivate.activated === false && beforeActivate.requiresActivation === true);
    check("данные до активации закрыты", first.gate("случайный токен")?.code === first.GATE.NOT_ACTIVATED);

    // 2. Универсальный код принимается, лицензия бессрочная.
    const universal = tools.issue({ keyId: material.keyId, bound: false });
    const activated = await first.activate(universal.code);
    check("универсальный код принят", activated.ok === true, activated.message ?? "");
    check("срок действия не ограничен", activated.status?.permanent === true && activated.status?.expiration === null);
    check("файл лицензии создан", (await tools.readFile(licenseFile)).startsWith(store.MAGIC));
    check("токен сессии выдан", typeof activated.token === "string" && activated.token.length > 20);
    check("доступ к данным открыт", first.gate(activated.token) === null);

    // 3. Перезапуск: состояние читается из файла и проверяется подписью заново.
    const restarted = tools.guard(optionsFor(machineA));
    const afterRestart = await restarted.initialize();
    check("после перезапуска остаётся активированным", afterRestart.activated === true);
    check("серийник сохранённой лицензии совпал", afterRestart.serialHex === universal.serialHex, `${afterRestart.serialHex} vs ${universal.serialHex}`);

    // 4. Персональный код этого компьютера принимается и заменяет прежний.
    const personal = tools.issue({ keyId: material.keyId, bound: true, shortId: core.machineShortId(machineA) });
    const switched = await restarted.activate(personal.code);
    check("персональный код этого компьютера принят", switched.ok === true, switched.message ?? "");
    check("новый код заменил сохранённую лицензию", (await restarted.initialize()).serialHex === personal.serialHex);

    // 5. Чужой компьютер: и прямой ввод кода, и перенесённый файл лицензии отклоняются.
    const foreignDir = path.join(dir, "foreign");
    await tools.mkdir(foreignDir);
    const foreign = tools.guard(optionsFor(machineB, foreignDir));
    await foreign.initialize();
    const foreignAttempt = await foreign.activate(personal.code);
    check("персональный код на другом компьютере отклонён", foreignAttempt.ok === false && foreignAttempt.reason === core.REJECT.MACHINE_MISMATCH, foreignAttempt.reason ?? "");
    await tools.copyFile(licenseFile, path.join(foreignDir, fileName));
    const movedFile = tools.guard(optionsFor(machineB, foreignDir));
    const movedStatus = await movedFile.initialize();
    check("скопированный файл лицензии чужим компьютером не принимается", movedStatus.activated === false && movedStatus.storeReason === "MACHINE", movedStatus.storeReason ?? "");

    // 6. Подмена полей конверта видна по HMAC.
    const tamperedText = (await tools.readFile(licenseFile)).replace(/"data"\s*:\s*"[^"]+"/, '"data": "AAAAAAAAAAAAAAAAAAAAAA="');
    await tools.writeFile(licenseFile, tamperedText);
    const tamperGuard = tools.guard(optionsFor(machineA));
    const tamperedStatus = await tamperGuard.initialize();
    check("подменённый файл лицензии уходит в карантин и требует код", tamperedStatus.activated === false && tamperedStatus.storeReason === "MAC", tamperedStatus.storeReason ?? "");

    // 7. Сброс = то, что нужно владельцу для повторной проверки: файла нет → код снова спрашивается.
    await tools.rmFile(path.join(dir, fileName));
    const afterReset = await tools.guard(optionsFor(machineA)).initialize();
    check("после удаления файла лицензии экран активации снова нужен", afterReset.activated === false && afterReset.requiresActivation === true);

    // 8. Проверочный режим: у копии AgroPrognoz-check-<id>.exe свой файл
    //    лицензии, поэтому она требует код, даже когда основная активирована.
    await tools.guard(optionsFor(machineA)).activate(universal.code);
    const checkFileName = licenseFileNameFor("demo");
    check("проверочный режим меняет только имя файла лицензии", checkFileName === "agroprognoz-check-demo.license" && checkFileName !== fileName);
    const checkCopy = tools.guard({ ...optionsFor(machineA), licenseFileName: checkFileName });
    const checkStatus = await checkCopy.initialize();
    check("свежая проверочная копия требует код, хотя основная активирована", checkStatus.activated === false && checkStatus.requiresActivation === true);
    const forCheck = tools.issue({ keyId: material.keyId, bound: true, shortId: core.machineShortId(machineA) });
    check("проверочная копия принимается персональным кодом этого компьютера", (await checkCopy.activate(forCheck.code)).ok === true);
    const mainAfterCheck = await tools.guard(optionsFor(machineA)).initialize();
    check("основная лицензия проверочной копией не изменена", mainAfterCheck.activated === true && mainAfterCheck.serialHex === universal.serialHex);

    // 9. Отзыв и подделка.
    const revokedCode = tools.issue({ keyId: material.keyId, bound: false, serial: material.revokedSerial });
    const revokedGuard = tools.guard({ ...optionsFor(machineA), keyMaterial: { keys: material.keyMaterial.keys, revokedSerials: [material.revokedSerialHex] } });
    const revokedResult = await revokedGuard.activate(revokedCode.code);
    check("отозванный серийник не активирует приложение", revokedResult.ok === false && revokedResult.reason === core.REJECT.REVOKED, revokedResult.reason ?? "");
    const forgedResult = await revokedGuard.activate(flipLastChar(universal.code));
    check("выдуманный код отклонён", forgedResult.ok === false, forgedResult.reason ?? "");
  } finally {
    await tools.rm(dir).catch(() => {});
  }
  return { checks, passed: checks.every((item) => item.ok), total: checks.length };
}

export { flipLastChar, instanceOfLicenseFile, isLicenseArtifact, isLiveLicenseFile };
