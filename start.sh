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

# Kill ALL old backend processes — not just by port.
#
# Root cause of zombies: `concurrently` spawns `nodemon` → `ts-node`.
# When concurrently is killed (Ctrl+C, terminal close, Claude restarts),
# the child ts-node processes become orphans. They no longer listen on the
# port (a new process took it), but they still hold WebSocket connections
# to AISStream, OpenSky, etc. — burning API quotas and triggering rate
# limits. Searching by port (lsof) misses these orphans completely.

# Step 1: kill ALL ts-node backend processes (orphans + current)
STALE_PIDS=$(pgrep -f "ts-node.*src/index\.ts" 2>/dev/null || true)
if [ -n "$STALE_PIDS" ]; then
    echo "[cleanup] Killing stale backend processes: $STALE_PIDS"
    echo "$STALE_PIDS" | xargs kill -9 2>/dev/null || true
    sleep 1
fi

# Step 2: kill stale concurrently / nodemon wrappers
WRAPPER_PIDS=$(pgrep -f "concurrently.*dev|nodemon.*src/index" 2>/dev/null || true)
if [ -n "$WRAPPER_PIDS" ]; then
    echo "[cleanup] Killing stale wrappers: $WRAPPER_PIDS"
    echo "$WRAPPER_PIDS" | xargs kill -9 2>/dev/null || true
    sleep 1
fi

# Step 3: kill anything holding the DuckDB cache file
if [ -f "$DUCKDB_FILE" ]; then
    DUCKDB_PIDS=$(lsof "$DUCKDB_FILE" 2>/dev/null | awk 'NR>1{print $2}' | sort -u)
    if [ -n "$DUCKDB_PIDS" ]; then
        echo "[cleanup] Killing processes holding DuckDB lock: $DUCKDB_PIDS"
        echo "$DUCKDB_PIDS" | xargs kill -9 2>/dev/null || true
        sleep 1
    fi
fi

# Step 4: free ports (catch anything else — other projects, stale next-server)
for PORT in $BACKEND_PORT $FRONTEND_PORT; do
    PORT_PIDS=$(lsof -ti :$PORT 2>/dev/null || true)
    if [ -n "$PORT_PIDS" ]; then
        echo "[cleanup] Killing processes on port $PORT: $PORT_PIDS"
        echo "$PORT_PIDS" | xargs kill -9 2>/dev/null || true
    fi
done
sleep 1

# Remove stale DuckDB WAL/lock files (safe — DuckDB recreates on open)
rm -f "$DUCKDB_FILE.wal" 2>/dev/null || true

echo "[cleanup] Done. All stale processes killed, ports free."

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
