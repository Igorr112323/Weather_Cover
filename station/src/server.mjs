/**
 * Локальный HTTP-сервер станции «Активация ключей».
 *
 * Правила, без которых станция не была бы безопасной:
 *   • слушает только 127.0.0.1 (режим --lan включает 0.0.0.1 для выдачи ссылки
 *     другому компьютеру в доверенной сети — но и там всё через токен запуска);
 *   • закрытый ключ в браузер НЕ отдаётся: в ответ уходит только готовый код,
 *     сообщение покупателю, файл .agrolic и журнал;
 *   • каждый запрос требует токен запуска (заголовок x-agro-token или ?token=) —
 *     посторонняя страница в браузере не сможет подписывать коды через localhost;
 *   • скачивание возможно только для имён вида AgroPrognoz*.exe и только из
 *     каталога проверочных копий или каталогов-источников (путь собирается не из
 *     userInput, а по белому списку).
 */
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "public");
/** Имя автономной страницы (один файл, двойной щелчок) — см. scripts/build-standalone.mjs. */
const OFFLINE_PAGE_PATH = "/aktivaciya-klyuchey.html";
const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);
const MAX_BODY_BYTES = 512 * 1024;
const TOKEN_HEADER = "x-agro-token";

const MIME = new Map([
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".svg", "image/svg+xml"],
  [".png", "image/png"],
  [".ico", "image/x-icon"],
]);

function send(res, status, body, headers = {}) {
  const payload = typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": typeof body === "string" && body.trimStart().startsWith("<") ? "text/html; charset=utf-8" : "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    ...headers,
  });
  res.end(payload);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
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
      const text = Buffer.concat(chunks).toString("utf8");
      try {
        resolve(JSON.parse(text));
      } catch {
        reject(new Error("Запрос не является JSON"));
      }
    });
    req.on("error", reject);
  });
}

async function sendFile(res, file, { download } = {}) {
  const info = await fs.promises.stat(file).catch(() => null);
  if (!info?.isFile()) {
    send(res, 404, { ok: false, message: "Файл не найден" });
    return;
  }
  const headers = {
    "Content-Length": String(info.size),
    "Content-Type": MIME.get(path.extname(file).toLowerCase()) ?? "application/octet-stream",
    "Cache-Control": "no-store",
  };
  if (download) {
    headers["Content-Disposition"] = `attachment; filename="${path.basename(file)}"; filename*=UTF-8''${encodeURIComponent(path.basename(file))}`;
  }
  res.writeHead(200, headers);
  fs.createReadStream(file).pipe(res);
}

/**
 * @param {{backend:object, token:string, host?:string, port?:number, allowedHosts?:string[]}} options
 * @returns {Promise<{server:object, url:string, port:number, host:string, close:()=>Promise<void>}>}
 */
