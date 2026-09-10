/** Кнопки, сегментированный переключатель, иконочные кнопки. */

import { h, icon, setTooltip } from "../lib/dom.js";

/**
 * @param {{label:string, tone?:'primary'|'secondary'|'ghost'|'danger'|'danger-soft',
 *          icon?:string, size?:'md'|'sm', loading?:boolean, disabled?:boolean,
 *          block?:boolean, title?:string, type?:'button'|'submit',
 *          onClick?:(event:MouseEvent, button:HTMLButtonElement)=>void}} options
 */
export function createButton(options = {}) {
  let {
    label = "",
    tone = "secondary",
    icon: iconName,
    size = "md",
    loading = false,
    disabled = false,
    block = false,
    title,
    type = "button",
    onClick,
    ariaLabel,
  } = options;

  const children = [];
  if (iconName) children.push(icon(iconName, { size: size === "sm" ? 14 : 16 }));
  if (label) children.push(h("span", { class: "btn__label", text: label }));

  const button = h("button", {
    type,
    class: [
      "btn",
      `btn--${tone}`,
      size === "sm" ? "btn--sm" : "",
      block ? "btn--block" : "",
      loading ? "btn--loading" : "",
    ]
      .filter(Boolean)
      .join(" "),
    disabled: disabled || loading,
  }, children);

  if (ariaLabel) button.setAttribute("aria-label", ariaLabel);
  if (title) button.setAttribute("title", title);

  if (loading) {
    button.setAttribute("aria-busy", "true");
    button.prepend(spinner(size === "sm" ? 14 : 16));
  }

  if (onClick) {
    button.addEventListener("click", async (event) => {
      if (button.disabled) {
        event.preventDefault();
        return;
      }
      await onClick(event, button);
    });
  }

  /** Переключает состояние выполнения операции без пересоздания кнопки. */
  button.setLoading = (isLoading, labelOverride) => {
    const existing = button.querySelector(".spinner");
    if (isLoading) {
      if (!existing) button.prepend(spinner(size === "sm" ? 14 : 16));
      button.classList.add("btn--loading");
      button.setAttribute("aria-busy", "true");
      button.disabled = true;
    } else {
      existing?.remove();
      button.classList.remove("btn--loading");
      button.removeAttribute("aria-busy");
      button.disabled = disabled;
    }
    const labelNode = button.querySelector(".btn__label");
    if (labelNode) labelNode.textContent = labelOverride ?? label;
  };

  button.setDisabled = (isDisabled) => {
    disabled = Boolean(isDisabled);
    button.disabled = disabled;
  };

  return button;
}

export function spinner(size = 16) {
  return h("span", { class: "spinner", style: `width:${size}px;height:${size}px`, "aria-hidden": "true" });
}

/** Иконочная кнопка: доступное имя обязательно — смысл не передаётся цветом. */
export function createIconButton({ icon: iconName, label, tone = "default", onClick, disabled = false, size = 16, tooltip = true }) {
  const button = h("button", {
    type: "button",
    class: ["btn-icon", tone === "danger" ? "btn-icon--danger" : ""].filter(Boolean).join(" "),
    disabled,
    "aria-label": label,
  }, [icon(iconName, { size })]);
  if (tooltip) setTooltip(button, label);
  if (onClick) button.addEventListener("click", onClick);
  return button;
}

/**
 * Сегментированный переключатель (период 1/3/6 месяцев, «Графики / Таблица», слои карты).
 * @param {{options:Array<{value:any,label:string,title?:string}>, value:any,
 *          onChange:(value:any)=>void, size?:'md'|'sm', label:string}} config
 */
export function createSegmented({ options, value, onChange, size = "md", label, disabled = false }) {
  const group = h("div", {
    class: ["segmented", size === "sm" ? "segmented--sm" : ""].filter(Boolean).join(" "),
    role: "group",
    "aria-label": label,
  });

  const buttons = new Map();

  for (const option of options) {
    const button = h("button", {
      type: "button",
      class: "segmented__btn",
      "aria-pressed": option.value === value ? "true" : "false",
      disabled,
      title: option.title ?? undefined,
    }, [option.iconName ? icon(option.iconName, { size: 14 }) : null, option.label ? h("span", { text: option.label }) : null]);
    button.dataset.value = String(option.value);
    button.addEventListener("click", () => {
      if (button.disabled) return;
      setValue(option.value);
      onChange?.(option.value);
    });
    buttons.set(option.value, button);
    group.append(button);
  }

  function setValue(next) {
    for (const [optionValue, button] of buttons) {
      button.setAttribute("aria-pressed", optionValue === next ? "true" : "false");
    }
  }

  group.setValue = setValue;
  group.setDisabled = (isDisabled) => {
    for (const button of buttons.values()) button.disabled = Boolean(isDisabled);
  };
  group.value = value;
  return group;
}
