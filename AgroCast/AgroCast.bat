@echo off
rem ============================================================
rem  AgroCast 2.5 — лаунчер для Windows
rem  Режимы:
rem   * exe рядом с лаунчером (dist\AgroCast\) -> запускает AgroCast.exe
rem   * исходники (python -m agrocast.desktop)
rem ============================================================
setlocal
cd /d "%~dp0"
set "AGROCAST_STATE_DIR=%USERPROFILE%\.agrocast"
set "DESKTOP=1"

rem -------- 1) собранный exe лежит рядом (dist/AgroCast) ---------
if exist "%~dp0AgroCast.exe" (
  if exist "%~dp0_internal\static" set "AGROCAST_STATIC_DIR=%~dp0_internal\static"
  if exist "%~dp0_internal\world"  set "AGROCAST_WORLD_DIR=%~dp0_internal\world"
  if exist "%~dp0_internal\migrations" set "AGROCAST_MIGRATIONS_DIR=%~dp0_internal\migrations"
  if not defined AGROCAST_STATIC_DIR if exist "%~dp0static" set "AGROCAST_STATIC_DIR=%~dp0static"
  if not defined AGROCAST_WORLD_DIR  if exist "%~dp0world"  set "AGROCAST_WORLD_DIR=%~dp0world"
  echo [AgroCast] Запуск AgroCast.exe ...
  start "" "%~dp0AgroCast.exe"
  exit /b 0
)

rem -------- 2) исходники ----------------------------------------
if not exist "%~dp0static" (
  echo [AgroCast] Не найдены ресурсы static/world рядом с лаунчером.
  pause
  exit /b 1
)
set "AGROCAST_STATIC_DIR=%~dp0static"
set "AGROCAST_WORLD_DIR=%~dp0world"
set "AGROCAST_MIGRATIONS_DIR=%~dp0migrations"

where python >nul 2>nul
if %errorlevel% neq 0 (
  echo [AgroCast] Python не найден в PATH. Установите Python 3.11+.
  pause
  exit /b 1
)
echo [AgroCast] Запуск из исходников: python -m agrocast.desktop
python -m agrocast.desktop
exit /b %errorlevel%
