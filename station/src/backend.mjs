/**
 * Ядро станции «Активация ключей».
 *
 * Сценарий один: покупатель присылает заявку (текст с экрана активации, файл
 * `.agrorequest` или сообщение в мессенджере) → станция вытаскивает из этого код
 * компьютера → выписывает персональный бессрочный код → отдаёт готовое сообщение
 * для покупателя, файл `.agrolic` и ССЫЛКУ НА СКАЧИВАНИЕ проверочного EXE.
 *
 * Проверочный EXE (`AgroPrognoz-check-<id>.exe`) нужен, чтобы активацию можно
 * было проверить у себя на компьютере, где она уже прошла. Приложение хранит
 * лицензию в профиле (`%APPDATA%\AgroPrognoz`) ОБЩИМ для всех своих копий,
 * поэтому любая новая копия стартует активированной. Проверочная копия получает
 * собственный файл лицензии и обязана запросить код — см.
 * electron/license/checkmode.cjs в проекте приложения.
 *
 * ЛИЦЕНЗИЯ БЕССРОЧНАЯ: поля «действует до» нет ни в коде, ни в журнале, ни в
 * интерфейсе станции. Даты в журнале — только учёт «кому и когда выписано».
 *
 * Все файловые операции принимаются параметром `io`, поэтому тесты станции
 * проверяют выдачу, отзыв и журнал без диска (tests/station.test.mjs).
 */

import { createRequire } from "node:module";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

import {
  agrolicFileName,
  appendLedgerRows,
  buildAgrolicContent,
  buildBuyerMessage,
  buildBuyerSms,
  buildLicenseCode,
  ledgerNow,
  normalizeMachineCode,
  parseLedger,
  privateKeyObject,
  readSecret,
  saveLedger,
  serializeLedger,
  writeKeysModule,
} from "../vendor/license-shared.mjs";
import { inspectActivation, licenseDirectoryCandidates, resetLicenseFiles } from "../vendor/activation-doctor-lib.mjs";
import { checkExeName, newInstance, sanitizeInstance } from "./config.mjs";
import { findActivationCode, parseActivationRequest } from "./request.mjs";

const require = createRequire(import.meta.url);
const core = require("../vendor/core.cjs");
const machineModule = require("../vendor/machine.cjs");

export class StationError extends Error {
  constructor(message, extra = {}) {
    super(message);
    this.name = "StationError";
    this.extra = extra;
  }
}

const EXE_NAME = /^AgroPrognoz[A-Za-z0-9._-]*\.exe$/i;
const LEDGER_KIND_LABELS = { personal: "персональный", universal: "универсальный" };
const LEDGER_STATUS_LABELS = { active: "действует", revoked: "отозван" };

function reject(message, extra = {}) {
  return { ok: false, message, ...extra };
}

/**
 * @param {{config:object, io?:object, now?:()=>number}} options
 */
