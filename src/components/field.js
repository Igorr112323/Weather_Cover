/** Поля формы в общей дизайн-системе: подпись, контрол, подсказка, ошибка. */

import { h, icon, setText } from "../lib/dom.js";
import { VARIETY_TYPES } from "../services/validation.js";

let seq = 0;
function nextId(prefix) {
  seq += 1;
  return `${prefix}-${seq}`;
}

function wrap({ id, label, hint, required, control, className = "" }) {
  const hintId = hint ? `${id}-hint` : null;
  const errorId = `${id}-error`;
  const errorNode = h("p", { class: "field__error", id: errorId, hidden: true });
  const hintNode = hint
    ? h("p", { class: "field__hint", id: hintId, text: hint })
    : null;

  const labelNode = h("label", { class: "field__label", for: id }, [
    h("span", { text: label }),
    required ? h("span", { class: "field__req", text: " *", "aria-hidden": "true" }) : null,
  ]);

  const field = h("div", { class: `field ${className}`.trim() }, [labelNode, control, hintNode, errorNode].filter(Boolean));

  if (hintId) control.setAttribute("aria-describedby", hintId);

  field.setError = (message) => {
    if (message) {
      setText(errorNode, message);
      errorNode.hidden = false;
      control.classList.add("control--error");
      control.setAttribute("aria-invalid", "true");
      const described = new Set([errorId, hintId].filter(Boolean));
      control.setAttribute("aria-describedby", [...described].join(" "));
    } else {
      clearError();
    }
  };

  function clearError() {
    errorNode.hidden = true;
    setText(errorNode, "");
    control.classList.remove("control--error");
    control.removeAttribute("aria-invalid");
    if (hintId) control.setAttribute("aria-describedby", hintId);
    else control.removeAttribute("aria-describedby");
  }

  field.clearError = clearError;
  return field;
}

function baseControl(tag, id, props) {
  return h(tag, { id, ...props });
}

/**
 * Текстовое поле.
 * @param {{label:string, value?:string, placeholder?:string, hint?:string,
 *          required?:boolean, maxlength?:number, autocomplete?:string}} config
 */
export function createTextField(config = {}) {
  const { label, value = "", placeholder = "", hint, required = false, maxlength, name } = config;
  const id = nextId("field");
  const input = baseControl("input", id, {
    type: "text",
    value: value ?? "",
    placeholder,
    maxlength: maxlength ?? 200,
    autocomplete: config.autocomplete ?? "off",
    name,
    "aria-required": required ? "true" : null,
  });
  const control = h("div", { class: "control" }, [input]);
  const field = wrap({ id, label, hint, required, control });
  field.input = input;
  field.getValue = () => input.value;
  field.setValue = (next) => {
    input.value = next ?? "";
  };
  field.onInput = (handler) => input.addEventListener("input", handler);
  return field;
}

/** Целое положительное число: inputmode + maxlength, но проверка всё равно в валидации. */
export function createNumberField(config = {}) {
  const field = createTextField({ ...config, maxlength: config.maxlength ?? 9 });
  field.input.setAttribute("inputmode", "numeric");
  return field;
}

export function createTextareaField({ label, value = "", hint, maxlength = 2000, rows = 4, placeholder = "" }) {
  const id = nextId("field");
  const textarea = baseControl("textarea", id, {
    rows: String(rows),
    placeholder,
    maxlength: String(maxlength),
  });
  textarea.value = value ?? "";
  const control = h("div", { class: "control control--multiline" }, [textarea]);
  const field = wrap({ id, label, hint, required: false, control });
  field.input = textarea;
  field.getValue = () => textarea.value;
  field.setValue = (next) => {
    textarea.value = next ?? "";
  };
  field.onInput = (handler) => textarea.addEventListener("input", handler);
  return field;
}

/**
 * Выбор из списка.
 * @param {{label:string, options:Array<{value:any,label:string,disabled?:boolean}>,
 *          value:any, hint?:string, placeholder?:string}} config
 */
export function createSelectField(config = {}) {
  const { label, options = [], value = "", hint, placeholder, required = false } = config;
  const id = nextId("field");
  const select = baseControl("select", id, { "aria-required": required ? "true" : null });

  const children = [];
  if (placeholder !== undefined) {
    children.push(h("option", { value: "", text: placeholder, disabled: options.length === 0 ? true : null }));
  }
  for (const option of options) {
    const node = h("option", { value: String(option.value), text: option.label });
    if (option.disabled) node.disabled = true;
    children.push(node);
  }
  select.append(...children);
  select.value = value === null || value === undefined ? "" : String(value);

  const control = h("div", { class: "control control--select" }, [
    select,
    h("span", { class: "select__chevron", "aria-hidden": "true" }, [icon("chevron-down", { size: 14 })]),
  ]);
  const field = wrap({ id, label, hint, required, control });
  field.select = select;
  field.input = select;
  field.getValue = () => select.value;
  field.setValue = (next) => {
    select.value = next === null || next === undefined ? "" : String(next);
  };
  field.setOptions = (nextOptions, nextValue) => {
    select.replaceChildren(
      ...(placeholder !== undefined ? [h("option", { value: "", text: placeholder })] : []),
      ...nextOptions.map((option) => {
        const node = h("option", { value: String(option.value), text: option.label });
        if (option.disabled) node.disabled = true;
        return node;
      }),
    );
    field.setValue(nextValue ?? select.options[0]?.value ?? "");
  };
  field.onChange = (handler) => select.addEventListener("change", () => handler(select.value));
  return field;
}

export const varietyTypeOptions = VARIETY_TYPES.map((type) => ({ value: type.value, label: type.label }));

/** Поле поиска с иконкой и кнопкой очистки. */
export function createSearchField({ label = "Поиск", value = "", placeholder = "Поиск", onInput, width } = {}) {
  const id = nextId("search");
  const input = h("input", {
    id,
    type: "search",
    value,
    placeholder,
    "aria-label": label,
    autocomplete: "off",
  });
  const clearButton = h("button", {
    type: "button",
    class: "btn-icon",
    "aria-label": "Очистить поиск",
    style: "width:24px;height:24px",
    hidden: value ? false : true,
  }, [icon("x", { size: 14 })]);
  clearButton.addEventListener("click", () => {
    input.value = "";
    clearButton.hidden = true;
    input.focus();
    onInput?.("");
  });
  input.addEventListener("input", () => {
    clearButton.hidden = input.value.length === 0;
    onInput?.(input.value);
  });

  const control = h("div", { class: "control" }, [h("span", { class: "control__adorn" }, [icon("search", { size: 14 })]), input, clearButton]);
  const field = h("div", { class: "search", style: width ? `flex:0 1 ${width}px` : null }, [
    h("label", { class: "sr-only", for: id, text: label }),
    control,
  ]);
  field.input = input;
  field.getValue = () => input.value;
  field.setValue = (next) => {
    input.value = next ?? "";
    clearButton.hidden = !input.value;
  };
  return field;
}
