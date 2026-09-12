/**
 * Main process «АгроПрогноз — Кукуруза».
 *
 * Безопасность:
 *   - contextIsolation: true, nodeIntegration: false, sandbox: true;
 *   - production-ресурсы отдаются привилегированным протоколом app:// с CSP
 *     в заголовке ответа, без file://;
 *   - навигация и window.open запрещены; в системном браузере открываются
 *     только ссылки из allowlist (атрибуция источников карт);
 *   - запросы разрешений (геолокация, камера, уведомления…) отклоняются;
 *   - renderer получает узкий API из preload.cjs: чтение/запись базы,
 *     сохранение копии, запись файла выгрузки и сигнал «интерфейс готов».
 *
 * Запуск: сначала открывается экран загрузки (splash.html), главное окно
 * создаётся скрытым и показывается, когда renderer построил интерфейс.
 * В portable-сборке до этого момента на экране заставка NSIS (build/splash.bmp):
 * она убирается только после появления первого окна приложения — см.
 * markSplashHandoff() и scripts/patch-portable-nsi.mjs.
 *
 * ASAR — это упаковка, а не криптографическая защита исходников.
 */

"use strict";

const { app, BrowserWindow, Menu, dialog, ipcMain, nativeImage, protocol, screen, session, shell } = require("electron");
const fs = require("node:fs");
const path = require("node:path");

const { createFileStore } = require("./persistence.cjs");
const { CSP_PRODUCTION, EXTERNAL_LINK_HOSTS } = require("./csp.cjs");

const PROTOCOL_NAME = "app";
const PROTOCOL_HOST = "agroprognoz.local";
const DB_FILE_NAME = "agroprognoz.sqlite";
const FLUSH_TIMEOUT_MS = 1500;

/** Экран загрузки: размер окна совпадает с build/splash.bmp portable-сборки. */
const SPLASH_SIZE = Object.freeze({ width: 440, height: 280 });
/**
 * Страховка экрана загрузки: если renderer не сообщил о готовности (сбой при
 * запуске), главное окно всё равно откроется — через 8 с после первой
 * отрисовки или через 20 с после создания окна.
 */
const REVEAL_AFTER_PAINT_MS = 8000;
const REVEAL_HARD_LIMIT_MS = 20000;
/** Экран загрузки показывается после первого кадра со шрифтами; предел ожидания шрифтов. */
const SPLASH_FONTS_TIMEOUT_MS = 1000;
/** Экран загрузки закрывается чуть позже показа главного окна, чтобы между ними не было пустого кадра. */
const SPLASH_CLOSE_DELAY_MS = 250;
/**
 * Portable-сборка: NSIS держит заставку build/splash.bmp, пока приложение не
 * создаст файл по этому пути. Переменную задаёт NSIS перед запуском
 * (scripts/patch-portable-nsi.mjs); вне portable-сборки она пуста.
 */
const SPLASH_HANDOFF_FILE = String(process.env.AGRO_SPLASH_HANDOFF_FILE ?? "");
/** Ждём в странице заставки загрузки шрифтов и два кадра — окно откроется уже отрисованным. */
const SPLASH_PAINTED_SCRIPT = `new Promise((resolve) => {
  const done = () => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true)));
  const fonts = document.fonts && document.fonts.ready ? document.fonts.ready : Promise.resolve();
  fonts.then(done, done);
  setTimeout(() => resolve(true), 600);
})`;

const ROOT = path.resolve(__dirname, "..");
const DIST_DIR = path.join(ROOT, "dist");
const DEV_SERVER_URL = (process.env.AGRO_DEV_SERVER || process.env.VITE_DEV_SERVER_URL || "").replace(/\/+$/, "");
const isDev = !app.isPackaged && Boolean(DEV_SERVER_URL);

const MIME_TYPES = new Map([
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".mjs", "text/javascript; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".svg", "image/svg+xml"],
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".webp", "image/webp"],
  [".ico", "image/x-icon"],
  [".woff", "font/woff"],
  [".woff2", "font/woff2"],
  [".ttf", "font/ttf"],
  [".wasm", "application/wasm"],
  [".map", "application/json; charset=utf-8"],
  [".geojson", "application/geo+json; charset=utf-8"],
]);

let mainWindow = null;
let splashWindow = null;
let mainRevealed = false;
let splashHandoffDone = false;
let fileStore = null;
let closePhase = false;

const log = (...args) => console.log("[agroprognoz]", ...args);

/* ── Каталог данных и файловый слой ─────────────────────────────────────── */

