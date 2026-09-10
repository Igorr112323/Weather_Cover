/**
 * Точка входа renderer-процесса.
 *
 * Порядок запуска: носитель данных → SQLite (sql.js) → миграции → оболочка и
 * первый раздел. Если база не открылась, приложение не «чинит» её молча:
 * исходный файл сохраняется, а вместо интерфейса показывается понятная ошибка.
 */

import "@fontsource/inter/latin-400.css";
import "@fontsource/inter/latin-500.css";
import "@fontsource/inter/latin-600.css";
import "@fontsource/inter/cyrillic-400.css";
import "@fontsource/inter/cyrillic-500.css";
import "@fontsource/inter/cyrillic-600.css";

import "./styles/tokens.css";
import "./styles/base.css";
import "./styles/layout.css";
import "./styles/components.css";

import { h } from "./lib/dom.js";
import { state, MAP_DEFAULTS, resetForecast } from "./app/state.js";
import { createShell } from "./app/shell.js";
import { createRouter } from "./app/router.js";
import { createPersistence } from "./services/persistence.js";
import { loadSql } from "./services/sql-driver.js";
import { DatabaseService, openDatabase } from "./services/database.js";
import { getSetting, listVarieties } from "./services/repositories.js";
import { toast } from "./components/toast.js";
import { createButton } from "./components/button.js";
import { createMapPage } from "./pages/map/index.js";
import { createResultsPage } from "./pages/results/index.js";
import { createDatasetsPage } from "./pages/datasets/index.js";
import { createReportsPage } from "./pages/reports/index.js";
import { createVarietiesPage } from "./pages/varieties/index.js";

const root = document.getElementById("app");

function renderBoot(message, { tone = "info" } = {}) {
  root.replaceChildren(
    h("div", { class: "boot" }, [
      h("div", { class: "boot__inner" }, [
        tone === "error"
          ? h("span", { class: "empty__icon", style: "background:var(--danger-bg);color:var(--danger)" }, [h("span", { text: "!" })])
          : h("div", { class: "progress-line", style: "width:180px", "aria-hidden": "true" }),
        h("p", { class: "block-title", text: message }),
      ]),
    ]),
  );
}

function renderFatal({ title, text, actions }) {
  root.replaceChildren(
    h("div", { class: "boot" }, [
      h("div", { class: "boot__inner" }, [
        h("h1", { class: "page-title", text: title }),
        h("p", { class: "secondary", text, style: "white-space:pre-line" }),
        h("div", { style: "display:flex;gap:8px;flex-wrap:wrap;justify-content:center" }, actions),
      ]),
    ]),
  );
}

function reload() {
  window.location.reload();
}

function refreshVarieties(db) {
  if (!db) return [];
  try {
    const varieties = listVarieties(db.handle, { query: "", type: "all", sort: { key: "name", dir: "asc" } });
    state.set({ varieties });
    return varieties;
  } catch (error) {
    console.error("Не удалось загрузить справочник сортов", error);
    state.set({ varieties: [], varietiesStatus: "error" });
    return [];
  }
}

async function main() {
  renderBoot("Загрузка приложения");

  let db = null;
  try {
    const persistence = await createPersistence();
    state.set({ storageLabel: persistence.label });

    const SQL = await loadSql();

    let bytes = null;
    try {
      bytes = await persistence.read();
    } catch (error) {
      console.error("Носитель недоступен", error);
      renderFatal({
        title: "Не удалось открыть данные",
        text:
          persistence.kind === "electron"
            ? "Файл базы данных в каталоге приложения не читается. Проверьте доступ к каталогу профиля и повторите запуск."
            : "Хранилище браузера недоступно. Проверьте, что для страницы разрешено хранение данных, и повторите запуск.",
        actions: [createButton({ label: "Повторить", tone: "primary", icon: "rotate-ccw", onClick: () => reload() })],
      });
      return;
    }

    try {
      const opened = openDatabase({ SQL, bytes, persistence });
      db = new DatabaseService({ handle: opened.handle, persistence });
      if (opened.needsPersist) await db.persist();
    } catch (error) {
      console.error("База не открыта", error);
      const damaged = error?.code === "DB_UNREADABLE";
      let preservedName = null;
      if (damaged) {
        try {
          preservedName = await persistence.preserve("unreadable");
        } catch (preserveError) {
          console.error("Не удалось сохранить копию", preserveError);
        }
      }

      const actions = [createButton({ label: "Повторить", tone: "primary", icon: "rotate-ccw", onClick: () => reload() })];
      if (damaged) {
        actions.push(
          createButton({
            label: "Начать с чистой базы",
            tone: "secondary",
            onClick: () => startFresh({ SQL, persistence, preservedName }),
          }),
        );
      }

      renderFatal({
        title: damaged ? "Файл базы данных повреждён" : "Не удалось подготовить базу данных",
        text: [
          damaged ? "Исходный файл сохранён без изменений и приложение его не перезаписывало." : (error?.message ?? "Неизвестная ошибка"),
          preservedName ? `Копия: ${preservedName}` : "",
          "Автоматический сброс отключён: сохранность данных важнее удобства.",
        ]
          .filter(Boolean)
          .join("\n"),
        actions,
      });
      return;
    }

    await startApp(db);
  } catch (error) {
    console.error("Запуск не удался", error);
    renderFatal({
      title: "Приложение не запустилось",
      text: error?.message ?? "Неизвестная ошибка",
      actions: [createButton({ label: "Повторить", tone: "primary", icon: "rotate-ccw", onClick: () => reload() })],
    });
  }

  async function startFresh({ SQL, persistence, preservedName }) {
    renderBoot(preservedName ? "Создаём новую базу" : "Создаём новую базу");
    try {
      const opened = openDatabase({ SQL, bytes: null, persistence });
      const fresh = new DatabaseService({ handle: opened.handle, persistence });
      await fresh.persist();
      await startApp(fresh);
      toast.info("Создана новая база данных");
    } catch (error) {
      console.error("Новая база не создана", error);
      renderFatal({
        title: "Не удалось создать базу данных",
        text: error?.message ?? "Неизвестная ошибка",
        actions: [createButton({ label: "Повторить", tone: "primary", onClick: () => reload() })],
      });
    }
  }
}

