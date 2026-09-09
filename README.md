# Weather_Cover

Репозиторий проекта **AgroCast 2.5** — десктоп-оболочка (каркас) локальных
агропрогнозов для Краснодарского края (28 точек сетки P01–P28).

> ⚠️ Это **только красивый каркас без реальных расчётов**: никаких zarr/моделей/блендеров.
> Все данные демонстрационные (мок), интерфейс полностью рабочий.

Всё лежит в каталоге [`AgroCast/`](AgroCast/):

| Что | Где |
|---|---|
| Точка входа (исходники) | `AgroCast/app.py`, `python -m agrocast.desktop` |
| Десктоп-оболочка PySide6 + QtWebEngine + QWebChannel | `AgroCast/agrocast/desktop/` |
| Локальный API (FastAPI, моки) + CSP под Яндекс.Карты | `AgroCast/agrocast/serve/` |
| База сортов кукурузы (SQLite `~/.agrocast/crops.db`) | `AgroCast/agrocast/crops/db.py` |
| Frontend (HTML/CSS/JS, Яндекс.Карта + Leaflet fallback) | `AgroCast/static/` |
| Мир: сетка 28 точек, сорта-сид, конфиг, ready.json | `AgroCast/world/` |
| Сборка EXE | `AgroCast/tools/build_exe.py` + `AgroCast/AgroCast.spec` |
| Тесты API | `AgroCast/tests/` |
| CI (тесты Linux + сборка exe Windows) | `.github/workflows/ci.yml` |

Быстрый старт (Linux/macOS/Windows — режим исходников):

```bash
cd AgroCast
python -m pip install -r requirements.txt
python app.py            # или: python -m agrocast.desktop
```

Windows-лаунчер: `AgroCast/AgroCast.bat`, Linux/macOS: `AgroCast/AgroCast.sh`.

Подробная документация — в [AgroCast/README.md](AgroCast/README.md).
