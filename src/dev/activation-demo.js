/**
 * Экран активации в dev-сборке — только для проверок и разработки.
 *
 * В dev-режиме лицензия не требуется (иначе разработку было бы не начать),
 * поэтому экран активации открывается специальным адресом:
 *
 *   http://localhost:5173/?license=demo            обычный экран
 *   http://localhost:5173/?license=demo-tampered   экран с сообщением о порче файлов
 *
 * Активировать приложение в браузере нельзя: main process'а нет, и экран обязан
 * честно об этом сказать.
 *
 * Модуль подключается динамическим import внутри ветки `import.meta.env.DEV`,
 * поэтому в production-сборке он не собирается вовсе: ни кода, ни строк
 * «demo-tampered» в бандле не остаётся (проверяется tests/smoke/run-gate.mjs).
 */

import { createActivationPage } from "../pages/activate/index.js";

/** Режим демонстрации из адресной строки; пустая строка — режим не запрошен. */
export function activationDemoMode(search) {
  try {
    const value = new URLSearchParams(search ?? "").get("license") ?? "";
    return value === "demo" || value === "demo-tampered" ? value : "";
  } catch {
    return "";
  }
}

/**
 * Показывает экран активации и не отпускает управление: в браузере активация
 * невозможна, поэтому приложение не должно «проехать» дальше по сценарию.
 * @param {{mode:string, root:HTMLElement, version:string, revealWindow:()=>void}} options
 * @returns {Promise<never>}
 */
export function showActivationDemo({ mode, root, version, revealWindow }) {
  return new Promise((resolve) => {
    const page = createActivationPage({
      status: {
        activated: false,
        machineIdShort: "DEMO-DEMO",
        machineId: "de".repeat(32),
        machineQuality: "high",
        // demo-tampered: сообщение о порче файлов и заблокированные кнопки
        tampered: mode === "demo-tampered",
      },
      version,
      onActivated: (nextStatus) => resolve(nextStatus),
    });
    root.replaceChildren(page.node);
    revealWindow();
  });
}
