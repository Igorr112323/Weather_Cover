/**
 * Dev-сервер Vite для браузерной разработки и предпросмотра.
 *
 *   npm run dev
 *
 * Сервер слушается на 0.0.0.0, поэтому доступен и из контейнера/песочницы
 * через проксируемый порт. Порт по умолчанию 5173, переопределение:
 * AGRO_PORT=5199 npm run dev
 *
 * Electron в dev-режиме подключается к этому серверу: адрес передаётся
 * через переменную окружения AGRO_DEV_SERVER (см. electron/main.cjs).
 */

import { createServer } from "vite";

const port = Number(process.env.AGRO_PORT ?? 5173);
const strictPort = process.env.AGRO_STRICT_PORT !== "0";

const server = await createServer({
  server: { port, strictPort },
});

await server.listen();
server.printUrls();
server.bindCLIShortcuts({ print: true });

// Держим процесс живым, пока работает сервер.
await new Promise((resolve) => {
  const done = () => resolve();
  process.on("SIGINT", done);
  process.on("SIGTERM", done);
  server.httpServer?.on("close", done);
});
