#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
. "${SCRIPT_DIR}/db-common.sh"

STARTED_LOCAL_DB=0
if ! postgres_cluster_running; then
    db_start
    STARTED_LOCAL_DB=1
fi

export POSTGRES_ENABLED="${POSTGRES_ENABLED:-true}"
export DATABASE_URL="${DATABASE_URL:-${POSTGRES_DB_URL_DEFAULT}}"
export DB_APP_NAME="${DB_APP_NAME:-openspy-backend}"

cleanup() {
    if [[ "${STARTED_LOCAL_DB}" == "1" ]]; then
        db_stop || true
    fi
}

trap cleanup EXIT INT TERM

cd "${BACKEND_DIR}"
exec ts-node src/index.ts
