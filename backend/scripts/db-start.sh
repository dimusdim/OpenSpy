#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "${SCRIPT_DIR}/db-common.sh"

db_start
echo "Local PostgreSQL is running on ${POSTGRES_DB_HOST}:${POSTGRES_DB_PORT} (db=${POSTGRES_DB_NAME})"
