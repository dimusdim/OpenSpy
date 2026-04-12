#!/bin/bash
# ============================================================================
# OpenSpy — unified launch script
# Cleans up zombie processes, frees ports, then starts backend + frontend.
# Usage: ./start.sh
# ============================================================================

set -e

BACKEND_PORT=3055
FRONTEND_PORT=3737
ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
BACKEND_DIR="$ROOT_DIR/backend"
FRONTEND_DIR="$ROOT_DIR/frontend"
DUCKDB_FILE="$BACKEND_DIR/data/overture-cache.duckdb"

echo "╔══════════════════════════════════════╗"
echo "║       OpenSpy — Starting          ║"
echo "╚══════════════════════════════════════╝"

# ----------------------------------------------------------------------------
# 1. Kill zombie processes from previous runs
# ----------------------------------------------------------------------------
echo ""
echo "[cleanup] Checking for stale processes..."

# Kill anything holding the DuckDB cache file (stale backend instances)
if [ -f "$DUCKDB_FILE" ]; then
    DUCKDB_PIDS=$(lsof "$DUCKDB_FILE" 2>/dev/null | awk 'NR>1{print $2}' | sort -u)
    if [ -n "$DUCKDB_PIDS" ]; then
        echo "[cleanup] Killing processes holding DuckDB lock: $DUCKDB_PIDS"
        echo "$DUCKDB_PIDS" | xargs kill -9 2>/dev/null || true
        sleep 1
    fi
fi

# Free backend port
BACKEND_PIDS=$(lsof -ti :$BACKEND_PORT 2>/dev/null || true)
if [ -n "$BACKEND_PIDS" ]; then
    echo "[cleanup] Killing processes on port $BACKEND_PORT: $BACKEND_PIDS"
    echo "$BACKEND_PIDS" | xargs kill -9 2>/dev/null || true
    sleep 1
fi

# Free frontend port
FRONTEND_PIDS=$(lsof -ti :$FRONTEND_PORT 2>/dev/null || true)
if [ -n "$FRONTEND_PIDS" ]; then
    echo "[cleanup] Killing processes on port $FRONTEND_PORT: $FRONTEND_PIDS"
    echo "$FRONTEND_PIDS" | xargs kill -9 2>/dev/null || true
    sleep 1
fi

# Remove stale DuckDB WAL/lock files (safe — DuckDB recreates on open)
rm -f "$DUCKDB_FILE.wal" 2>/dev/null || true

echo "[cleanup] Done. Ports $BACKEND_PORT and $FRONTEND_PORT are free."

# ----------------------------------------------------------------------------
# 2. Pre-flight checks
# ----------------------------------------------------------------------------
echo ""
echo "[preflight] Checking dependencies..."

if ! command -v node &>/dev/null; then
    echo "ERROR: node not found. Install Node.js 18+."
    exit 1
fi

if [ ! -d "$BACKEND_DIR/node_modules" ]; then
    echo "[preflight] Backend dependencies missing. Running npm install..."
    (cd "$BACKEND_DIR" && npm install)
fi

if [ ! -d "$FRONTEND_DIR/node_modules" ]; then
    echo "[preflight] Frontend dependencies missing. Running npm install..."
    (cd "$FRONTEND_DIR" && npm install)
fi

if [ ! -f "$BACKEND_DIR/.env" ]; then
    echo "WARNING: backend/.env not found. Copy from .env.example and add API keys."
fi

# ----------------------------------------------------------------------------
# 3. Show Overture cache status
# ----------------------------------------------------------------------------
if [ -f "$DUCKDB_FILE" ]; then
    SIZE_MB=$(du -m "$DUCKDB_FILE" 2>/dev/null | awk '{print $1}')
    echo "[overture] Local cache: ${SIZE_MB} MB ($DUCKDB_FILE)"
else
    echo "[overture] No local cache — will download on first startup (10-25 min)"
fi

# ----------------------------------------------------------------------------
# 4. Launch backend + frontend
# ----------------------------------------------------------------------------
echo ""
echo "[launch] Starting backend (port $BACKEND_PORT) + frontend (port $FRONTEND_PORT)..."
echo "[launch] Press Ctrl+C to stop both."
echo ""

cd "$ROOT_DIR"
npm run dev
