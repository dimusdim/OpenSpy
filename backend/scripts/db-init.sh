#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "${SCRIPT_DIR}/db-common.sh"

db_init
echo "Initialized local PostgreSQL cluster at ${LOCAL_DB_DATA_DIR}"
