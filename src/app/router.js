/**
 * Внутренний роутер по hash-адресу.
 *
 * Страницы кэшируются (keepAlive), поэтому состояние карты, фильтров и
 * прокрутки не теряется при переключении вкладок. Создание страницы
 * асинхронное: устаревший результат не смонтируется (защита от гонки при
 * быстром переключении вкладок).
 */

import { createStaleGuard } from "../lib/async.js";

function parseQuery(search) {
  const query = {};
  if (!search) return query;
  for (const pair of search.replace(/^\?/, "").split("&")) {
    if (!pair) continue;
    const [key, value = ""] = pair.split("=");
    query[decodeURIComponent(key)] = decodeURIComponent(value.replace(/\+/g, " "));
  }
  return query;
}

function matchRoute(routes, path) {
  const [pathname, search] = path.split("?");
  const segments = pathname.split("/").filter(Boolean);
  for (const route of routes) {
    const parts = route.path.split("/").filter(Boolean);
    if (parts.length !== segments.length) continue;
    const params = {};
    let matched = true;
    for (let i = 0; i < parts.length; i += 1) {
      const part = parts[i];
      if (part.startsWith(":")) {
        const value = decodeURIComponent(segments[i]);
        // Идентификаторы — только UUID-безопасные символы: чужой текст в адрес не пролезет
        if (!/^[A-Za-z0-9_-]{1,64}$/.test(value)) {
          matched = false;
          break;
        }
        params[part.slice(1)] = value;
      } else if (part !== segments[i]) {
        matched = false;
        break;
      }
    }
    if (matched) return { route, params, query: parseQuery(search) };
  }
  return null;
}

/**
 * @param {{mount:HTMLElement, routes:Array, context:object, onNavigate?:(info:object)=>void}} options
 */
export function createRouter({ mount, routes, context, onNavigate }) {
  const instances = new Map();
  const guard = createStaleGuard();
  let current = null;
  let starting = false;
  let restoring = false;

  function currentHash() {
    return window.location.hash.replace(/^#/, "") || "/map";
  }

  function setActiveNav(route) {
    const nav = route?.nav ?? route?.name ?? null;
    for (const link of document.querySelectorAll(".nav-item")) {
      const isActive = link.dataset.nav === nav;
      if (isActive) link.setAttribute("aria-current", "page");
      else link.removeAttribute("aria-current");
    }
  }

  async function show(path, { force = false } = {}) {
    const match = matchRoute(routes, path);
    if (!match) {
      navigate("/map");
      return;
    }
    const { route, params, query } = match;

    if (!force && current && current.key === `${route.name}|${JSON.stringify(params)}`) {
      current.query = query;
      current.page?.setQuery?.(query);
      return;
    }

    // Страница может попросить не уходить (незакрытая форма и т. п.)
    if (current?.page?.canLeave) {
      const allowed = await current.page.canLeave();
      if (!allowed) {
        restoring = true;
        window.location.hash = `#${current.path}`;
        window.setTimeout(() => {
          restoring = false;
        }, 0);
        return;
      }
    }

    const token = guard.next();
    current?.page?.hide?.();
    if (current?.node?.isConnected) current.node.remove();

    let instance = instances.get(route.name);
    if (!instance || route.recreate) {
      instance = await route.create(context, { params, query });
      if (!token.isCurrent()) {
        instance?.destroy?.();
        return;
      }
      if (route.keepAlive !== false) instances.set(route.name, instance);
    }

    if (!instance?.node) {
      console.error(`Страница ${route.name} не вернула узел`);
      return;
    }

    mount.replaceChildren(instance.node);
    mount.classList.toggle("main--flush", Boolean(route.flush));

    current = { route, name: route.name, key: `${route.name}|${JSON.stringify(params)}`, path, params, query, page: instance, node: instance.node };

    document.title = route.title ? `${route.title} — АгроПрогноз` : "АгроПрогноз";
    setActiveNav(route);
    context.state.set({ route: { name: route.name, nav: route.nav ?? route.name, params, query } });

    try {
      await instance.show?.({ ...context, params, query, route });
    } catch (error) {
      console.error("Ошибка при открытии страницы", error);
      instance?.setError?.(error);
    }
    if (!token.isCurrent()) return;

    onNavigate?.({ route, params, query });
  }

  function navigate(path) {
    const next = `#${path}`;
    if (window.location.hash === next) {
      show(path, { force: true });
      return;
    }
    window.location.hash = next;
  }

  function onHashChange() {
    if (restoring) return;
    show(currentHash());
  }

  return {
    async start() {
      if (starting) return;
      starting = true;
      window.addEventListener("hashchange", onHashChange);
      const path = currentHash();
      if (!window.location.hash) window.location.hash = `#${path}`;
      await show(path, { force: true });
    },
    navigate,
    refresh: () => show(currentHash(), { force: true }),
    get current() {
      return current;
    },
    /** Освобождает ресурсы страниц (используется при перезапуске и в тестах). */
    dispose() {
      window.removeEventListener("hashchange", onHashChange);
      for (const instance of instances.values()) instance?.destroy?.();
      instances.clear();
      current = null;
    },
  };
}
