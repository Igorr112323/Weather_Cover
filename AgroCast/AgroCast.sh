#!/usr/bin/env bash
# ============================================================
#  AgroCast 2.5 — лаунчер для Linux/macOS (режим исходников)
# ============================================================
set -euo pipefail
cd "$(dirname "$0")"

export AGROCAST_STATE_DIR="${AGROCAST_STATE_DIR:-$HOME/.agrocast}"
export DESKTOP=1

if [ -d "$(pwd)/static" ] && [ -d "$(pwd)/world" ]; then
  export AGROCAST_STATIC_DIR="$(pwd)/static"
  export AGROCAST_WORLD_DIR="$(pwd)/world"
  export AGROCAST_MIGRATIONS_DIR="$(pwd)/migrations"
fi

if [ -d "$(pwd)/_internal/static" ] && [ -d "$(pwd)/_internal/world" ]; then
  export AGROCAST_STATIC_DIR="$(pwd)/_internal/static"
  export AGROCAST_WORLD_DIR="$(pwd)/_internal/world"
  export AGROCAST_MIGRATIONS_DIR="$(pwd)/_internal/migrations"
fi

echo "[AgroCast] python -m agrocast.desktop (state: $AGROCAST_STATE_DIR)"
exec python -m agrocast.desktop
