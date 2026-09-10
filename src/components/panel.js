/** Панели, бейджи, пояснения, пары «подпись — значение». */

import { h, icon, setText } from "../lib/dom.js";
import { NOT_AVAILABLE } from "../lib/format.js";

/**
 * @param {{title?:string, actions?:Node|Array<Node>, body:Node|Array<Node>,
 *          flush?:boolean, className?:string, floating?:boolean, footer?:Node}} config
 */
export function createPanel({ title, actions = null, body, flush = false, className = "", floating = false, footer = null, subtitle = null } = {}) {
  const head = title
    ? h("div", { class: "panel__head" }, [
        h("div", { class: "panel__head-text" }, [
          h("h2", { class: "block-title", text: title }),
          subtitle ? h("p", { class: "muted", text: subtitle }) : null,
        ].filter(Boolean)),
        actions ? h("div", { class: "panel__head-actions" }, Array.isArray(actions) ? actions : [actions]) : null,
      ].filter(Boolean))
    : null;

  const panel = h("section", { class: ["panel", floating ? "panel--floating" : "", className].filter(Boolean).join(" ") }, [
    head,
    h("div", { class: ["panel__body", flush ? "panel__body--flush" : ""].filter(Boolean).join(" ") }, body === undefined ? [] : Array.isArray(body) ? body : [body]),
    footer ? h("div", { class: "panel__foot" }, Array.isArray(footer) ? footer : [footer]) : null,
  ].filter(Boolean));

  panel.body = panel.querySelector(".panel__body");
  panel.setBody = (nodes) => {
    const target = panel.body;
    target.replaceChildren(...(Array.isArray(nodes) ? nodes : [nodes]));
  };
  panel.setHeadActions = (nodes) => {
    const target = panel.querySelector(".panel__head-actions");
    if (!target) return;
    target.replaceChildren(...(Array.isArray(nodes) ? nodes : [nodes]));
  };
  panel.setTitle = (text) => {
    const node = panel.querySelector(".panel__head .block-title");
    if (node) setText(node, text);
  };
  return panel;
}

export function createBadge(text, { tone = "default", iconName = null } = {}) {
  const children = [];
  if (iconName) children.push(icon(iconName, { size: 12 }));
  children.push(h("span", { text }));
  return h("span", { class: ["badge", tone !== "default" ? `badge--${tone}` : ""].filter(Boolean).join(" ") }, children);
}

/** Пояснение с иконкой; используется для предупреждений, которые нельзя прятать. */
export function createNote(text, { tone = "info", iconName = null } = {}) {
  const name = iconName ?? (tone === "danger" ? "circle-alert" : tone === "warning" ? "triangle-alert" : "info");
  return h("div", { class: `note note--${tone}` }, [icon(name, { size: 16 }), h("span", { text })]);
}

/** dl-список параметров. Пустые значения показываются как «—». */
export function createKeyValue(pairs) {
  const dl = h("dl", { class: "kv" });
  for (const [label, value] of pairs) {
    const node = h("dd", { class: "num" });
    if (value instanceof Node || Array.isArray(value)) node.replaceChildren(...(Array.isArray(value) ? value : [value]));
    else setText(node, value === null || value === undefined || value === "" ? NOT_AVAILABLE : String(value));
    dl.append(h("dt", { text: label }), node);
  }
  return dl;
}

export function createSectionTitle(text, actions = null) {
  return h("div", { class: "panel__head", style: "border-left:0;border-right:0;border-top:0" }, [
    h("h3", { class: "block-title", text }),
    actions ? h("div", { class: "row" }, Array.isArray(actions) ? actions : [actions]) : null,
  ].filter(Boolean));
}
