/**
 * Мини-DOM для проверки целиком собранных страниц (автономной и личной).
 *
 * Страницы — это один файл с инлайновым скриптом, и их логика («нажал кнопку →
 * появился код») не проверяется юнит-тестами чистых функций. Здесь ровно тот
 * набор API, которым пользуются эти скрипты: id-элементы собираются по вызовам
 * $("…"), события — по addEventListener, хранилище — Map вместо localStorage.
 * Тот же realm, что и у теста, поэтому Buffer и Uint8Array из ядра подходят.
 */

import assert from "node:assert/strict";
import vm from "node:vm";

export function fakePage(script) {
  const listeners = new Map();
  const ids = [...script.matchAll(/\$\("([^"]+)"\)/g)].map((match) => match[1]);
  const nodes = new Map();
  for (const id of new Set(ids)) {
    nodes.set(id, {
      id,
      value: "",
      checked: false,
      hidden: false,
      textContent: "",
      innerHTML: "",
      className: "",
      href: "",
      dataset: {},
      classList: { toggle() {}, add() {}, remove() {}, contains: () => false },
      addEventListener(type, handler) {
        if (!listeners.has(id)) listeners.set(id, {});
        listeners.get(id)[type] = handler;
      },
      click() {},
      select() {},
      focus() {},
      remove() {},
      append() {},
    });
  }
  const storage = new Map();
  const localStorage = {
    getItem: (key) => (storage.has(key) ? storage.get(key) : null),
    setItem: (key, value) => storage.set(key, String(value)),
    removeItem: (key) => storage.delete(key),
  };
  const document = {
    getElementById: (id) => nodes.get(id) ?? null,
    querySelectorAll: () => [],
    createElement: () => ({ value: "", select() {}, remove() {}, style: {} }),
    addEventListener() {},
    body: { append() {} },
  };
  const sandbox = {
    // то, что в браузере есть по умолчанию
    document,
    localStorage,
    crypto: globalThis.crypto,
    TextEncoder,
    TextDecoder,
    btoa: (value) => Buffer.from(value, "binary").toString("base64"),
    atob: (value) => Buffer.from(value, "base64").toString("binary"),
    Uint8Array,
    Set,
    Map,
    navigator: { clipboard: { writeText: async () => {} } },
    URL: { createObjectURL: () => "blob:x", revokeObjectURL() {} },
    Blob: class Blob {},
    setTimeout,
    clearTimeout,
    console,
  };
  const context = vm.createContext(sandbox);
  vm.runInContext(`(() => {\n"use strict";\n${script}\n})()`, context);
  return {
    storage: {
      get: (key) => storage.get(key) ?? "",
      set: (key, value) => storage.set(key, value),
    },
    get: (id) => nodes.get(id) ?? (() => { throw new Error(`нет элемента #${id}`); })(),
    set: (id, value) => {
      nodes.get(id).value = value;
    },
    async click(id) {
      const handler = listeners.get(id)?.click;
      assert.ok(handler, `у #${id} нет обработчика клика`);
      await handler({ target: { closest: () => null } });
    },
    close() {},
  };
}