export function startStationServer({ backend, token, host = "127.0.0.1", port = 0, allowedHosts = [] }) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      let url;
      try {
        const hostHeader = String(req.headers.host ?? "");
        url = new URL(req.url ?? "/", `http://${hostHeader || "127.0.0.1"}`);

        // Снаружи станцию не видно: режим по умолчанию принимает только
        // локальные соединения (0.0.0.0 включается сознательно — --lan).
        const lanMode = host === "0.0.0.0";
        const remote = req.socket.remoteAddress ?? "";
        if (!lanMode && !LOOPBACK.has(remote)) {
          send(res, 403, { ok: false, message: "Станция доступна только на этом компьютере" });
          return;
        }
        // Host проверяется всегда, кроме сознательного --lan без белого списка:
        // иначе DNS-привязка (rebinding) превратила бы локальную станцию в
        // «открытую для чужого домена». Белый список (--allow-host) сужает
        // разрешение до конкретных имён, а не снимает проверку.
        const hostAllowed =
          /^(127\.0\.0\.1|localhost|\d{1,3}(\.\d{1,3}){3})(:\d+)?$/.test(hostHeader) ||
          allowedHosts.some((suffix) => hostHeader === suffix || hostHeader.endsWith(suffix)) ||
          (lanMode && allowedHosts.length === 0);
        if (!hostAllowed) {
          send(res, 403, { ok: false, message: "Запрос по недоверенному имени хоста отклонён" });
          return;
        }
        const origin = req.headers.origin;
        if (origin && !/^https?:\/\/[\w.-]+(:\d+)?$/.test(origin)) {
          send(res, 403, { ok: false, message: "Запрос с постороннего источника отклонён" });
          return;
        }

        const tokenGiven = String(req.headers[TOKEN_HEADER] ?? url.searchParams.get("token") ?? "");
        const authorized = tokenGiven.length > 0 && timingSafeEqual(tokenGiven, token);

        if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
          const html = (await fs.promises.readFile(path.join(PUBLIC_DIR, "index.html"), "utf8")).replace(
            "</head>",
            `  <script>window.AGRO_STATION=${JSON.stringify({ token, api: "" })};</script>\n</head>`,
          );
          res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
          res.end(html);
          return;
        }
        // Статика интерфейса. Офлайн-копия страницы раздаётся без токена: она
        // сама по себе ни к чему не обращается и не содержит секретов — это тот же
        // файл, что лежит в standalone/ и открывается двойным щелчком.
        const PUBLIC_STATIC = new Set(["/app.js", "/styles.css", OFFLINE_PAGE_PATH]);
        if (req.method === "GET" && PUBLIC_STATIC.has(url.pathname)) {
          await sendFile(res, path.join(PUBLIC_DIR, url.pathname.slice(1)));
          return;
        }

        if (!authorized) {
          send(res, 403, { ok: false, message: "Нужен токен запуска. Откройте ссылку из консоли: там она уже с ?token=…" });
          return;
        }

        if (req.method === "GET" && url.pathname === "/api/state") return send(res, 200, await backend.state());
        if (req.method === "GET" && url.pathname === "/api/activation") return send(res, 200, await backend.activation());
        if (req.method === "GET" && url.pathname === "/api/ledger") return send(res, 200, await backend.ledger());
        if (req.method === "POST" && url.pathname === "/api/issue") return send(res, 200, await backend.issue(await readBody(req)));
        if (req.method === "POST" && url.pathname === "/api/verify") return send(res, 200, await backend.verify(await readBody(req)));
        if (req.method === "POST" && url.pathname === "/api/revoke") return send(res, 200, await backend.revoke(await readBody(req)));
        if (req.method === "POST" && url.pathname === "/api/exe") return send(res, 200, await backend.buildCheckExe(await readBody(req)));
        if (req.method === "POST" && url.pathname === "/api/reset") return send(res, 200, await backend.reset(await readBody(req)));
        if (req.method === "GET" && url.pathname === "/api/ledger.csv") {
          const { csv } = await backend.ledger();
          res.writeHead(200, {
            "Content-Type": "text/csv; charset=utf-8",
            "Content-Disposition": `attachment; filename="agro-activation-ledger.csv"`,
            "Cache-Control": "no-store",
          });
          res.end(`\uFEFF${csv}`);
          return;
        }
        if (req.method === "GET" && url.pathname.startsWith("/download/")) {
          const name = decodeURIComponent(url.pathname.slice("/download/".length));
          const file = await backend.resolveDownload(name);
          if (!file) {
            send(res, 404, { ok: false, message: "Такого файла станция не отдаёт" });
            return;
          }
          await sendFile(res, file, { download: true });
          return;
        }
        send(res, 404, { ok: false, message: "Нет такого запроса" });
      } catch (error) {
        const body = { ok: false, message: String(error?.message ?? error) };
        if (error && typeof error === "object" && error.extra && typeof error.extra === "object") Object.assign(body, error.extra);
        send(res, error?.name === "StationError" ? 200 : 500, body);
      }
    });

    server.on("error", reject);
    server.listen(port, host, () => {
      const address = server.address();
      const shown = host === "0.0.0.0" ? "127.0.0.1" : host;
      resolve({
        server,
        host,
        port: address.port,
        url: `http://${shown}:${address.port}/?token=${token}`,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

/** Сравнение токена в постоянное время: тайминг-атака на localhost тоже считается. */
function timingSafeEqual(left, right) {
  const a = Buffer.from(String(left), "utf8");
  const b = Buffer.from(String(right), "utf8");
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}
