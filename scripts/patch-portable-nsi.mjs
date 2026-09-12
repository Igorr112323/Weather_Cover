/**
 * Правка шаблона portable-сборки electron-builder перед `npm run dist:win`.
 *
 * Стандартный шаблон (app-builder-lib/templates/nsis/portable.nsi) показывает
 * заставку build/splash.bmp только на время распаковки и убирает её ДО запуска
 * приложения. Пока Electron стартует (1–3 с), на экране нет ничего — человеку
 * кажется, что приложение «пропало». Патч меняет три вещи:
 *
 *   1. окно установщика NSIS получает пустой регион и не мелькает поверх
 *      заставки в первые миллисекунды (до HideWindow в секции);
 *   2. заставка живёт, пока приложение не сообщит о первом показанном окне:
 *      NSIS передаёт путь файла-маркера в переменной окружения
 *      AGRO_SPLASH_HANDOFF_FILE, а electron/main.cjs создаёт этот файл, как
 *      только показано окно загрузки или главное окно (страховка — 15 с);
 *   3. приложение запускается без ожидания в скрипте (ExecShellWaitEx), а
 *      NSIS дожидается его завершения уже после того, как убрал заставку.
 *
 * Изменения делаются идемпотентно в node_modules (после `npm ci` шаблон снова
 * исходный, поэтому скрипт запускается перед каждой сборкой EXE). Если шаблон
 * не совпал с ожидаемым (обновление electron-builder), скрипт завершается с
 * ошибкой — сборка не должна молча уйти без заставки.
 */

import { createRequire } from "node:module";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const require = createRequire(import.meta.url);

const MARKER = "; agroprognoz: splash handoff";
const HANDOFF_TIMEOUT_MS = 15000;
const POLL_MS = 100;

/* Блок в .onGUIInit: показ заставки. */
const ORIGINAL_GUI_INIT = `  !ifdef SPLASH_IMAGE
    File /oname=$PLUGINSDIR\\splash.bmp "\${SPLASH_IMAGE}"
    BgImage::SetBg $PLUGINSDIR\\splash.bmp
    BgImage::Redraw
  !endif
`;

const PATCHED_GUI_INIT = `  !ifdef SPLASH_IMAGE
    ; agroprognoz: the installer dialog gets an empty window region, so it never
    ; flashes over the splash image before HideWindow runs in the section.
    System::Call 'gdi32::CreateRectRgn(i 0, i 0, i 0, i 0) p .R9'
    System::Call 'user32::SetWindowRgn(p $HWNDPARENT, p R9, i 0)'
    File /oname=$PLUGINSDIR\\splash.bmp "\${SPLASH_IMAGE}"
    BgImage::SetBg $PLUGINSDIR\\splash.bmp
    BgImage::Redraw
  !endif
`;

/* Блок в секции: запуск приложения. */
const ORIGINAL_LAUNCH = `  !ifdef SPLASH_IMAGE
    BgImage::Destroy
  !endif

\tExecWait "$INSTDIR\\\${APP_EXECUTABLE_FILENAME} $R0" $0
  SetErrorLevel $0
`;

const PATCHED_LAUNCH = `  !ifdef SPLASH_IMAGE
    ${MARKER}
    ; The splash stays on screen until the application shows its first window:
    ; the app creates the marker file passed in AGRO_SPLASH_HANDOFF_FILE.
    StrCpy $R1 "$PLUGINSDIR\\splash-handoff"
    Delete "$R1"
    System::Call 'Kernel32::SetEnvironmentVariable(t, t)i ("AGRO_SPLASH_HANDOFF_FILE", "$R1").r0'
    \${StdUtils.ExecShellWaitEx} $R2 $R3 "$INSTDIR\\\${APP_EXECUTABLE_FILENAME}" "" "$R0"
    StrCmp $R2 "error" agro_splash_launch_failed
    StrCpy $R4 0
    agro_splash_wait:
      IfFileExists "$R1" agro_splash_done
      IntCmp $R4 ${HANDOFF_TIMEOUT_MS} agro_splash_done agro_splash_tick agro_splash_done
    agro_splash_tick:
      Sleep ${POLL_MS}
      IntOp $R4 $R4 + ${POLL_MS}
      Goto agro_splash_wait
    agro_splash_done:
      ; Give the application window a moment to finish its open animation.
      Sleep 200
      BgImage::Destroy
      StrCpy $0 0
      StrCmp $R2 "ok" 0 agro_splash_exit
      \${StdUtils.WaitForProcEx} $0 $R3
      StrCmp $0 "error" 0 agro_splash_exit
      StrCpy $0 1
      Goto agro_splash_exit
    agro_splash_launch_failed:
      BgImage::Destroy
      ExecWait "$INSTDIR\\\${APP_EXECUTABLE_FILENAME} $R0" $0
    agro_splash_exit:
  !else
    ExecWait "$INSTDIR\\\${APP_EXECUTABLE_FILENAME} $R0" $0
  !endif
  SetErrorLevel $0
`;

const templatePath = path.join(path.dirname(require.resolve("app-builder-lib/package.json")), "templates", "nsis", "portable.nsi");

const source = await readFile(templatePath, "utf8");
if (source.includes(MARKER)) {
  console.log(`• portable.nsi уже исправлен: ${templatePath}`);
} else if (!source.includes(ORIGINAL_GUI_INIT) || !source.includes(ORIGINAL_LAUNCH)) {
  console.error(`✗ Неожиданное содержимое ${templatePath}: ожидаемые блоки не найдены. Проверьте версию electron-builder.`);
  process.exit(1);
} else {
  const patched = source.replace(ORIGINAL_GUI_INIT, PATCHED_GUI_INIT).replace(ORIGINAL_LAUNCH, PATCHED_LAUNCH);
  await writeFile(templatePath, patched, "utf8");
  console.log(`✓ portable.nsi: заставка держится до первого окна приложения (${templatePath})`);
}
