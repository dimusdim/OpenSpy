#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
PROJECT_ROOT="$(cd "${BACKEND_DIR}/.." && pwd)"

LOCAL_DB_ROOT="${PROJECT_ROOT}/.local/postgres"
LOCAL_DB_DATA_DIR="${LOCAL_DB_ROOT}/data"
LOCAL_DB_LOG_DIR="${LOCAL_DB_ROOT}/log"
LOCAL_DB_RUN_DIR="${LOCAL_DB_ROOT}/run"
LOCAL_DB_LOG_FILE="${LOCAL_DB_LOG_DIR}/postgres.log"

POSTGRES_DB_NAME="${POSTGRES_DB_NAME:-openspy}"
POSTGRES_DB_USER="${POSTGRES_DB_USER:-postgres}"
POSTGRES_DB_HOST="${POSTGRES_DB_HOST:-127.0.0.1}"
POSTGRES_DB_PORT="${POSTGRES_DB_PORT:-5432}"
POSTGRES_DB_URL_DEFAULT="postgresql://${POSTGRES_DB_USER}@${POSTGRES_DB_HOST}:${POSTGRES_DB_PORT}/${POSTGRES_DB_NAME}"

select_postgres_formula() {
    local requested="${POSTGRES_FORMULA:-}"
    local candidates=()

    if [[ -n "$requested" ]]; then
        candidates+=("$requested")
    fi

    candidates+=("postgresql@18" "postgresql@17" "postgresql@16")

    if ! command -v brew >/dev/null 2>&1; then
        printf '%s\n' "${requested:-postgresql@18}"
        return 0
    fi

    local formula
    for formula in "${candidates[@]}"; do
        [[ -n "$formula" ]] || continue
        if ! brew list --versions "$formula" >/dev/null 2>&1; then
            continue
        fi

        if [[ "$formula" == "postgresql@16" ]]; then
            # Homebrew postgis no longer ships 16-compatible extension files.
            continue
        fi

        local share_dir
        share_dir="$(brew --prefix)/share/${formula}/extension"
        if [[ -f "${share_dir}/postgis.control" ]]; then
            printf '%s\n' "$formula"
            return 0
        fi
    done

    if [[ -n "$requested" ]]; then
        printf '%s\n' "$requested"
        return 0
    fi

    printf '%s\n' "postgresql@18"
}

POSTGRES_FORMULA="$(select_postgres_formula)"
POSTGRES_MAJOR_VERSION="${POSTGRES_FORMULA#postgresql@}"

find_postgres_bin() {
    local name="$1"

    if command -v brew >/dev/null 2>&1; then
        local prefix
        prefix="$(brew --prefix "${POSTGRES_FORMULA}" 2>/dev/null || true)"
        if [[ -n "$prefix" && -x "${prefix}/bin/${name}" ]]; then
            printf '%s\n' "${prefix}/bin/${name}"
            return 0
        fi
    fi

    if command -v "$name" >/dev/null 2>&1; then
        command -v "$name"
        return 0
    fi

    return 1
}

require_postgres_bin() {
    local name="$1"
    local path
    path="$(find_postgres_bin "$name" || true)"
    if [[ -z "$path" ]]; then
        echo "Missing PostgreSQL binary: ${name}. Install local prerequisites first." >&2
        echo "Expected setup on macOS: brew install ${POSTGRES_FORMULA} postgis" >&2
        exit 1
    fi
    printf '%s\n' "$path"
}

POSTGRES_BIN="$(require_postgres_bin postgres)"
PG_CTL_BIN="$(require_postgres_bin pg_ctl)"
INITDB_BIN="$(require_postgres_bin initdb)"
PSQL_BIN="$(require_postgres_bin psql)"
CREATEDB_BIN="$(require_postgres_bin createdb)"

ensure_local_db_dirs() {
    mkdir -p "${LOCAL_DB_DATA_DIR}" "${LOCAL_DB_LOG_DIR}" "${LOCAL_DB_RUN_DIR}"
}

postgres_cluster_initialized() {
    [[ -f "${LOCAL_DB_DATA_DIR}/PG_VERSION" ]]
}

postgres_cluster_version() {
    if ! postgres_cluster_initialized; then
        return 1
    fi

    tr -d '[:space:]' < "${LOCAL_DB_DATA_DIR}/PG_VERSION"
}

ensure_cluster_version_compatible() {
    if ! postgres_cluster_initialized; then
        return 0
    fi

    local current_version
    current_version="$(postgres_cluster_version)"
    if [[ "$current_version" != "${POSTGRES_MAJOR_VERSION}" ]]; then
        echo "Project PostgreSQL cluster version ${current_version} is incompatible with ${POSTGRES_FORMULA}." >&2
        echo "Stop the cluster and recreate .local/postgres/data for the new major version." >&2
        return 1
    fi
}