async function startApp(db) {
  const appVersion = await resolveVersion();
  state.set({ appVersion, boot: "ready", bootError: null });

  try {
    const savedMap = getSetting(db.handle, "mapState", null);
    state.set({ map: { ...MAP_DEFAULTS, ...(savedMap && typeof savedMap === "object" ? savedMap : {}) } });
  } catch (error) {
    console.error("Состояние карты не восстановлено", error);
    state.set({ map: { ...MAP_DEFAULTS } });
  }

  refreshVarieties(db);

  /** Назначается ниже; ссылки на роутер живут в замыканиях. */
  const routerRef = { current: null };
  const navigate = (path) => routerRef.current?.navigate(path);

  const context = {
    state,
    db,
    navigate,
    refreshVarieties: () => refreshVarieties(db),
    resetForecast: () => resetForecast(),
  };

  const routes = [
    { path: "/map", name: "map", nav: "map", title: "Карта", flush: true, create: (ctx) => createMapPage(ctx) },
    { path: "/results", name: "results", nav: "map", title: "Результаты прогноза", create: (ctx) => createResultsPage(ctx) },
    { path: "/report/:id", name: "results", nav: "reports", title: "Отчёт из архива", create: (ctx) => createResultsPage(ctx) },
    { path: "/datasets", name: "datasets", nav: "datasets", title: "Данные", create: (ctx) => createDatasetsPage(ctx) },
    { path: "/datasets/:id", name: "datasets", nav: "datasets", title: "Набор данных", create: (ctx) => createDatasetsPage(ctx) },
    { path: "/reports", name: "reports", nav: "reports", title: "Отчёты", create: (ctx) => createReportsPage(ctx) },
    { path: "/varieties", name: "varieties", nav: "varieties", title: "Сорта кукурузы", create: (ctx) => createVarietiesPage(ctx) },
  ];

  const shell = createShell({
    navigate,
    onReady: null,
  });
  root.replaceChildren(shell.node);

  routerRef.current = createRouter({ mount: shell.main, routes, context });
  await routerRef.current.start();

  installGlobalGuards(db);
  window.addEventListener("pagehide", () => {
    void db.persist();
  });
}

async function resolveVersion() {
  const fallback = state.state.appVersion ?? "0.0.0";
  if (!window.agro?.getAppInfo) return fallback;
  try {
    const info = await window.agro.getAppInfo();
    const version = info?.ok === false ? null : info?.version;
    return typeof version === "string" && version.length > 0 ? version : fallback;
  } catch (error) {
    console.error("Версия приложения не получена", error);
    return fallback;
  }
}

/** Перед закрытием окна в Electron отдаём накопленные записи на диск. */
function installGlobalGuards(db) {
  if (window.agro?.onFlushRequest) {
    window.agro.onFlushRequest(async () => {
      try {
        await db.persist();
      } finally {
        window.agro.notifyFlushed?.();
      }
    });
  }

  window.addEventListener("unhandledrejection", (event) => {
    console.error("Необработанное отклонение промиса", event.reason);
    toast.error("Приложение не смогло завершить операцию");
  });

  window.addEventListener("error", (event) => {
    if (event.message && /ResizeObserver loop/i.test(event.message)) return; // безвредное сообщение Chromium
    console.error("Необработанная ошибка", event.error ?? event.message);
  });
}

void main();
