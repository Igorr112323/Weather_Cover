/**
 * Оболочка приложения: левая навигация (216 px / 72 px) и рабочая область.
 * Здесь нет профиля, авторизации, подписок, облака и неработающих настроек —
 * только рабочие разделы.
 */

import { h, icon, setTooltip } from "../lib/dom.js";
import { state } from "./state.js";
import iconUrl from "../assets/brand/app-icon.svg?url";

const NAV_ITEMS = Object.freeze([
  { nav: "map", path: "/map", label: "Карта", icon: "map" },
  { nav: "datasets", path: "/datasets", label: "Данные", icon: "database" },
  { nav: "reports", path: "/reports", label: "Отчёты", icon: "file-text" },
  { nav: "varieties", path: "/varieties", label: "Сорта кукурузы", icon: "sprout" },
]);

/**
 * Сведения о лицензии внизу боковой панели.
 *
 * Показываются только факты: лицензия бессрочная, серийный номер — в подписи
 * при наведении. Дат и «осталось дней» здесь нет и не будет: срок действия
 * лицензии не ограничен, считать нечего. В режиме разработки (dev-сервер Vite)
 * блок честно говорит, что это не активированное приложение.
 */
function createLicenseFoot() {
  const value = h("span", { class: "sidebar__license-value", text: "" });
  const node = h("div", { class: "sidebar__license", hidden: true }, [
    icon("check", { size: 14 }),
    h("div", { class: "sidebar__license-text" }, [
      h("span", { class: "sidebar__license-label", text: "Лицензия" }),
      value,
    ]),
  ]);

  function paint(snapshot) {
    const license = snapshot?.license ?? null;
    if (!license) {
      node.hidden = true;
      return;
    }
    node.hidden = false;
    if (license.dev) {
      value.textContent = "Режим разработки";
      node.removeAttribute("title");
      return;
    }
    if (license.activated) {
      value.textContent = "Бессрочная";
      const serial = license.serial ? `Серийный номер ${license.serial}` : "";
      const scope = license.bound ? " · привязана к этому компьютеру" : " · компьютер не привязан";
      setTooltip(node, [serial, "Срок действия не ограничен", scope].filter(Boolean).join("\n").trim());
      return;
    }
    value.textContent = "Не активирована";
    node.removeAttribute("title");
  }

  return {
    node,
    subscribe(store) {
      paint(store.state);
      return store.subscribe(paint);
    },
  };
}

export function createShell({ navigate, onReady }) {
  const navButtons = new Map();

  const nav = h("nav", { class: "sidebar__nav", "aria-label": "Разделы приложения" });
  for (const item of NAV_ITEMS) {
    const button = h(
      "button",
      {
        type: "button",
        class: "nav-item",
        dataset: { nav: item.nav, path: item.path },
      },
      [icon(item.icon, { size: 18 }), h("span", { class: "nav-item__label", text: item.label })],
    );
    button.addEventListener("click", () => navigate(item.path));
    navButtons.set(item.nav, button);
    nav.append(button);
  }

  const licenseFoot = createLicenseFoot();

  const sidebar = h("aside", { class: "sidebar" }, [
    h("div", { class: "sidebar__brand" }, [
      h("img", { class: "sidebar__logo", src: iconUrl, alt: "", width: "36", height: "36" }),
      h("div", { class: "sidebar__names" }, [
        h("span", { class: "sidebar__name", text: "АгроПрогноз" }),
        h("span", { class: "sidebar__sub", text: "Кукуруза" }),
      ]),
    ]),
    nav,
    licenseFoot.node,
  ]);

  const main = h("main", { class: "main", id: "main", tabindex: "-1" });
  // Полоса захвата окна под скрытой системной строкой заголовка (Electron);
  // в браузере её высота равна нулю.
  const windowDrag = h("div", { class: "window-drag", "aria-hidden": "true" });
  const shell = h("div", { class: "shell" }, [windowDrag, sidebar, main]);

  const media = window.matchMedia("(max-width: 1179px)");
  const applyNarrow = (isNarrow) => {
    shell.classList.toggle("shell--narrow", isNarrow);
    state.set({ narrow: isNarrow });
    for (const item of NAV_ITEMS) {
      const button = navButtons.get(item.nav);
      if (!button) continue;
      if (isNarrow) {
        button.dataset.tip = item.label;
        button.setAttribute("title", item.label);
      } else {
        delete button.dataset.tip;
        button.removeAttribute("title");
      }
    }
  };
  const onMediaChange = (event) => applyNarrow(event.matches);
  applyNarrow(media.matches);
  if (media.addEventListener) media.addEventListener("change", onMediaChange);
  else media.addListener(onMediaChange);

  const paint = (snapshot) => {
    const active = snapshot.route?.nav ?? null;
    for (const [key, button] of navButtons) {
      if (key === active) button.setAttribute("aria-current", "page");
      else button.removeAttribute("aria-current");
    }
  };
  const unsubscribe = state.subscribe(paint);
  paint(state.state);

  const unsubscribeLicense = licenseFoot.subscribe(state);

  onReady?.();

  return {
    node: shell,
    main,
    destroy() {
      unsubscribe();
      unsubscribeLicense();
      if (media.removeEventListener) media.removeEventListener("change", onMediaChange);
      else media.removeListener?.(onMediaChange);
    },
  };
}
