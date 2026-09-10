/**
 * Единый источник политики Content-Security-Policy для main process и сборки Vite.
 *
 * Разрешены собственные ресурсы приложения и один источник тайлов —
 * Esri World Imagery (спутник). Никаких CDN со скриптами, no eval
 * (кроме wasm), no object/base/frame.
 */

"use strict";

const TILE_HOSTS = ["https://server.arcgisonline.com"];

const CSP_PRODUCTION = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "style-src-attr 'unsafe-inline'",
  "font-src 'self'",
  `img-src 'self' data: blob: ${TILE_HOSTS.join(" ")}`,
  `connect-src 'self' ${TILE_HOSTS.join(" ")}`,
  "worker-src 'self' blob:",
  "child-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");

/** Внешние ссылки, которые разрешено открыть в системном браузере (атрибуция источников). */
const EXTERNAL_LINK_HOSTS = new Set([
  "leafletjs.com",
  "www.esri.com",
  "esri.com",
  "server.arcgisonline.com",
]);

module.exports = { CSP_PRODUCTION, TILE_HOSTS, EXTERNAL_LINK_HOSTS };
