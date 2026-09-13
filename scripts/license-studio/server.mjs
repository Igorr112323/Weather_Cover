/**
 * Локальный сервер «Студии лицензий».
 *
 * Студия — это маленький сайт, который работает только на машине владельца:
 *   • слушает только 127.0.0.1 — снаружи не достучаться;
 * • требует секретный токен запуска (x-agro-studio) — посторонняя страница
 *   в браузере не сможет управлять выдачей кодов через запросы с localhost;
 *   • закрытый ключ НЕ отправляется в браузер: форма получает только
 *     результат — код, сообщение, журнал.
 *
 * Отправка наружу возможна только одним местом — необязательным модулем
 * доставки (delivery.mjs), и только когда владелец сам нажимает «Отправить».
 */

import { readFile } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const UI_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), "ui.html");
const LOOPBACK_ADDRESSES = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);
const MAX_BODY_BYTES = 64 * 1024;

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(payload);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.byteLength;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("Слишком большой запрос"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new Error("Запрос не является JSON"));
      }
    });
    req.on("error", reject);
  });
}

/**
 * @param {{backend:object, token:string, host?:string, port?:number}} options
 * @returns {Promise<{server:object, url:string, port:number, close:()=>Promise<void>}>}
 */
export function startStudioServer({ backend, token, host = "127.0.0.1", port = 0 }) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      try {
        // Только локальные соединения: сервер студии не должен быть виден из сети.
        if (!LOOPBACK_ADDRESSES.has(req.socket.remoteAddress ?? "")) {
          json(res, 403, { ok: false, message: "Студия доступна только на этом компьютере" });
          return;
        }
        const hostHeader = String(req.headers.host ?? "");
        if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(hostHeader)) {
          json(res, 403, { ok: false, message: "Студия доступна только с 127.0.0.1" });
          return;
        }
        // Посторонняя страница в браузере не должна управлять выдачей кодов.
        const origin = req.headers.origin;
        if (origin && !/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin)) {
          json(res, 403, { ok: false, message: "Запрос с постороннего источника отклонён" });
          return;
        }

        const url = new URL(req.url ?? "/", `http://${hostHeader || "127.0.0.1"}`);

        if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
          const html = await readFile(UI_FILE, "utf8");
          res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
          res.end(html);
          return;
        }

        if (String(req.headers["x-agro-studio"] ?? "") !== token) {
          json(res, 403, { ok: false, message: "Запустите студию командой npm run license:studio и откройте ссылку из консоли" });
          return;
        }

        if (req.method === "GET" && url.pathname === "/api/state") {
          json(res, 200, await backend.state());
          return;
        }
        if (req.method === "POST" && url.pathname === "/api/issue") {
          json(res, 200, await backend.issue(await readBody(req)));
          return;
        }
        if (req.method === "POST" && url.pathname === "/api/revoke") {
          json(res, 200, await backend.revoke((await readBody(req)).serial));
          return;
        }
        if (req.method === "POST" && url.pathname === "/api/send") {
          json(res, 200, await backend.send(await readBody(req)));
          return;
        }
        json(res, 404, { ok: false, message: "Нет такой страницы" });
      } catch (error) {
        const body = { ok: false, message: String(error?.message ?? error) };
        if (error?.extra && typeof error.extra === "object") Object.assign(body, error.extra);
        json(res, error?.name === "StudioError" ? 200 : 500, body);
      }
    });

    server.on("error", reject);
    server.listen(port, host, () => {
      const address = server.address();
      resolve({
        server,
        host,
        port: address.port,
        url: `http://${host}:${address.port}/?token=${token}`,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}