postgres_cluster_running() {
    if ! postgres_cluster_initialized; then
        return 1
    fi

    "${PG_CTL_BIN}" -D "${LOCAL_DB_DATA_DIR}" status >/dev/null 2>&1
}

wait_for_postgres() {
    local retries="${1:-30}"
    local i=0

    while (( i < retries )); do
        if PGPASSWORD="${POSTGRES_DB_PASSWORD:-}" "${PSQL_BIN}" \
            -h "${POSTGRES_DB_HOST}" \
            -p "${POSTGRES_DB_PORT}" \
            -U "${POSTGRES_DB_USER}" \
            -d postgres \
            -Atqc "SELECT 1" >/dev/null 2>&1; then
            return 0
        fi
        i=$((i + 1))
        sleep 1
    done

    echo "Timed out waiting for PostgreSQL to accept connections on ${POSTGRES_DB_HOST}:${POSTGRES_DB_PORT}" >&2
    return 1
}

ensure_port_available() {
    if postgres_cluster_running; then
        return 0
    fi

    if command -v lsof >/dev/null 2>&1 && lsof -nP -iTCP:"${POSTGRES_DB_PORT}" -sTCP:LISTEN >/dev/null 2>&1; then
        echo "Port ${POSTGRES_DB_PORT} is already in use. Stop the conflicting PostgreSQL instance or change POSTGRES_DB_PORT." >&2
        return 1
    fi
}

db_init() {
    ensure_local_db_dirs
    ensure_cluster_version_compatible
    if postgres_cluster_initialized; then
        return 0
    fi

    "${INITDB_BIN}" \
        -D "${LOCAL_DB_DATA_DIR}" \
        -U "${POSTGRES_DB_USER}" \
        -A trust \
        --encoding=UTF8 >/dev/null

    cat >> "${LOCAL_DB_DATA_DIR}/postgresql.conf" <<EOF

# Project-managed local cluster
listen_addresses = '${POSTGRES_DB_HOST}'
port = ${POSTGRES_DB_PORT}
unix_socket_directories = '${LOCAL_DB_RUN_DIR}'
EOF
}

db_start() {
    ensure_local_db_dirs
    db_init
    ensure_port_available
    ensure_cluster_version_compatible

    if postgres_cluster_running; then
        return 0
    fi

    "${PG_CTL_BIN}" \
        -D "${LOCAL_DB_DATA_DIR}" \
        -l "${LOCAL_DB_LOG_FILE}" \
        start >/dev/null

    wait_for_postgres
    if ! db_ensure_database; then
        db_stop || true
        return 1
    fi
}

db_stop() {
    if ! postgres_cluster_running; then
        return 0
    fi

    "${PG_CTL_BIN}" -D "${LOCAL_DB_DATA_DIR}" stop -m fast >/dev/null
}

db_ensure_database() {
    if ! PGPASSWORD="${POSTGRES_DB_PASSWORD:-}" "${PSQL_BIN}" \
        -h "${POSTGRES_DB_HOST}" \
        -p "${POSTGRES_DB_PORT}" \
        -U "${POSTGRES_DB_USER}" \
        -d postgres \
        -Atqc "SELECT 1 FROM pg_database WHERE datname = '${POSTGRES_DB_NAME}'" | grep -q 1; then
        "${CREATEDB_BIN}" \
            -h "${POSTGRES_DB_HOST}" \
            -p "${POSTGRES_DB_PORT}" \
            -U "${POSTGRES_DB_USER}" \
            "${POSTGRES_DB_NAME}"
    fi

    "${PSQL_BIN}" \
        -h "${POSTGRES_DB_HOST}" \
        -p "${POSTGRES_DB_PORT}" \
        -U "${POSTGRES_DB_USER}" \
        -d "${POSTGRES_DB_NAME}" \
        -v ON_ERROR_STOP=1 \
        -c "CREATE EXTENSION IF NOT EXISTS postgis;" >/dev/null
}

db_print_env() {
    printf 'POSTGRES_ENABLED=true\n'
    printf 'DATABASE_URL=%s\n' "${DATABASE_URL:-${POSTGRES_DB_URL_DEFAULT}}"
    printf 'DB_APP_NAME=%s\n' "${DB_APP_NAME:-openspy-backend}"
}

db_status() {
    if postgres_cluster_running; then
        echo "running"
        return 0
    fi

    if postgres_cluster_initialized; then
        echo "stopped"
        return 0
    fi

    echo "uninitialized"
}
