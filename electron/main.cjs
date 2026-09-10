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
 *     сохранение копии и запись файла выгрузки.
 *
 * ASAR — это упаковка, а не криптографическая защита исходников.
 */

"use strict";

const { app, BrowserWindow, Menu, dialog, ipcMain, nativeImage, protocol, session, shell } = require("electron");
const fs = require("node:fs");
const path = require("node:path");

const { createFileStore } = require("./persistence.cjs");
const { CSP_PRODUCTION, EXTERNAL_LINK_HOSTS } = require("./csp.cjs");

const PROTOCOL_NAME = "app";
const PROTOCOL_HOST = "agroprognoz.local";
const DB_FILE_NAME = "agroprognoz.sqlite";
const FLUSH_TIMEOUT_MS = 1500;

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

  win.once("ready-to-show", () => win.show());

  if (isDev) {
    win.webContents.openDevTools({ mode: "detach" });
    void win.loadURL(DEV_SERVER_URL);
  } else {
    void win.loadURL(`${PROTOCOL_NAME}://${PROTOCOL_HOST}/index.html`);
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

    createWindow();

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on("window-all-closed", () => {
    app.quit();
  });

  app.on("web-contents-created", (_event, contents) => {
    hardenWebContents(contents);
  });
}
