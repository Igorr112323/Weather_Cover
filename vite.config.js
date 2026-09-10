import { createRequire } from "node:module";
import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vite";

const require = createRequire(import.meta.url);
const pkg = require("./package.json");

/**
 * Content-Security-Policy для production-сборки.
 * Разрешены только собственные ресурсы приложения и два источника тайлов.
 * В dev-режиме CSP не вставляется: Vite подключает инлайновые модули HMR.
 */
const CSP_PRODUCTION = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "style-src-attr 'unsafe-inline'",
  "font-src 'self'",
  "img-src 'self' data: blob: https://basemaps.cartocdn.com https://*.basemaps.cartocdn.com https://server.arcgisonline.com",
  "connect-src 'self' https://basemaps.cartocdn.com https://*.basemaps.cartocdn.com https://server.arcgisonline.com",
  "worker-src 'self' blob:",
  "child-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");

/** Инъекция CSP в собранный HTML (в Electron заголовок ставит и app://-протокол). */
function injectCsp() {
  // frame-ancestors игнорируется в <meta> (действует только в заголовке)
  // и шумит ошибкой в консоль, поэтому из meta-версии директива убрана.
  // В Electron заголовок протокола отдаёт полную политику из electron/csp.cjs.
  const CSP_META = CSP_PRODUCTION.split(";")
    .map((part) => part.trim())
    .filter((part) => part && !part.startsWith("frame-ancestors"))
    .join("; ");
  return {
    name: "agro-inject-csp",
    apply: "build",
    transformIndexHtml: {
      order: "pre",
      handler() {
        return [{ tag: "meta", attrs: { "http-equiv": "Content-Security-Policy", content: CSP_META }, injectTo: "head-prepend" }];
      },
    },
  };
}

export default defineConfig({
  // Корень — src/: собранный index.html оказывается в корне dist/,
  // что ожидает протокол app:// в Electron (см. electron/main.cjs).
  root: fileURLToPath(new URL("./src", import.meta.url)),
  base: "./",
  publicDir: false,
  envPrefix: "AGRO_",
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    __CSP__: JSON.stringify(CSP_PRODUCTION),
  },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  server: {
    host: "0.0.0.0",
    port: Number(process.env.AGRO_PORT ?? 5173),
    strictPort: true,
    // Предпросмотр в браузере работает за прокси, поэтому ограничение по имени хоста снято
    // намеренно и только для dev-сервера. Production-сборка отдаётся из Electron.
    allowedHosts: true,
  },
  preview: {
    host: "0.0.0.0",
    port: Number(process.env.AGRO_PREVIEW_PORT ?? 4173),
    strictPort: true,
    allowedHosts: true,
  },
  optimizeDeps: {
    include: ["leaflet", "chart.js/auto", "sql.js/dist/sql-wasm-browser.js"],
  },
  build: {
    // Абсолютный путь: outDir считается от root, а dist/ лежит в корне проекта.
    outDir: fileURLToPath(new URL("./dist", import.meta.url)),
    emptyOutDir: true,
    target: "chrome120",
    cssCodeSplit: false,
    sourcemap: false,
    rollupOptions: {
      input: fileURLToPath(new URL("./src/index.html", import.meta.url)),
      output: {
        entryFileNames: "assets/[name].js",
        chunkFileNames: "assets/[name].js",
        assetFileNames: "assets/[name][extname]",
      },
    },
  },
  plugins: [injectCsp()],
});
