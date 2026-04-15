#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./db-common.sh
source "${SCRIPT_DIR}/db-common.sh"

db_start
set -a
eval "$(db_print_env)"
set +a

cd "${BACKEND_DIR}"
npx ts-node src/db/run-migrations.ts
