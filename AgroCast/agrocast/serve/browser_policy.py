# -*- coding: utf-8 -*-
"""AgroCast 2.5 — политика браузера (CSP / заголовки).

CSP разрешает Яндекс.Карты и обязательные подстроки:
  * script-src  'self' 'unsafe-inline' 'unsafe-eval' + yandex
  * style-src   'self' 'unsafe-inline' + yandex
  * img-src     'self' data: https://tile.openstreetmap.org blob: + yandex   <- тестовая подстрока
  * connect-src 'self' + yandex + wss://*.yandex.ru
  * worker-src  'self' blob: + yandex
  * child-src   'self' blob: + yandex
  * frame-src   'self' + yandex
"""
from __future__ import annotations

# Базовый список: локальный сервер + Leaflet.
_BASE = {
    "default-src": "'self'",
    "script-src": "'self' 'unsafe-inline' 'unsafe-eval'",
    "style-src": "'self' 'unsafe-inline'",
    "font-src": "'self' data:",
    "img-src": "'self' data: https://tile.openstreetmap.org blob:",
    "connect-src": "'self'",
    "worker-src": "'self' blob:",
    "child-src": "'self' blob:",
    "frame-src": "'self'",
    "media-src": "'self' data: blob:",
    "object-src": "'none'",
    "base-uri": "'self'",
}

# Хосты Яндекс.Карт 2.1 и связанных сервисов.
_YANDEX = (
    "https://api-maps.yandex.ru",
    "https://*.yandex.ru",
    "https://*.yandex.net",
    "https://*.yandex.com",
    "https://*.yandex.com.tr",
)
_YANDEX_CONNECT = (
    "https://*.yandex.ru",
    "https://*.yandex.net",
    "https://*.maps.yandex.net",
    "https://api-maps.yandex.ru",
    "wss://*.yandex.ru",
    "wss://*.yandex.net",
)


def _join(items: str) -> str:
    return " ".join(items)


def build_csp(external_maps: bool = True) -> str:
    """Собирает строку Content-Security-Policy."""
    parts = []
    for key in ("default-src", "script-src", "style-src", "font-src",
                "img-src", "connect-src", "worker-src", "child-src",
                "frame-src", "media-src", "object-src", "base-uri"):
        value = _BASE[key]
        if external_maps:
            if key in ("connect-src", "worker-src"):
                extra = _YANDEX_CONNECT if key == "connect-src" else ("https://*.yandex.ru", "https://*.yandex.net", "blob:")
            elif key == "frame-src":
                extra = _YANDEX
            else:
                extra = _YANDEX
            value = _join([value, *extra])
        parts.append(f"{key} {value}")
    return "; ".join(parts)


CSP_HEADER = build_csp(external_maps=True)

# Явный маркер: эта подстрока обязана присутствовать (её ищут тесты/проверки).
IMG_OSM_MARKER = "img-src 'self' data: https://tile.openstreetmap.org"


def security_headers(csp: str = CSP_HEADER) -> dict[str, str]:
    return {
        "Content-Security-Policy": csp,
        "X-Content-Type-Options": "nosniff",
        "X-Frame-Options": "SAMEORIGIN",
        "Referrer-Policy": "no-referrer",
        "Cache-Control": "no-store",
    }


if __name__ == "__main__":  # pragma: no cover
    print(CSP_HEADER)
    assert IMG_OSM_MARKER in CSP_HEADER, "потеряна тестовая подстрока img-src OSM"
