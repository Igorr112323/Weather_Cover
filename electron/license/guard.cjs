/**
 * Страж лицензии (main process). Единственное место в приложении, которое
 * принимает решение «активировано / нет».
 *
 * Почему решение живёт здесь, а не в интерфейсе:
 *   • renderer не проверяет подпись и не хранит ключ — ему нечего подменять;
 *   • после успешной активации страж выдаёт одноразовый токен сессии, который
 *     живёт в замыкании preload (contextIsolation) и до renderer'а не доходит;
 *   • каждый канал данных (чтение/запись базы, выгрузка файла) требует этот
 *     токен, поэтому «взломанный» интерфейс без активации остаётся пустой
 *     картинкой: данные ему никто не отдаст.
 *
 * ЛИЦЕНЗИЯ БЕССРОЧНАЯ. В этом модуле нет ни одного обращения к системному
 * времени при принятии решения: дата не кодируется в коде активации, не
 * хранится в файле лицензии и не сравнивается ни с чем. Единственные условия —
 * действительная подпись Ed25519, отсутствие серийника в списке отозванных и
 * (для персональных кодов) совпадение отпечатка компьютера.
 */

"use strict";

const crypto = require("node:crypto");
const path = require("node:path");

const core = require("./core.cjs");
const { createMachineIdentity } = require("./machine.cjs");
const { createLicenseStore } = require("./store.cjs");
const { createIntegrityChecker } = require("./integrity.cjs");

/** Открытые ключи и отозванные лицензии (создаёт scripts/license-tool.mjs). */
const published = require("./keys.cjs");

/**
 * Корневые хэши манифеста целостности. Значения подставляет scripts/harden.mjs
 * при сборке; в исходниках остаются заполнители, и проверка целостности честно
 * отключается (см. integrity.cjs).
 */
const ROOT_HASHES = Object.freeze({
  dist: "__AGRO_DIST_ROOT__",
  electron: "__AGRO_ELECTRON_ROOT__",
});

/** Манифест создаётся сборкой; в исходниках его нет. */
function loadManifest(log) {
  try {
    // eslint-disable-next-line global-require
    const data = require("./integrity-data.cjs");
    return data && typeof data === "object" ? data : null;
  } catch (error) {
    log(`integrity: манифест не загружен (${error?.code ?? error?.message})`);
    return null;
  }
}

/** Тексты отказов — на русском, чтобы показывать их человеку как есть. */
const REJECT_MESSAGES = Object.freeze({
  [core.REJECT.EMPTY]: "Введите код активации.",
  [core.REJECT.MALFORMED]: "Код введён с ошибками: проверьте символы и скопируйте код целиком.",
  [core.REJECT.LENGTH]: "Код неполный или содержит лишние символы.",
  [core.REJECT.VERSION]: "Код выпущен для другой версии приложения — запросите новый код.",
  [core.REJECT.PRODUCT]: "Этот код от другого продукта.",
  [core.REJECT.UNKNOWN_KEY]: "Приложение не знает ключа, которым подписан код. Обновите приложение.",
  [core.REJECT.SIGNATURE]: "Код недействителен: подпись не совпала.",
  [core.REJECT.REVOKED]: "Эта лицензия отозвана владельцем приложения.",
  [core.REJECT.MACHINE_MISMATCH]:
    "Код выписан для другого компьютера. Если вы переехали на новый компьютер или переустановили Windows — нажмите «Отправить заявку владельцу» и пришлите код этого компьютера: владелец выпустит новый код взамен старого.",
  [core.REJECT.MACHINE_UNKNOWN]: "Не удалось определить идентификатор этого компьютера.",
});

const GUARD_MESSAGES = Object.freeze({
  TAMPERED: "Файлы приложения изменены. Запустите оригинальный AgroPrognoz.exe или переустановите приложение.",
  STORE_FAILED: "Лицензия принята, но сохранить её на этом компьютере не удалось: при следующем запуске код придётся ввести снова.",
  STORE_INVALID: "Файл лицензии на этом компьютере прочитать не удалось (он повреждён или скопирован с другой машины). Введите код активации ещё раз.",
});

