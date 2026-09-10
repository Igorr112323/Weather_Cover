/**
 * Помощники DOM.
 *
 * Весь пользовательский текст попадает в DOM только через textContent
 * (см. createText/h): innerHTML с данными пользователя не используется нигде
 * в приложении — это защита от внедрения разметки через названия сортов,
 * примечания и имена отчётов.
 */

const SVG_NS = "http://www.w3.org/2000/svg";
const iconCache = new Map();

/**
 * Создаёт элемент.
 * @param {string} tag
 * @param {Record<string, any>} [props] class, text, dataset, attrs, on:click…
 * @param {(Node|string|null|false|Array)} [children]
 */
export function h(tag, props = {}, children = undefined) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props || {})) {
    if (value === null || value === undefined || value === false) continue;
    if (key === "class" || key === "className") node.className = value;
    else if (key === "text") node.textContent = String(value);
    else if (key === "dataset") Object.assign(node.dataset, value);
    else if (key === "style") node.setAttribute("style", value);
    else if (key.startsWith("on") && typeof value === "function") {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (key === "html") {
      // Принимает только доверительную локальную разметку (SVG-иконки Lucide).
      // Данные пользователя сюда передавать нельзя.
      node.append(parseFragment(value));
    } else {
      node.setAttribute(key, value === true ? "" : String(value));
    }
  }
  appendChildren(node, children);
  return node;
}

export function appendChildren(node, children) {
  if (children === null || children === undefined || children === false) return node;
  if (Array.isArray(children)) {
    for (const child of children) appendChildren(node, child);
    return node;
  }
  node.append(typeof children === "string" || typeof children === "number" ? document.createTextNode(String(children)) : children);
  return node;
}

/** Полностью очищает узел без innerHTML = "". */
export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
  return node;
}

export function setText(node, value) {
  node.textContent = value === null || value === undefined ? "" : String(value);
  return node;
}

export function setDisabled(node, disabled) {
  node.disabled = Boolean(disabled);
  node.setAttribute("aria-disabled", disabled ? "true" : "false");
  return node;
}

/** Локальный SVG (Lucide) разбирается DOMParser'ом, а не вставляется строкой. */
export function parseSvg(markup) {
  const doc = new DOMParser().parseFromString(markup, "image/svg+xml");
  const root = doc.documentElement;
  if (!root || root.nodeName.toLowerCase() !== "svg" || root.querySelector("parsererror")) {
    return null;
  }
  return document.importNode(root, true);
}

function parseFragment(markup) {
  const svg = parseSvg(markup);
  const frag = document.createDocumentFragment();
  if (svg) frag.append(svg);
  return frag;
}

/**
 * Реестр SVG-иконок подгружается сборщиком; при отсутствии файла возвращается
 * нейтральный контур, чтобы интерфейс не разваливался.
 */
const iconModules = import.meta.glob("../assets/icons/*.svg", {
  query: "?raw",
  import: "default",
  eager: true,
});

const ICONS = new Map();
for (const [path, raw] of Object.entries(iconModules)) {
  const name = path.split("/").pop().replace(/\.svg$/, "");
  ICONS.set(name, raw);
}

export function hasIcon(name) {
  return ICONS.has(name);
}

/**
 * @param {string} name имя файла иконки без расширения (lucide)
 * @param {{size?:number, class?:string, title?:string}} [options]
 */
export function icon(name, options = {}) {
  const { size = 16, class: extraClass = "", title } = options;
  const cached = iconCache.get(`${name}:${size}:${title ? 1 : 0}`);
  if (cached) {
    const clone = cached.cloneNode(true);
    applyIconClass(clone, extraClass);
    return clone;
  }

  const markup = ICONS.get(name);
  let node;
  if (markup) {
    node = parseSvg(markup) ?? fallbackIcon();
  } else {
    node = fallbackIcon();
  }
  node.setAttribute("width", String(size));
  node.setAttribute("height", String(size));
  node.setAttribute("class", `icon${extraClass ? ` ${extraClass}` : ""}`);
  if (title) {
    node.removeAttribute("aria-hidden");
    const titleNode = document.createElementNS(SVG_NS, "title");
    titleNode.textContent = title;
    node.prepend(titleNode);
  } else {
    node.setAttribute("aria-hidden", "true");
    node.setAttribute("focusable", "false");
  }
  iconCache.set(`${name}:${size}:${title ? 1 : 0}`, node);
  const clone = node.cloneNode(true);
  applyIconClass(clone, extraClass);
  return clone;
}

function applyIconClass(node, extraClass) {
  if (extraClass) node.setAttribute("class", `${node.getAttribute("class") || "icon"} ${extraClass}`);
}

function fallbackIcon() {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "2");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  const circle = document.createElementNS(SVG_NS, "circle");
  circle.setAttribute("cx", "12");
  circle.setAttribute("cy", "12");
  circle.setAttribute("r", "8");
  svg.append(circle);
  return svg;
}

/** Кнопка с доступным именем и подсказкой. */
export function setTooltip(node, label) {
  node.setAttribute("title", label);
  node.dataset.tip = label;
  return node;
}

export function isVisible(node) {
  return Boolean(node) && node.isConnected && node.getClientRects().length > 0;
}
