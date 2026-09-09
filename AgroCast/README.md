# AgroCast 2.5 — каркас EXE-приложения (без реальных расчётов)

Локальные агропрогнозы для Краснодарского края, **28 точек сетки P01–P28**.
Пользователь кликает по карте, выбирает сорт кукурузы и горизонт, жмёт «Прогноз».
Внутри — только красивая оболочка: **все научные данные — моки**.

- Python 3.11, FastAPI отдаёт статику и локальный API
- PySide6 + QtWebEngine + QWebChannel (десктоп)
- Frontend: чистый HTML/CSS/JS (без React); основная карта — Яндекс.Карта 2.1, fallback — Leaflet (OSM)
- Сорта: SQLite `~/.agrocast/crops.db` (класс `CropDB`), сид из `world/artifacts/crop_seed.json` (UTF-8)
- Сборка: PyInstaller `--onedir` (exe в корне, библиотеки в `_internal/`)

## Структура

```
AgroCast/
  app.py                  # точка входа (python app.py)
  requirements.txt
  requirements-dev.txt
  AgroCast.spec           # PyInstaller onedir (contents_directory=_internal)
  AgroCast.bat            # лаунчер Windows
  AgroCast.sh             # лаунчер Linux/macOS
  agrocast/
    desktop/__main__.py   # python -m agrocast.desktop
    desktop/app.py        # QApplication + QWebEngineView + QWebChannel + splash + uvicorn-поток
    serve/browser_policy.py  # CSP: разрешает Яндекс.Карты (и OSM-подстроку для тестов)
    serve/local.py        # моковые эндпоинты + поиск каталогов мира
    serve/product.py      # FastAPI-приложение: /, /assets/*, /api/*
    crops/db.py           # CropDB (SQLite ~/.agrocast/crops.db)
  static/
    desktop.html          # версия 2.5, Яндекс.Карта + Leaflet (SRI), desktop.js (module)
    desktop.css           # дизайн-система продукта (не админка)
    desktop.js            # вся логика каркаса
    agrocast.png/.ico     # иконка 512 (инструмент: tools/prepare_assets.py)
    markers/*.svg         # зелёный/жёлтый/красный маркеры
    vendor/leaflet/       # локальный Leaflet 1.9.4 с integrity
  world/
    config.json           # регион: lat 43.0–47.0, lon 37.0–42.0
    ready.json            # {"ok": true}
    integrity.json        # необязательный маркер (try/except при старте)
    artifacts/
      krai_grid.json      # 28 точек P01–P28 (реальные населённые пункты края)
      crop_seed.json      # 7 сортов кукурузы (русский, UTF-8)
  migrations/0001_initial.sql
  tools/
    prepare_assets.py     # генерация иконок/маркеров из agrocast_raw.png (Pillow)
    build_exe.py          # сборка EXE + dist/AgroCast-2.5-exe.zip
  tests/test_smoke.py     # 8 smoke-тестов API (pytest)
```

## API (мок)

| Метод | Путь | Назначение |
|---|---|---|
| GET | `/api/region/grid` | 28 точек сетки |
| GET/POST | `/api/local/crops` | сорта (список / создать) |
| POST | `/api/local/crops/save` | создать или обновить сорт (upsert) |
| DELETE | `/api/local/crops/{id}` | удалить сорт |
| POST | `/api/local/forecast` | мок-прогноз (ответ ~1 с, кэш: false) |
| GET | `/api/local/inputs`, `/api/local/autonomy` | автономность |
| GET | `/assets/*` | статика (desktop.html/css/js, leaflet, иконки) |

Ответ `/api/local/forecast` строго по ТЗ:
`{cached:false, payload:{start, lat, lon, seasons:[{months, t2m:{quantiles_c, tercile_probs}, tp:{quantiles_mm, tercile_probs}}], agro:{what_to_do, insight:{water, sat, frost, risks}, phenology}}, log:[...]}`.

## Запуск

### Исходники

```bash
cd AgroCast
python -m pip install -r requirements.txt
python app.py            # GUI (PySide6)
```

Лаунчеры: `AgroCast.bat` (Windows), `AgroCast.sh` (Linux/macOS).
Лаунчеры выставляют `AGROCAST_STATIC_DIR/WORLD_DIR/MIGRATIONS_DIR/STATE_DIR` и `DESKTOP=1`.

### Тесты

```bash
python -m pip install -r requirements-dev.txt
python -m pytest tests/ -v
```

### Сборка EXE (Windows, Python 3.11)

```bash
python -m pip install -r requirements.txt
python tools/build_exe.py
# результат:
#   dist/AgroCast/AgroCast.exe         (exe + _internal/)
#   dist/AgroCast-2.5-exe.zip
```

Spec делает onedir: `pyinstaller --onedir --windowed --name AgroCast --add-data static:static --add-data world:world --add-data migrations:migrations --collect-all PySide6`; библиотеки — в `_internal`, exe — в корне. Поиск ресурсов в рантайме идёт в 4 местах (`root/name`, `root/_internal/name`, `root/AgroCast/_internal/name`, `parents[2]/name`), `integrity.json` читается в try/except.

## Возможности интерфейса

- Splash ~1.5 с: пульсирующая иконка, прогресс-бар, «AgroCast 2.5 · Яндекс.Карта»
- Шапка: лого, «AgroCast [2.5] …», зелёный badge «✓ интернет есть · Яндекс.Карта», «Печать отчета» (PDF), «JSON»
- Карта: Яндекс.Карта (center `[45.3,39.0]`, zoom 8, Rectangle `[[44,37],[46.5,40.5]]`, setBounds `[[43.2,36.1],[47.3,42.4]]`), при недоступности за 3 с — Leaflet OSM (tileerror снимает слой, но маркеры/полигон видны)
- 28 маркеров: зелёный → жёлтый (hover) → красный (выбранная); клик по карте — ближайшая точка через haversine (6371e3); координаты в правом верхнем углу меняются
- Табы «Прогнозы / Скачанные данные / Отчеты»; вкладка данных появляется после первого прогноза
- Справочник кукурузы: 7 сид-сортов, CRUD, валидация (ФАО 50–650, САТ 1500–3500, вегетация 60–200, урожай 0.1–30, мороз −8..0, сев ММ-ДД)
- Отчёты (архив localStorage): терцили-бары, «Что делать» топ-3, вода, САТ, заморозки, риски, фенология; печать в PDF, экспорт JSON
- Всё сохраняется между перезапусками (сорта — SQLite, отчёты/скачанные данные — localStorage, выбор — тоже)

## Как поменять ключ Яндекс.Карт

По умолчанию подключается `https://api-maps.yandex.ru/2.1/?lang=ru_RU` (как в ТЗ).
Если нужен ключ — задайте `YMAPS_KEY` в начале `static/desktop.js`, он добавится в URL загрузчика.
