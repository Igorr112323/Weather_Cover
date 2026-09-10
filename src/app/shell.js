/**
 * Оболочка приложения: левая навигация (216 px / 72 px) и рабочая область.
 * Здесь нет профиля, авторизации, подписок, облака и неработающих настроек —
 * только рабочие разделы.
 */

import { h, icon, setText } from "../lib/dom.js";
import { state } from "./state.js";
import iconUrl from "../assets/brand/app-icon.svg?url";

const NAV_ITEMS = Object.freeze([
  { nav: "map", path: "/map", label: "Карта", icon: "map" },
  { nav: "datasets", path: "/datasets", label: "Данные", icon: "database" },
  { nav: "reports", path: "/reports", label: "Отчёты", icon: "file-text" },
  { nav: "varieties", path: "/varieties", label: "Сорта кукурузы", icon: "sprout" },
]);

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

  const versionNode = h("span", { class: "sidebar__version" });
  const storageNode = h("span", { class: "sidebar__mode" });

  const sidebar = h("aside", { class: "sidebar" }, [
    h("div", { class: "sidebar__brand" }, [
      h("img", { class: "sidebar__logo", src: iconUrl, alt: "", width: "36", height: "36" }),
      h("div", { class: "sidebar__names" }, [
        h("span", { class: "sidebar__name", text: "АгроПрогноз" }),
        h("span", { class: "sidebar__sub", text: "Кукуруза" }),
      ]),
    ]),
    nav,
    h("div", { class: "sidebar__foot" }, [versionNode, storageNode]),
  ]);

  const main = h("main", { class: "main", id: "main", tabindex: "-1" });
  const shell = h("div", { class: "shell" }, [sidebar, main]);

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
    setText(versionNode, `Версия ${snapshot.appVersion ?? "0.0.0"}`);
    setText(storageNode, snapshot.storageLabel ?? "");
    const active = snapshot.route?.nav ?? null;
    for (const [key, button] of navButtons) {
      if (key === active) button.setAttribute("aria-current", "page");
      else button.removeAttribute("aria-current");
    }
  };
  const unsubscribe = state.subscribe(paint);
  paint(state.state);

  onReady?.();

  return {
    node: shell,
    main,
    destroy() {
      unsubscribe();
      if (media.removeEventListener) media.removeEventListener("change", onMediaChange);
      else media.removeListener?.(onMediaChange);
    },
  };
}