function store() {
  if (!fileStore) {
    fileStore = createFileStore({
      dir: app.getPath("userData"),
      fileName: DB_FILE_NAME,
      log,
    });
  }
  return fileStore;
}

function iconPath() {
  const candidates = [
    path.join(process.resourcesPath ?? ROOT, "build", "icon.png"),
    path.join(ROOT, "build", "icon.png"),
    path.join(ROOT, "src", "assets", "brand", "app-icon.png"),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return undefined;
}

/* ── Протокол app:// для production ──────────────────────────────────────── */

function registerAppProtocol() {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: PROTOCOL_NAME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        stream: true,
        corsEnabled: false,
      },
    },
  ]);
}

function startAppProtocol() {
  protocol.handle(PROTOCOL_NAME, async (request) => {
    const url = new URL(request.url);
    if (url.hostname !== PROTOCOL_HOST) return notFound();

    let pathname = decodeURIComponent(url.pathname);
    if (pathname === "/" || pathname.length === 0) pathname = "/index.html";
    const target = path.normalize(path.join(DIST_DIR, pathname));
    // Выход за пределы каталога сборки невозможен: путь проверяется после нормализации
    if (!target.startsWith(DIST_DIR + path.sep) && target !== DIST_DIR) return notFound();

    try {
      const stat = await fs.promises.stat(target);
      if (stat.isDirectory()) return notFound();
      const data = await fs.promises.readFile(target);
      return new Response(data, {
        status: 200,
        headers: {
          "Content-Type": MIME_TYPES.get(path.extname(target).toLowerCase()) ?? "application/octet-stream",
          "Content-Security-Policy": CSP_PRODUCTION,
          "X-Content-Type-Options": "nosniff",
          "Referrer-Policy": "no-referrer",
          "Cache-Control": "no-cache",
        },
      });
    } catch {
      return notFound();
    }
  });
}

function notFound() {
  return new Response("Ресурс не найден", { status: 404, headers: { "Content-Type": "text/plain; charset=utf-8" } });
}

/* ── Окно ────────────────────────────────────────────────────────────────── */

function hardenWebContents(contents) {
  contents.setWindowOpenHandler(({ url }) => {
    openExternalIfAllowed(url);
    return { action: "deny" };
  });

  contents.on("will-navigate", (event, url) => {
    if (isDev && sameOrigin(url, DEV_SERVER_URL)) return;
    if (url.startsWith(`${PROTOCOL_NAME}://${PROTOCOL_HOST}/`)) return;
    log("Навигация отклонена:", url.slice(0, 120));
    event.preventDefault();
  });

  contents.on("will-attach-webview", (event) => {
    event.preventDefault();
  });
}

function sameOrigin(candidate, base) {
  try {
    return new URL(candidate).origin === new URL(base).origin;
  } catch {
    return false;
  }
}

function openExternalIfAllowed(url) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" || !EXTERNAL_LINK_HOSTS.has(parsed.hostname)) return false;
    void shell.openExternal(parsed.href);
    return true;
  } catch {
    return false;
  }
}

function pageUrl(fileName) {
  return isDev ? `${DEV_SERVER_URL}/${fileName}` : `${PROTOCOL_NAME}://${PROTOCOL_HOST}/${fileName}`;
}

/**
 * Первое окно приложения на экране: сообщаем об этом заставке NSIS
 * (portable-сборка), и она убирает build/splash.bmp — окно уже перекрывает его.
 */
function markSplashHandoff() {
  if (splashHandoffDone || !SPLASH_HANDOFF_FILE) return;
  splashHandoffDone = true;
  try {
    // Синхронно: вызывается и перед немедленным выходом (вторая копия приложения).
    fs.writeFileSync(SPLASH_HANDOFF_FILE, String(Date.now()));
  } catch (error) {
    log("splash-handoff:", error?.code ?? error?.message);
  }
}

/**
 * Позиция экрана загрузки — центр основного экрана целиком (не рабочей
 * области): ровно там заставку рисует NSIS в portable-сборке, поэтому окно
 * Electron появляется точно поверх неё.
 */
function splashPosition() {
  try {
    const { bounds } = screen.getPrimaryDisplay();
    return {
      x: Math.round(bounds.x + (bounds.width - SPLASH_SIZE.width) / 2),
      y: Math.round(bounds.y + (bounds.height - SPLASH_SIZE.height) / 2),
    };
  } catch {
    return null;
  }
}