export function createStation({ config, io = {}, now = () => Date.now() }) {
  const readFile = io.readFile ?? ((file) => fsp.readFile(file, "utf8"));
  const writeFile = io.writeFile ?? ((file, body, options) => fsp.writeFile(file, body, options));
  const rename = io.rename ?? ((from, to) => fsp.rename(from, to));
  const existsSync = io.existsSync ?? fs.existsSync;
  const stat = io.stat ?? ((file) => fsp.stat(file));
  const readdir = io.readdir ?? ((dir) => fsp.readdir(dir));
  const copyFile = io.copyFile ?? ((from, to) => fsp.copyFile(from, to));
  const link = io.link ?? ((from, to) => fsp.link(from, to));
  const mkdir = io.mkdir ?? ((dir) => fsp.mkdir(dir, { recursive: true }));
  const machine = io.machine ?? machineModule.createMachineIdentity({ log: () => {} });
  const fsIo = { readFile, writeFile, rename, existsSync, loadModule: io.loadModule ?? ((file) => require(file)) };

  const files = config.files;

  /* ── Состояние ────────────────────────────────────────────────────────── */

  async function appKeys() {
    const keysFile = files.keys;
    if (!keysFile || !existsSync(keysFile)) return { keys: [], revokedSerials: [], source: null, missing: true };
    if (keysFile.endsWith(".cjs")) {
      const loaded = fsIo.loadModule(keysFile);
      return { keys: loaded?.keys ?? [], revokedSerials: loaded?.revokedSerials ?? [], source: keysFile, missing: false };
    }
    try {
      const parsed = JSON.parse(await readFile(keysFile, "utf8"));
      return { keys: parsed?.keys ?? [], revokedSerials: parsed?.revokedSerials ?? [], source: keysFile, missing: false };
    } catch {
      return { keys: [], revokedSerials: [], source: keysFile, missing: true, broken: true };
    }
  }

  async function secretKeys() {
    try {
      const found = await readSecret({ secretFile: files.secret, env: config.env ?? process.env, ...fsIo });
      return { keys: found.keys, missing: false };
    } catch (error) {
      return { keys: [], missing: true, message: error.message.split("\n")[0] };
    }
  }

  async function ledgerRows() {
    if (!files.ledger || !existsSync(files.ledger)) return [];
    const rows = parseLedger(await readFile(files.ledger, "utf8"));
    const revoked = new Set((await appKeys()).revokedSerials.map((value) => String(value).toLowerCase()));
    return rows.map((row) => (revoked.has(row.serial) ? { ...row, status: "revoked" } : row));
  }

  async function state() {
    const [secret, published, ledger] = await Promise.all([secretKeys(), appKeys(), ledgerRows()]);
    const machineId = machine.machineId;
    const activation = await inspectActivation({
      machineId,
      dirs: licenseDirectoryCandidates(),
      listFiles: (dir) => readdir(dir),
      readFile: (file) => readFile(file),
    }).catch(() => ({ scanned: [], dirs: [], mainFile: null }));
    const exeSources = await findExes();
    const instance = newInstance(now());
    return {
      ok: true,
      product: config.product,
      terms: "Лицензия бессрочная: поля «действует до» не существует",
      machine: {
        shortId: core.prettyShortId(core.machineShortId(machineId)),
        machineId,
        quality: machine.quality,
        source: machine.source,
      },
      license: {
        dirs: activation.dirs ?? [],
        files: (activation.scanned ?? []).flatMap((item) => item.files.map((file) => ({ ...file, dir: item.dir }))),
        activated: Boolean(activation.mainFile && activation.mainFile.verdict === "ACTIVE"),
      },
      secret: {
        available: !secret.missing,
        file: files.secret,
        keyIds: secret.keys.map((entry) => entry.keyId),
        message: secret.message ?? "",
      },
      published: {
        file: published.source,
        keyIds: published.keys.map((entry) => entry.keyId),
        revokedCount: published.revokedSerials.length,
        missing: published.missing === true,
      },
      ledger: {
        file: files.ledger,
        total: ledger.length,
        active: ledger.filter((row) => row.status !== "revoked").length,
        revoked: ledger.filter((row) => row.status === "revoked").length,
      },
      repoLinked: Boolean(config.repo),
      repo: config.repo,
      exe: {
        sources: exeSources,
        outDir: files.outDir,
        downloadUrl: config.exeUrl || "",
      },
      nextInstance: instance,
    };
  }

  /* ── Выдача кода ──────────────────────────────────────────────────────── */

  function resolveShortId({ machineCode, requestText }) {
    const direct = String(machineCode ?? "").trim();
    if (direct) {
      const resolved = normalizeMachineCode(direct);
      if (!resolved.ok) throw new StationError(`Код компьютера: ${resolved.message}`, { field: "machineCode" });
      return { shortId: resolved.shortId, parsed: null };
    }
    const parsed = parseActivationRequest(requestText ?? "");
    if (!parsed.ok) throw new StationError(parsed.message || "Не удалось найти код компьютера", { field: "requestText" });
    return { shortId: parsed.shortId, parsed };
  }

  /**
   * @param {{requestText?:string, machineCode?:string, name?:string, phone?:string,
   *          email?:string, note?:string, universal?:boolean, keyId?:number,
   *          confirm?:boolean, revokeReplaced?:boolean, instance?:string,
   *          makeExe?:boolean, exeSource?:string}} input
   */
  async function issue(input = {}) {
    const published = await appKeys();
    if (!published.keys.length) {
      return reject(`Открытые ключи приложения не найдены (${files.keys}) — станция не может проверить, что код будет принят.`);
    }
    const secret = await secretKeys();
    if (secret.missing) return reject(`Закрытый ключ не найден (${files.secret}). ${secret.message ?? ""}`);

    const universal = input.universal === true;
    const { shortId, parsed } = resolveShortId(input);
    if (universal && !input.confirm) {
      return reject(
        "Универсальный код работает на ЛЮБОМ компьютере. Подтвердите выдачу явно: обычно нужен персональный код.",
        { needsConfirm: "universal" },
      );
    }

    const wantedKeyId = input.keyId ? Number(input.keyId) : secret.keys[secret.keys.length - 1].keyId;
    const key = secret.keys.find((entry) => Number(entry.keyId) === Number(wantedKeyId));
    if (!key) return reject(`В ${files.secret} нет закрытого ключа key-id=${wantedKeyId}`);
    if (!published.keys.some((entry) => Number(entry.keyId) === Number(wantedKeyId))) {
      return reject(`Открытый ключ key-id=${wantedKeyId} не добавлен в приложение (${published.source ?? files.keys}) — такой код не примется.`);
    }

    const ledger = await ledgerRows();
    const duplicates = ledger.filter((row) => row.shortId && row.shortId.toUpperCase() === shortId && row.status !== "revoked");
    if (duplicates.length && !input.confirm) {
      return {
        ok: false,
        needsConfirm: "duplicate",
        message: `Компьютеру ${core.prettyShortId(shortId)} код уже выдан (${duplicates.length} шт.). Продолжить — значит перевыпустить код и отозвать прежний.`,
        previous: duplicates.map((row) => summarizeRow(row)),
      };
    }

    const signer = privateKeyObject(key.privateKey);
    const issued = buildLicenseCode({ privateKey: signer, keyId: Number(wantedKeyId), bound: !universal, shortId: universal ? "" : shortId });

    // Проверка «на себе»: станция не отдаёт код, который приложение не примет.
    const selfCheck = core.verifyCode({
      code: issued.code,
      keys: published.keys,
      machineShortId: universal ? "" : shortId,
      revokedSerials: published.revokedSerials,
    });
    if (!selfCheck.ok) return reject(`Выданный код не прошёл проверку тем же кодом, что и приложение: ${selfCheck.reason}`);

    const replaced = input.confirm && duplicates.length ? duplicates : [];
    const revokeNote = await revokeSerials(replaced.map((row) => row.serial), {
      enabled: input.revokeReplaced !== false,
      published,
    });

    const row = {
      issuedAt: ledgerNow(now()),
      serial: issued.serialHex,
      keyId: Number(wantedKeyId),
      kind: universal ? "universal" : "personal",
      shortId: universal ? "" : shortId,
      code: issued.code,
      name: String(input.name ?? parsed?.name ?? "").trim(),
      phone: String(input.phone ?? parsed?.phone ?? "").trim(),
      email: String(input.email ?? parsed?.email ?? "").trim(),
      note: [String(input.note ?? "").trim(), replaced.length ? "замена" : ""].filter(Boolean).join(" · "),
      status: "active",
      revokedAt: "",
      replaces: replaced.map((item) => item.serial).join(","),
    };
    await appendLedgerRow([row]);

    const buyerMessage = buildBuyerMessage({
      name: row.name,
      code: issued.code,
      shortId,
      serialHex: issued.serialHex,
      universal,
    });
    const agrolic = {
      fileName: agrolicFileName(issued.serialHex),
      content: buildAgrolicContent({ name: row.name, shortId, serialHex: issued.serialHex, code: issued.code, universal }),
    };
    const exe = input.makeExe === false ? null : await buildCheckExe({ instance: input.instance, source: input.exeSource });

    return {
      ok: true,
      code: issued.code,
      serial: core.prettySerial(issued.serialHex),
      serialHex: issued.serialHex,
      keyId: Number(wantedKeyId),
      kind: row.kind,
      kindLabel: LEDGER_KIND_LABELS[row.kind],
      machine: { shortId: core.prettyShortId(shortId), bound: !universal },
      request: parsed ? { version: parsed.version, conflicts: parsed.conflicts, message: parsed.message } : null,
      buyerMessage,
      sms: buildBuyerSms({ code: issued.code, shortId, universal }),
      agrolic,
      exe,
      revokeNote,
      replaced: replaced.map((item) => summarizeRow(item)),
      ledgerFile: files.ledger,
      row: summarizeRow(row),
    };
  }

  async function appendLedgerRow(rows) {
    if (!files.ledger) return;
    await mkdir(path.dirname(files.ledger));
    await appendLedgerRows(files.ledger, rows, fsIo);
  }

  /** Отзыв: в проекте — правка keys.cjs, иначе только пометка в журнале. */
  async function revokeSerials(serials, { enabled = true, published } = {}) {
    const list = serials.map((value) => String(value ?? "").toLowerCase()).filter(Boolean);
    if (!list.length || !enabled) return null;
    const canWriteCjs = Boolean(published?.source?.endsWith(".cjs")) && !published.missing;
    if (!canWriteCjs) {
      await markRowsRevoked(list);
      return { mode: "ledger-only", message: "Отзыв помечен в журнале: файл открытых ключей приложения недоступен, перевыпускать EXE не нужно — в следующей сборке этот код не примется после добавления серийника в keys.cjs." };
    }
    const next = { keys: published.keys, revokedSerials: [...new Set([...published.revokedSerials, ...list])].sort() };
    await writeKeysModule(published.source, next, { writeFile, existsSync });
    await markRowsRevoked(list);
    return { mode: "keys.cjs", message: `Серийники добавлены в ${published.source}: в следующей сборке EXE эти коды не примутся.`, count: list.length };
  }

  async function markRowsRevoked(serials) {
    const rows = await ledgerRows();
    const set = new Set(serials);
    let touched = false;
    const stamp = ledgerNow(now());
    const next = rows.map((row) => {
      if (!set.has(String(row.serial).toLowerCase()) || row.status === "revoked") return row;
      touched = true;
      return { ...row, status: "revoked", revokedAt: stamp };
    });
    if (touched) await saveLedger(files.ledger, next, { writeFile, rename });
    return touched;
  }

  /** Отзыв по серийнику из журнала (кнопка в таблице). */
  async function revoke(input = {}) {
    const serial = String(input.serial ?? "").replace(/[^0-9a-fA-F]/g, "").toLowerCase();
    if (serial.length !== 16) return reject("Серийник — 16 hex-символов (видно в журнале и на экране активации)");
    const published = await appKeys();
    const result = await revokeSerials([serial], { enabled: true, published });
    return { ok: true, message: result?.message ?? "Готово", mode: result?.mode ?? "none" };
  }

  async function ledger() {
    const rows = await ledgerRows();
    return { ok: true, file: files.ledger, rows: rows.map(summarizeRow).reverse(), csv: serializeLedger(rows) };
  }

  function summarizeRow(row) {
    return {
      issuedAt: row.issuedAt ?? "",
      serial: row.serial ?? "",
      serialPretty: core.prettySerial(row.serial ?? ""),
      keyId: row.keyId ?? "",
      kind: row.kind ?? "personal",
      kindLabel: LEDGER_KIND_LABELS[row.kind] ?? row.kind ?? "",
      shortId: row.shortId ? core.prettyShortId(row.shortId) : "",
      code: row.code ?? "",
      name: row.name ?? "",
      phone: row.phone ?? "",
      email: row.email ?? "",
      note: row.note ?? "",
      status: row.status === "revoked" ? "revoked" : "active",
      statusLabel: LEDGER_STATUS_LABELS[row.status === "revoked" ? "revoked" : "active"],
      revokedAt: row.revokedAt ?? "",
      replaces: row.replaces ?? "",
    };
  }

  /* ── Проверка кода ────────────────────────────────────────────────────── */

  async function verify(input = {}) {
    const published = await appKeys();
    if (!published.keys.length) return reject(`Открытые ключи приложения не найдены (${files.keys})`);
    const code = String(input.code ?? "") || findActivationCode(input.requestText ?? "");
    if (!code) return reject("Вставьте код активации или текст, где он есть");
    let machineShortId = "";
    const machineInput = String(input.machineCode ?? "").trim();
    if (machineInput) {
      const resolved = normalizeMachineCode(machineInput);
      if (!resolved.ok) return reject(`Код компьютера: ${resolved.message}`, { field: "machineCode" });
      machineShortId = resolved.shortId;
    }
    const result = core.verifyCode({ code, keys: published.keys, machineShortId, revokedSerials: published.revokedSerials });
    if (!result.ok) {
      return { ok: false, reason: result.reason, message: REJECT_HINTS[result.reason] ?? "Код не принят" };
    }
    const license = result.license;
    return {
      ok: true,
      code: result.encoded,
      license: {
        productName: license.productName,
        serial: license.serial,
        serialHex: license.serialHex,
        keyId: license.keyId,
        bound: license.bound,
        permanent: license.permanent,
        expiration: license.expiration,
      },
      machine: {
        shortId: machineShortId ? core.prettyShortId(machineShortId) : "",
        checked: Boolean(machineShortId),
        verdict: !machineShortId
          ? "код компьютера не указан — привязку не сверяли"
          : license.bound
            ? "привязка совпала: этот код работает на указанном компьютере"
            : "код универсальный, привязки нет",
      },
      ledgerNote: (await ledgerRows()).find((row) => row.serial === license.serialHex) ? "в журнале выдачи" : "в журнале нет (код выписан не этой станцией)",
      message: license.bound ? "Код персональный: привязан к отпечатку компьютера." : "Код универсальный: работает на любом компьютере.",
    };
  }

  const REJECT_HINTS = {
    EMPTY: "Код пустой.",
    MALFORMED: "В коде посторонние символы или нарушена структура.",
    LENGTH: "Код неполный или содержит лишние символы.",
    VERSION: "Код выпущен для другой версии формата.",
    PRODUCT: "Код от другого продукта.",
    UNKNOWN_KEY: "В приложении нет открытого ключа этого кода — соберите EXE после keygen.",
    SIGNATURE: "Подпись не совпала: код изменён или выдуман.",
    REVOKED: "Лицензия отозвана владельцем.",
    MACHINE_MISMATCH: "Код выписан для другого компьютера.",
    MACHINE_UNKNOWN: "Не указан код компьютера для сверки.",
  };

  /* ── Проверочный EXE ──────────────────────────────────────────────────── */

  async function findExes() {
    const found = [];
    const seen = new Set();
    for (const source of config.exeSources ?? []) {
      const info = await stat(source).catch(() => null);
      if (!info) continue;
      const push = async (file, name) => {
        if (seen.has(file)) return;
        const st = await stat(file).catch(() => null);
        if (!st?.isFile?.()) return;
        seen.add(file);
        found.push({ file, name, size: st.size, mtimeMs: Math.round(st.mtimeMs) });
      };
      if (info.isDirectory()) {
        const names = await readdir(source).catch(() => []);
        for (const name of names.filter((item) => EXE_NAME.test(item))) await push(path.join(source, name), name);
      } else if (EXE_NAME.test(path.basename(source))) {
        await push(source, path.basename(source));
      }
    }
    return found;
  }

  /**
   * Готовит проверочную копию: тот же EXE, другое имя. Имя — единственный
   * переключатель, который меняет поведение (electron/license/checkmode.cjs):
   * у копии свой файл лицензии, поэтому она спрашивает код.
   */
  async function buildCheckExe({ instance, source } = {}) {
    const id = sanitizeInstance(instance) || newInstance(now());
    const fileName = checkExeName(id);
    const candidates = await findExes();
    const base = source ? candidates.find((item) => item.name === source || item.file === source) : candidates[0];
    if (!base) {
      const note = config.exeUrl
        ? `Локального EXE нет — скачайте по ссылке и переименуйте файл в «${fileName}.exe»: в таком виде копия спросит код активации.`
        : `Собранных EXE не найдено (искали в: ${(config.exeSources ?? []).join(", ") || "—"}). Соберите npm run dist:win или укажите AGRO_EXE/AGRO_EXE_URL.`;
      return { ready: false, instance: id, fileName, url: config.exeUrl || "", note };
    }
    await mkdir(files.outDir);
    const target = path.join(files.outDir, fileName);
    await fsp.rm(target, { force: true }).catch(() => {});
    try {
      await link(base.file, target);
    } catch {
      await copyFile(base.file, target);
    }
    const info = await stat(target).catch(() => ({ size: base.size }));
    return {
      ready: true,
      instance: id,
      fileName,
      size: Number(info?.size ?? base.size ?? 0),
      url: `/download/${encodeURIComponent(fileName)}`,
      base: base.name,
      outDir: files.outDir,
      note: "Это тот же EXE, только с другим именем: у проверочной копии свой файл лицензии, поэтому код активации она запросит.",
    };
  }

  /** Путь для отдачи файла: только из каталога проверочных копий и каталогов-источников. */
  async function resolveDownload(name) {
    const clean = String(name ?? "").replace(/^\/+/, "");
    if (!EXE_NAME.test(clean)) return null;
    const inOut = path.join(files.outDir, clean);
    if (existsSync(inOut)) return inOut;
    for (const item of await findExes()) {
      if (item.name === clean) return item.file;
    }
    return null;
  }

  /* ── Проверка активации на этом компьютере ────────────────────────────── */

  async function activation(input = {}) {
    const machineId = machine.machineId;
    const report = await inspectActivation({
      machineId,
      // dirs можно передать: имитация профиля приложения в тестах и редкий
      // случай, когда профиль перенесён на другой диск.
      dirs: input.dirs?.length ? input.dirs : licenseDirectoryCandidates(),
      listFiles: (dir) => readdir(dir),
      readFile: (file) => readFile(file),
    }).catch((error) => ({ error: String(error?.message ?? error), scanned: [], dirs: [] }));
    return {
      ok: true,
      machine: {
        shortId: core.prettyShortId(core.machineShortId(machineId)),
        machineId,
        quality: machine.quality,
        source: machine.source,
      },
      dirs: report.dirs ?? [],
      files: (report.scanned ?? []).flatMap((item) => item.files.map((file) => ({ ...file, dir: item.dir }))),
      error: report.error ?? "",
    };
  }

  /** Сброс активации на этом компьютере: приложение снова попросит код. */
  async function reset(input = {}) {
    const machineId = machine.machineId;
    const report = await inspectActivation({
      machineId,
      dirs: input.dirs?.length ? input.dirs : licenseDirectoryCandidates(),
      listFiles: (dir) => readdir(dir),
      readFile: (file) => readFile(file),
    });
    const wanted = (report.scanned ?? [])
      .flatMap((item) => item.files.map((file) => ({ ...file, dir: item.dir })))
      .filter((item) => (input.all ? true : String(item.name).endsWith(".license")))
      // instance — конкретная проверочная копия, checks — только проверочные,
      // по умолчанию — только основная лицензия (её обычно и надо сбросить).
      .filter((item) => {
        if (input.instance) return item.instance === sanitizeInstance(input.instance);
        if (input.checks) return Boolean(item.instance);
        return !item.instance;
      });
    if (!wanted.length) return { ok: true, changed: [], message: "Сбрасывать нечего: файлов лицензии не найдено" };
    if (input.dryRun) return { ok: true, dryRun: true, changed: wanted.map((item) => ({ file: path.join(item.dir, item.name) })) };
    const changed = await resetLicenseFiles({
      files: wanted,
      purge: input.purge === true,
      rename,
      unlink: (file) => fsp.rm(file, { force: true }),
    });
    return {
      ok: true,
      changed,
      message: changed.length
        ? "Активация сброшена — следующий запуск приложения спросит код"
        : "Готово",
    };
  }

  return {
    activation,
    appKeys,
    buildCheckExe,
    findExes,
    issue,
    ledger,
    reset,
    resolveDownload,
    revoke,
    state,
    verify,
    files,
    /** Имя проверочного EXE по идентификатору — нужно интерфейсу. */
    fileNameFor: (instance) => checkExeName(sanitizeInstance(instance) || "check"),
    newInstanceId: () => newInstance(now()),
  };
}
