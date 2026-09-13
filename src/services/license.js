/**
 * Лицензия на стороне интерфейса.
 *
 * Renderer не проверяет подпись и не знает открытых ключей: он спрашивает
 * состояние у main process и показывает экран активации, пока лицензия не
 * принята. Решение принимает electron/license/guard.cjs — единственный
 * модуль приложения, который умеет сказать «активировано».
 *
 * Три режима:
 *   • dev      — сборка dev-сервера Vite: разработка и smoke-тесты в браузере,
 *                активация не требуется. В production-сборке эта ветка
 *                вырезается статически (import.meta.env.DEV → false), поэтому
 *                «включить режим разработки» в готовом приложении нельзя;
 *   • electron — приложение запущено из AgroPrognoz.exe: состояние лицензии
 *                приходит из main process вместе с токеном сессии для preload;
 *   • browser  — production-сборку открыли в браузере (например, распаковали
 *                app.asar и раздали dist/ статикой): данные в таком режиме не
 *                отдаются, приложение показывает отказ.
 *
 * Дат здесь нет: лицензия бессрочная, поле expiration всегда null и нигде не
 * сравнивается с текущим временем.
 */

export const LICENSE_MODE = Object.freeze({
  DEV: "dev",
  ELECTRON: "electron",
  BROWSER: "browser",
});

/** Состояние, которое видит интерфейс, когда лицензия принята. */
function activatedStatus(overrides = {}) {
  return {
    ok: true,
    activated: true,
    requiresActivation: false,
    permanent: true,
    terms: "permanent",
    expiration: null,
    serial: null,
    keyId: null,
    bound: false,
    tampered: false,
    message: "Лицензия активирована. Срок действия не ограничен.",
    machineIdShort: "",
    machineQuality: "high",
    ...overrides,
  };
}

function bridge() {
  return typeof window !== "undefined" ? window.agro : null;
}

/**
 * Состояние лицензии при запуске.
 * @returns {Promise<{mode:string, activated:boolean, status:object|null}>}
 */
export async function resolveLicense() {
  // В production-сборке Vite заменяет import.meta.env.DEV на false, и ветка
  // разработки исчезает из бандла вместе со своим условием.
  if (import.meta.env.DEV) {
    return { mode: LICENSE_MODE.DEV, activated: true, status: activatedStatus({ dev: true }) };
  }

  const api = bridge();
  if (!api?.license?.status) {
    // Production-сборка вне Electron: ни лицензии, ни данных.
    return { mode: LICENSE_MODE.BROWSER, activated: false, status: null };
  }

  try {
    const status = await api.license.status();
    if (!status || status.ok === false) {
      return { mode: LICENSE_MODE.ELECTRON, activated: false, status: activatedStatus({ activated: false, ok: false, message: status?.message ?? "" }) };
    }
    return { mode: LICENSE_MODE.ELECTRON, activated: status.activated === true, status };
  } catch (error) {
    console.error("Состояние лицензии не получено", error);
    return { mode: LICENSE_MODE.ELECTRON, activated: false, status: null };
  }
}

/**
 * Активация кодом из поля ввода.
 * @param {string} code
 */
export async function activateLicense(code) {
  const api = bridge();
  if (!api?.license?.activate) return { ok: false, message: "Активация недоступна в этом режиме" };
  try {
    return await api.license.activate(String(code ?? ""));
  } catch (error) {
    console.error("Активация не выполнена", error);
    return { ok: false, message: "Не удалось связаться с ядром приложения" };
  }
}

/** Активация файлом: путь выбирается в системном диалоге. */
export async function activateLicenseFromFile() {
  const api = bridge();
  if (!api?.license?.activateFromFile) return { ok: false, message: "Активация недоступна в этом режиме" };
  try {
    return await api.license.activateFromFile();
  } catch (error) {
    console.error("Активация из файла не выполнена", error);
    return { ok: false, message: "Не удалось прочитать файл лицензии" };
  }
}

/** Повторный запрос состояния (после активации или для экрана сведений). */
export async function licenseStatus() {
  const api = bridge();
  if (!api?.license?.status) return null;
  try {
    return await api.license.status();
  } catch {
    return null;
  }
}