/**
 * Экран загрузки: небольшое окно без рамки со страницей splash.html.
 * Появляется, как только страница отрисована (шрифты загружены), и закрывается,
 * когда главное окно построило интерфейс (сигнал agro:app-ready из renderer'а).
 */
function createSplashWindow() {
  const icon = iconPath();
  const position = splashPosition();
  const win = new BrowserWindow({
    width: SPLASH_SIZE.width,
    height: SPLASH_SIZE.height,
    useContentSize: true,
    ...(position ?? { center: true }),
    frame: false,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    show: false,
    title: "АгроПрогноз — Кукуруза",
    backgroundColor: "#f4f7f4",
    icon: icon ? nativeImage.createFromPath(icon) : undefined,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: false,
      spellcheck: false,
      devTools: false,
    },
  });

  win.setMenuBarVisibility(false);
  win.on("show", markSplashHandoff);

  let shown = false;
  const show = () => {
    if (shown || win.isDestroyed() || mainRevealed) return;
    shown = true;
    win.show();
  };
  // Первый кадр уже есть; дожидаемся ещё шрифтов, чтобы текст не «перерисовывался»
  // на глазах. Таймер — страховка, если страница не ответила.
  win.once("ready-to-show", () => {
    if (win.isDestroyed()) return;
    const timer = setTimeout(show, SPLASH_FONTS_TIMEOUT_MS);
    win.webContents
      .executeJavaScript(SPLASH_PAINTED_SCRIPT, true)
      .catch(() => null)
      .then(() => {
        clearTimeout(timer);
        show();
      });
  });
  // Страница не загрузилась (повреждена сборка) — окно всё равно показываем:
  // пустой фон цвета приложения лучше, чем ничего, а главное окно откроется по таймерам.
  win.webContents.on("did-fail-load", (_event, errorCode, _description, _url, isMainFrame) => {
    if (isMainFrame && errorCode !== -3) show();
  });
  win.on("closed", () => {
    if (splashWindow === win) splashWindow = null;
  });

  void win.loadURL(pageUrl("splash.html"));
  splashWindow = win;
  return win;
}

/** Показывает главное окно и убирает экран загрузки (ровно один раз). */
function revealMainWindow() {
  if (mainRevealed) return;
  mainRevealed = true;

  const win = mainWindow;
  if (win && !win.isDestroyed()) {
    win.show();
    win.focus();
  }

  // Заставка закрывается, когда главное окно уже на экране: оно больше и
  // целиком перекрывает её, поэтому смена окон проходит без пустого кадра.
  const splash = splashWindow;
  splashWindow = null;
  if (splash && !splash.isDestroyed()) {
    setTimeout(() => {
      if (!splash.isDestroyed()) splash.destroy();
    }, SPLASH_CLOSE_DELAY_MS);
  }
}

function createWindow() {
  const icon = iconPath();
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 640,
    show: false,
    title: "АгроПрогноз — Кукуруза",
    backgroundColor: "#f4f7f4",
    autoHideMenuBar: true,
    icon: icon ? nativeImage.createFromPath(icon) : undefined,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: false,
      spellcheck: false,
      devTools: !app.isPackaged,
    },
  });

  // Окно открывается по сигналу agro:app-ready, когда интерфейс уже построен, —
  // до этого человек видит экран загрузки, а не пустое окно. Страховка на случай
  // сбоя при запуске: таймер после первой отрисовки и ошибки загрузки страницы.
  win.once("ready-to-show", () => {
    setTimeout(() => revealMainWindow(), REVEAL_AFTER_PAINT_MS);
  });
  setTimeout(() => revealMainWindow(), REVEAL_HARD_LIMIT_MS);
  win.webContents.on("did-fail-load", (_event, errorCode, _description, _url, isMainFrame) => {
    // −3 (ABORTED) — отменённая навигация, не ошибка страницы
    if (isMainFrame && errorCode !== -3) revealMainWindow();
  });
  win.webContents.on("render-process-gone", () => revealMainWindow());
  win.on("show", markSplashHandoff);

  if (isDev) {
    win.webContents.openDevTools({ mode: "detach" });
    void win.loadURL(DEV_SERVER_URL);
  } else {
    void win.loadURL(pageUrl("index.html"));
  }

  // Перед закрытием даём renderer'у дописать данные на диск
  win.on("close", (event) => {
    if (closePhase) return;
    event.preventDefault();
    closePhase = true;
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      ipcMain.removeListener("agro:flushed", finish);
      win.destroy();
    };
    ipcMain.once("agro:flushed", finish);
    win.webContents.send("agro:flush-request");
    setTimeout(finish, FLUSH_TIMEOUT_MS);
  });

  win.on("closed", () => {
    if (mainWindow === win) mainWindow = null;
  });

  mainWindow = win;
  return win;
}

