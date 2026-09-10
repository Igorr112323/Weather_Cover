/**
 * Модальные окна: начальный фокус, удержание фокуса, Escape, возврат фокуса,
 * предупреждение о несохранённых изменениях. Стек общий с остальными слоями,
 * поэтому Escape сначала закрывает верхнее окно, а уже потом обрабатывается разделом.
 */

import { h, clear } from "../lib/dom.js";
import { initialFocus, pushEscHandler, trapFocus } from "../lib/overlays.js";
import { createButton, createIconButton } from "./button.js";

const stack = [];

export function modalDepth() {
  return stack.length;
}

export function hasOpenModal() {
  return stack.length > 0;
}

/**
 * @param {{title:string, body:Node|Array<Node>, actions?:Array<Node>, wide?:boolean,
 *          dismissible?:boolean, closeOnBackdrop?:boolean, dirty?:()=>boolean,
 *          onClose?:()=>void, initialFocusElement?:HTMLElement}} config
 */
export function openModal(config = {}) {
  const {
    title,
    body,
    actions = [],
    wide = false,
    dismissible = true,
    closeOnBackdrop = true,
    dirty = null,
    onClose,
    initialFocusElement,
  } = config;

  const previouslyFocused = document.activeElement;

  const titleId = `modal-title-${Math.random().toString(36).slice(2, 8)}`;
  const closeIcon = createIconButton({ icon: "x", label: "Закрыть", onClick: () => requestClose() });
  const head = h("div", { class: "modal__head" }, [
    h("h2", { class: "modal__title", id: titleId, text: title }),
    dismissible ? closeIcon : h("span"),
  ]);
  const bodyNode = h("div", { class: "modal__body" }, Array.isArray(body) ? body : [body]);
  const foot = actions.length > 0 ? h("div", { class: "modal__foot" }, actions) : null;

  const modal = h("div", {
    class: ["modal", wide ? "modal--wide" : ""].filter(Boolean).join(" "),
    role: "dialog",
    "aria-modal": "true",
    "aria-labelledby": titleId,
    tabindex: "-1",
  }, [head, bodyNode, foot].filter(Boolean));

  const overlay = h("div", { class: "overlay" }, [modal]);

  if (closeOnBackdrop) {
    overlay.addEventListener("mousedown", (event) => {
      if (event.target === overlay) requestClose();
    });
  }

  document.body.append(overlay);
  document.body.classList.add("has-modal");

  const releaseTrap = trapFocus(modal);
  const popEsc = pushEscHandler({
    node: overlay,
    onEscape: () => {
      if (!dismissible) return false;
      requestClose();
      return true;
    },
  });

  const entry = { overlay, modal, close };
  stack.push(entry);

  const focusTarget = initialFocusElement ?? initialFocus(modal);
  window.requestAnimationFrame(() => focusTarget?.focus?.());

  let closed = false;

  async function requestClose() {
    if (closed) return;
    if (typeof dirty === "function" && dirty()) {
      const keep = await confirmDialog({
        title: "Несохранённые изменения",
        message: "Изменения в форме не сохранены. Закрыть окно и потерять их?",
        confirmLabel: "Закрыть без сохранения",
        cancelLabel: "Вернуться к форме",
        tone: "danger",
      });
      if (!keep) {
        const firstField = modal.querySelector("input, select, textarea");
        firstField?.focus?.();
        return;
      }
    }
    close();
  }

  function close() {
    if (closed) return;
    closed = true;
    releaseTrap();
    popEsc();
    const index = stack.indexOf(entry);
    if (index >= 0) stack.splice(index, 1);
    overlay.remove();
    if (stack.length === 0) document.body.classList.remove("has-modal");
    if (previouslyFocused && previouslyFocused.isConnected && typeof previouslyFocused.focus === "function") {
      previouslyFocused.focus({ preventScroll: true });
    }
    onClose?.();
  }

  return {
    overlay,
    modal,
    body: bodyNode,
    close,
    requestClose,
    setBody(nodes) {
      clear(bodyNode);
      bodyNode.append(...(Array.isArray(nodes) ? nodes : [nodes]));
    },
    setTitle(text) {
      head.querySelector(".modal__title").textContent = text;
    },
    /** Перерисовка панели действий (например, кнопка «Сохранить» в состоянии загрузки). */
    setActions(nodes) {
      if (!foot) return;
      clear(foot);
      foot.append(...nodes);
    },
    actions: foot,
    focus() {
      focusTarget?.focus?.();
    },
  };
}

/**
 * Подтверждение. Возвращает true, только когда нажата подтверждающая кнопка.
 * Используется для любого удаления — даже локальное приложение не удаляет молча.
 */
export function confirmDialog({ title, message, confirmLabel = "Удалить", cancelLabel = "Отмена", tone = "danger", detail = null }) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    const nodes = [h("p", { class: "secondary", text: message, style: "white-space:pre-line; overflow-wrap:anywhere" })];
    if (detail) nodes.push(h("p", { class: "muted", text: detail }));

    const dialog = openModal({
      title,
      body: nodes,
      actions: [
        createButton({
          label: cancelLabel,
          tone: "secondary",
          onClick: () => {
            finish(false);
            dialog.close();
          },
        }),
        createButton({
          label: confirmLabel,
          tone: tone === "danger" ? "danger" : "primary",
          onClick: () => {
            finish(true);
            dialog.close();
          },
        }),
      ],
      onClose: () => finish(false),
      initialFocusElement: null,
    });

    // Фокус — на безопасном действии, а не на удалении.
    const cancel = dialog.modal.querySelector(".modal__foot .btn");
    window.requestAnimationFrame(() => cancel?.focus?.());
  });
}

/** Простое окно с одним действием. */
export function alertDialog({ title, message, confirmLabel = "Понятно", tone = "secondary" }) {
  return new Promise((resolve) => {
    const dialog = openModal({
      title,
      body: h("p", { class: "secondary", text: message }),
      actions: [
        createButton({
          label: confirmLabel,
          tone: tone === "primary" ? "primary" : "secondary",
          onClick: () => {
            dialog.close();
            resolve(true);
          },
        }),
      ],
      onClose: () => resolve(false),
    });
    const button = dialog.modal.querySelector(".modal__foot .btn");
    window.requestAnimationFrame(() => button?.focus?.());
  });
}
