#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
. "${SCRIPT_DIR}/db-common.sh"

if [[ -z "${DATABASE_URL:-}" ]]; then
    if postgres_cluster_running; then
        export POSTGRES_ENABLED="${POSTGRES_ENABLED:-true}"
        export DATABASE_URL="${POSTGRES_DB_URL_DEFAULT}"
        export DB_APP_NAME="${DB_APP_NAME:-openspy-backend}"
    else
        echo "dev:raw requires DATABASE_URL or a running local PostgreSQL cluster." >&2
        echo "Use 'npm run dev' to start PostgreSQL automatically, or run 'npm run db:start' first." >&2
        exit 1
    fi
fi

cd "${BACKEND_DIR}"
exec ts-node src/index.ts
