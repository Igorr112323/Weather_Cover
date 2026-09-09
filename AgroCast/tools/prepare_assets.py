#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Dev-инструмент: готовит статические ассеты AgroCast 2.5.

  * static/agrocast.png    — 512x512 иконка приложения (скругление + отступ)
  * static/agrocast.ico    — Windows-иконка для exe (16/32/48/256)
  * static/favicon.png     — favicon
  * static/markers/*.svg   — маркеры карты (green / yellow / red)

Запуск:  python tools/prepare_assets.py   (нужен Pillow)
"""
from __future__ import annotations

import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
RAW = ROOT / "static" / "agrocast_raw.png"
OUT_512 = ROOT / "static" / "agrocast.png"
OUT_ICO = ROOT / "static" / "agrocast.ico"
OUT_FAV = ROOT / "static" / "favicon.png"
OUT_MARKERS = ROOT / "static" / "markers"


def rounded(png_path: Path, out_path: Path, size: int, radius_ratio: float = 0.16):
    from PIL import Image, ImageDraw

    img = Image.open(png_path).convert("RGBA")
    # квадратный кроп по центру
    w, h = img.size
    side = min(w, h)
    img = img.crop(((w - side) // 2, (h - side) // 2, (w + side) // 2, (h + side) // 2))
    img = img.resize((size, size), Image.LANCZOS)
    radius = int(size * radius_ratio)
    mask = Image.new("L", (size, size), 0)
    d = ImageDraw.Draw(mask)
    d.rounded_rectangle([0, 0, size - 1, size - 1], radius=radius, fill=255)
    out = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    out.paste(img, (0, 0), mask)
    out.save(out_path)


def favicon(png_path: Path, out_path: Path):
    from PIL import Image

    img = Image.open(png_path).convert("RGBA")
    img = img.resize((64, 64), Image.LANCZOS)
    img.save(out_path)


def ico(png_path: Path, out_path: Path):
    from PIL import Image

    img = Image.open(png_path).convert("RGBA")
    img.save(out_path, sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (256, 256)])


def markers():
    """Каплевидные маркеры: белая обводка, цветная заливка, белая точка."""
    OUT_MARKERS.mkdir(parents=True, exist_ok=True)
    palette = {"green": "#1c6b3c", "yellow": "#e3b46c", "red": "#c0392b"}
    for name, color in palette.items():
        svg = f'''<svg xmlns="http://www.w3.org/2000/svg" width="36" height="48" viewBox="0 0 36 48">
  <path d="M18 1C9.4 1 2.5 7.9 2.5 16.5c0 11 13 27.9 13.9 28.9a2 2 0 0 0 3.2 0c.9-1 13.9-17.9 13.9-28.9C33.5 7.9 26.6 1 18 1z"
        fill="{color}" stroke="#ffffff" stroke-width="2.4"/>
  <circle cx="18" cy="16.5" r="6.4" fill="#ffffff" opacity="0.96"/>
</svg>'''
        (OUT_MARKERS / f"marker-{name}.svg").write_text(svg, encoding="utf-8")
        # retina-версия (двойной размер) для Яндекс.Карты
        svg2 = svg.replace('width="36" height="48"', 'width="72" height="96"')
        (OUT_MARKERS / f"marker-{name}@2x.svg").write_text(svg2, encoding="utf-8")


def main() -> int:
    if not RAW.is_file():
        print(f"Нет исходника: {RAW}")
        return 1
    try:
        import PIL  # noqa: F401
    except ImportError:
        print("Нужен Pillow:  pip install Pillow")
        return 2
    OUT_512.parent.mkdir(parents=True, exist_ok=True)
    rounded(RAW, OUT_512, 512)
    ico(OUT_512, OUT_ICO)
    favicon(OUT_512, OUT_FAV)
    markers()
    print(f"OK: {OUT_512.name}, {OUT_ICO.name}, {OUT_FAV.name}, markers/")
    return 0


if __name__ == "__main__":
    sys.exit(main())