/** Пауза после нескольких неудачных попыток: мешает перебору кодов в интерфейсе. */
const THROTTLE_STEPS = Object.freeze([
  { after: 4, delayMs: 800 },
  { after: 12, delayMs: 2500 },
  { after: 30, delayMs: 6000 },
]);

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** Коды ответов стража для IPC. */
const GATE = Object.freeze({
  NOT_ACTIVATED: "NOT_ACTIVATED",
  TAMPERED: "TAMPERED",
  FORBIDDEN: "FORBIDDEN",
});

/**
 * @param {object} [options]
 * @param {string} options.appRoot корень приложения (внутри app.asar)
 * @param {string} options.userDataDir каталог профиля приложения
 * @param {object} [options.safeStorage] модуль safeStorage из Electron
 * @param {(...args:any[])=>void} [options.log]
 * @param {{keys:Array, revokedSerials:Array}} [options.keyMaterial] подмена для тестов
 * @param {object} [options.machine] подмена идентификатора компьютера (тесты)
 * @param {object} [options.store] подмена хранилища (тесты)
 * @param {object} [options.integrity] подмена проверки целостности (тесты)
 */
function createGuard(options = {}) {
  const log = options.log ?? (() => {});
  const appRoot = options.appRoot ?? path.resolve(__dirname, "..", "..");
  const userDataDir = options.userDataDir ?? appRoot;
  const keyMaterial = options.keyMaterial ?? published ?? {};
  const keys = Array.isArray(keyMaterial.keys) ? keyMaterial.keys : [];
  const revokedSerials = Array.isArray(keyMaterial.revokedSerials) ? keyMaterial.revokedSerials : [];

  const machine = options.machine ?? createMachineIdentity({ log });
  const store =
    options.store ??
    createLicenseStore({
      dir: userDataDir,
      fileName: "agroprognoz.license",
      machineId: () => machine.machineId,
      safeStorage: options.safeStorage,
      log,
    });
  const integrity =
    options.integrity ??
    createIntegrityChecker({
      root: appRoot,
      manifest: loadManifest(log),
      rootHashes: ROOT_HASHES,
      log,
    });

  /** @type {{activated:boolean, license:object|null, reason:string|null, storeReason:string|null}} */
  const state = {
    activated: false,
    license: null,
    reason: null,
    storeReason: null,
    tampered: false,
    tamperDetail: null,
    persistError: false,
    failures: 0,
    initialized: false,
  };
  /** Токен сессии: живёт только в main и в замыкании preload. */
  let sessionToken = null;

  function machineSnapshot() {
    return {
      machineId: machine.machineId,
      machineIdShort: core.prettyShortId(core.machineShortId(machine.machineId)),
      machineQuality: machine.quality,
      machineSource: machine.source,
    };
  }

  /** Проверка подписи уже сохранённой лицензии (делается при каждом запуске). */
  function verifyStored(record) {
    if (!record || typeof record !== "object") return { ok: false, reason: core.REJECT.MALFORMED };
    const payload = Buffer.from(String(record.payload ?? ""), "base64");
    const signature = Buffer.from(String(record.signature ?? ""), "base64");
    if (payload.byteLength !== core.PAYLOAD_LENGTH || signature.byteLength !== core.SIGNATURE_LENGTH) {
      return { ok: false, reason: core.REJECT.LENGTH };
    }
    const code = core.formatCode(Buffer.concat([payload, signature]));
    return core.verifyCode({ code, keys, machineId: machine.machineId, revokedSerials });
  }

  /** Состояние для renderer'а. Токена здесь нет — его добавляет statusWithToken(). */
  function status() {
    const snapshot = machineSnapshot();
    const license = state.license;
    return {
      ok: true,
      activated: state.activated === true,
      requiresActivation: state.activated !== true,
      // Условия лицензии: других значений не существует.
      permanent: true,
      terms: "permanent",
      expiration: null,
      serial: license?.serial ?? null,
      serialHex: license?.serialHex ?? null,
      keyId: license?.keyId ?? null,
      bound: license?.bound === true,
      productName: license?.productName ?? core.PRODUCT_NAME,
      reason: state.reason,
      storeReason: state.storeReason,
      message: message(),
      tampered: state.tampered === true,
      tamperDetail: state.tamperDetail,
      persistError: state.persistError === true,
      integrityEnabled: integrity.enabled === true,
      storeFileName: store.fileName ?? null,
      ...snapshot,
    };
  }

  function message() {
    if (state.tampered) return GUARD_MESSAGES.TAMPERED;
    if (state.activated) return "Лицензия активирована. Срок действия не ограничен.";
    if (state.persistError) return GUARD_MESSAGES.STORE_FAILED;
    if (state.storeReason) return GUARD_MESSAGES.STORE_INVALID;
    if (state.reason) return REJECT_MESSAGES[state.reason] ?? "Код активации не принят.";
    return "Приложение не активировано. Введите код активации.";
  }

  /** То же состояние плюс токен сессии — только для preload, renderer его не видит. */
  function statusWithToken() {
    const result = status();
    if (result.activated && !result.tampered && sessionToken) result.token = sessionToken;
    return result;
  }

  function issueToken() {
    sessionToken = crypto.randomBytes(24).toString("base64");
  }

  function clearToken() {
    sessionToken = null;
  }

  /** Постоянное время: токен сравнивается побайтово, без ранних выходов по длине. */
  function checkToken(token) {
    if (!sessionToken || typeof token !== "string" || token.length === 0) return false;
    const expected = Buffer.from(sessionToken, "utf8");
    const actual = Buffer.from(token, "utf8");
    if (expected.length !== actual.length) return false;
    return crypto.timingSafeEqual(expected, actual);
  }

  /**
   * Пропуск для каналов данных: null — можно работать, иначе готовый ответ
   * с ошибкой, который main process возвращает renderer'у.
   */
  function gate(token) {
    if (state.tampered) {
      return { ok: false, code: GATE.TAMPERED, message: GUARD_MESSAGES.TAMPERED };
    }
    if (!state.activated) {
      return { ok: false, code: GATE.NOT_ACTIVATED, message: "Приложение не активировано" };
    }
    if (!checkToken(token)) {
      return { ok: false, code: GATE.FORBIDDEN, message: "Операция недоступна этому окну" };
    }
    return null;
  }

  async function runIntegrityCheck() {
    try {
      const result = await integrity.verify();
      if (result.skipped) {
        state.tampered = false;
        state.tamperDetail = null;
        return result;
      }
      if (!result.ok) {
        state.tampered = true;
        state.tamperDetail = (result.mismatches ?? []).slice(0, 8).join(", ") || result.reason || "mismatch";
        clearToken();
        log(`integrity: обнаружены изменения файлов (${state.tamperDetail})`);
      } else {
        state.tampered = false;
        state.tamperDetail = null;
      }
      return result;
    } catch (error) {
      // Сбой самой проверки не считается подменой файлов: иначе случайная
      // ошибка чтения лишила бы человека доступа к его данным.
      log(`integrity: проверка не выполнена (${error?.message ?? error})`);
      return { ok: true, skipped: true, mismatches: [], checked: 0, error: String(error?.message ?? error) };
    }
  }

  /** Запуск: целостность → файл лицензии → подпись → токен сессии. */
  async function initialize() {
    await runIntegrityCheck();
    if (state.tampered) {
      state.activated = false;
      state.license = null;
      state.initialized = true;
      return status();
    }

    let read;
    try {
      read = await store.read();
    } catch (error) {
      log(`license: хранилище недоступно (${error?.message ?? error})`);
      read = { status: store.STATUS?.INVALID ?? "invalid", reason: "READ_FAILED" };
    }

    if (!read || read.status === (store.STATUS?.NONE ?? "none")) {
      state.activated = false;
      state.license = null;
      state.reason = null;
      state.storeReason = null;
      state.initialized = true;
      return status();
    }

    if (read.status !== (store.STATUS?.ACTIVE ?? "active")) {
      state.activated = false;
      state.license = null;
      state.storeReason = read.reason ?? "INVALID";
      state.reason = null;
      state.initialized = true;
      try {
        await store.quarantine?.(read.reason ?? "invalid");
      } catch {
        /* копия не обязательна */
      }
      return status();
    }

    const result = verifyStored(read.record);
    state.storeReason = null;
    if (result.ok) {
      state.activated = true;
      state.license = result.license;
      state.reason = null;
      issueToken();
      log(`license: активировано, серийник ${result.license.serial}`);
    } else {
      state.activated = false;
      state.license = null;
      state.reason = result.reason;
      clearToken();
      log(`license: сохранённая лицензия не принята (${result.reason})`);
    }
    state.initialized = true;
    return status();
  }

  function throttleDelay() {
    let delay = 0;
    for (const step of THROTTLE_STEPS) if (state.failures >= step.after) delay = step.delayMs;
    return delay;
  }

  /**
   * Активация кодом (текст из поля ввода или содержимое файла лицензии).
   * @param {string} code
   */
  async function activate(code) {
    if (state.tampered) {
      return { ok: false, code: GATE.TAMPERED, reason: GATE.TAMPERED, message: GUARD_MESSAGES.TAMPERED, status: status() };
    }

    const delay = throttleDelay();
    if (delay) await sleep(delay);

    const result = core.verifyCode({
      code: typeof code === "string" ? code : "",
      keys,
      machineId: machine.machineId,
      revokedSerials,
    });

    if (!result.ok) {
      state.failures += 1;
      state.activated = false;
      state.license = null;
      state.reason = result.reason;
      state.persistError = false;
      clearToken();
      log(`license: код не принят (${result.reason}), попыток подряд: ${state.failures}`);
      return {
        ok: false,
        code: result.reason,
        reason: result.reason,
        message: REJECT_MESSAGES[result.reason] ?? "Код активации не принят.",
        attempts: state.failures,
        status: status(),
      };
    }

    const license = result.license;
    const parsed = core.parseCode(result.encoded);
    const record = {
      payload: Buffer.from(parsed.subarray(0, core.PAYLOAD_LENGTH)).toString("base64"),
      signature: Buffer.from(parsed.subarray(core.PAYLOAD_LENGTH)).toString("base64"),
      serialHex: license.serialHex,
      keyId: license.keyId,
      bound: license.bound === true,
    };

    const written = await store.write(record).catch((error) => {
      log(`license: запись не удалась (${error?.message ?? error})`);
      return { ok: false, message: "Не удалось сохранить лицензию" };
    });

    state.failures = 0;
    state.activated = true;
    state.license = license;
    state.reason = null;
    state.storeReason = null;
    state.persistError = written?.ok !== true;
    issueToken();
    log(`license: активировано, серийник ${license.serial}${state.persistError ? " (без сохранения)" : ""}`);

    // Токен отдаётся отдельным полем: preload забирает его себе и до
    // renderer'а не доносит (contextIsolation).
    return {
      ok: true,
      token: sessionToken,
      status: status(),
      message: state.persistError ? GUARD_MESSAGES.STORE_FAILED : "Приложение активировано. Лицензия бессрочная.",
      persistError: state.persistError,
    };
  }

  return {
    GATE,
    REJECT_MESSAGES,
    activate,
    checkToken,
    gate,
    initialize,
    integrityEnabled: () => integrity.enabled === true,
    runIntegrityCheck,
    status,
    statusWithToken,
    verifyStored,
    get activated() {
      return state.activated === true;
    },
    get tampered() {
      return state.tampered === true;
    },
  };
}

module.exports = { GATE, GUARD_MESSAGES, REJECT_MESSAGES, ROOT_HASHES, createGuard };
