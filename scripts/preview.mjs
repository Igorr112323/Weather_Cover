/**
 * Предпросмотр production-сборки (после `npm run build`).
 *
 *   npm run preview
 *
 * Раздаёт каталог dist/ через vite preview на 0.0.0.0.
 * Порт по умолчанию 4173, переопределение: AGRO_PREVIEW_PORT=4199 npm run preview
 */

import { preview } from "vite";

const port = Number(process.env.AGRO_PREVIEW_PORT ?? 4173);

const server = await preview({
  preview: { port, strictPort: true },
});

server.printUrls();

await new Promise((resolve) => {
  const done = () => resolve();
  process.on("SIGINT", done);
  process.on("SIGTERM", done);
  server.httpServer?.on("close", done);
});