/* ── IPC: только операции хранения и экспорта ────────────────────────────── */

function registerIpc() {
  ipcMain.on("agro:app-ready", (event) => {
    if (mainWindow && !mainWindow.isDestroyed() && event.sender === mainWindow.webContents) revealMainWindow();
  });

  ipcMain.handle("agro:get-app-info", () => ({
    ok: true,
    version: app.getVersion(),
    name: "АгроПрогноз — Кукуруза",
    platform: process.platform,
    electron: process.versions.electron,
    databaseFileName: DB_FILE_NAME,
  }));

  ipcMain.handle("agro:read-database", async () => {
    try {
      const bytes = await store().read();
      return { ok: true, bytes };
    } catch (error) {
      log("read-database:", error?.code ?? error?.message);
      return { ok: false, code: "READ_FAILED", message: "Не удалось прочитать файл базы данных" };
    }
  });

  ipcMain.handle("agro:write-database", async (event, bytes) => {
    try {
      const result = await store().write(bytes);
      return { ok: true, bytes: result.bytes };
    } catch (error) {
      log("write-database:", error?.code ?? error?.message);
      return { ok: false, code: "WRITE_FAILED", message: "Не удалось записать файл базы данных" };
    }
  });

  ipcMain.handle("agro:preserve-database", async (_event, reason) => {
    try {
      const fileName = await store().preserve(typeof reason === "string" ? reason : "error");
      return { ok: true, fileName };
    } catch (error) {
      log("preserve-database:", error?.code ?? error?.message);
      return { ok: false, code: "PRESERVE_FAILED", message: "Не удалось сохранить копию файла базы данных" };
    }
  });

  /**
   * Путь выбирает человек в системном диалоге — renderer передаёт только имя
   * файла и содержимое. Запись «куда попало» невозможна.
   */
  ipcMain.handle("agro:save-file", async (event, payload) => {
    const bytes = payload?.bytes;
    const requestedName = String(payload?.fileName ?? "export.csv");
    if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0) {
      return { ok: false, code: "INVALID_INPUT", message: "Некорректное содержимое файла" };
    }
    const win = BrowserWindow.fromWebContents(event.sender);
    const dialogResult = await dialog.showSaveDialog(win ?? mainWindow, {
      title: "Сохранить CSV",
      defaultPath: requestedName,
      filters: [{ name: "Таблица CSV", extensions: ["csv"] }],
    });
    if (dialogResult.canceled || !dialogResult.filePath) {
      return { ok: false, code: "canceled", message: "Сохранение отменено" };
    }
    try {
      await store().writeTo(dialogResult.filePath, bytes);
      return { ok: true, fileName: path.basename(dialogResult.filePath) };
    } catch (error) {
      log("save-file:", error?.code ?? error?.message);
      return { ok: false, code: "WRITE_FAILED", message: "Не удалось записать файл" };
    }
  });
}

/* ── Запуск ──────────────────────────────────────────────────────────────── */

const gotLock = app.requestSingleInstanceLock();

if (!gotLock) {
  // Приложение уже запущено: заставке portable-сборки ждать нечего.
  markSplashHandoff();
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  registerAppProtocol();

  void app.whenReady().then(() => {
    session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
      log("Разрешение отклонено:", permission);
      callback(false);
    });
    session.defaultSession.setPermissionCheckHandler(() => false);

    if (!isDev) startAppProtocol();
    registerIpc();

    if (app.isPackaged) Menu.setApplicationMenu(null);
    else {
      Menu.setApplicationMenu(
        Menu.buildFromTemplate([
          { role: "appMenu", label: "Приложение" },
          { role: "editMenu", label: "Правка" },
          {
            label: "Вид",
            submenu: [
              { role: "reload" },
              { role: "toggleDevTools" },
              { type: "separator" },
              { role: "resetZoom" },
              { role: "zoomIn" },
              { role: "zoomOut" },
              { type: "separator" },
              { role: "togglefullscreen" },
            ],
          },
        ]),
      );
    }

    // Сначала экран загрузки (лёгкий, появляется сразу), затем главное окно.
    createSplashWindow();
    createWindow();

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        mainRevealed = false;
        createSplashWindow();
        createWindow();
      }
    });
  });

  app.on("window-all-closed", () => {
    app.quit();
  });

  app.on("web-contents-created", (_event, contents) => {
    hardenWebContents(contents);
  });
}
