#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HARNESS_ROOT="${OPENSPY_HARNESS_ROOT:-$(cd "$SCRIPT_DIR/.." && pwd)}"
ROOT_DIR="${OPENSPY_REPO_ROOT:-$(cd "$HARNESS_ROOT/.." && pwd)}"
TOOLS_DIR="${OPENSPY_AGENT_TOOLS_DIR:-$HARNESS_ROOT/tools}"

cmd="${1:-}"
shift || true

json_escape() {
  node -e 'let s=""; process.stdin.on("data", d => s += d); process.stdin.on("end", () => process.stdout.write(JSON.stringify(s)));'
}

emit_error() {
  local code="$1"
  local message="$2"
  local escaped
  escaped="$(printf '%s' "$message" | json_escape)"
  printf '{"status":"error","error":{"code":"%s","message":%s}}\n' "$code" "$escaped"
}

wrap_data() {
  local command_name="$1"
  node -e '
const command = process.argv[1];
let text = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => { text += chunk; });
process.stdin.on("end", () => {
  let data;
  try {
    data = text ? JSON.parse(text) : null;
  } catch (err) {
    console.log(JSON.stringify({
      status: "error",
      error: { code: "BAD_JSON_FROM_BACKEND", message: err.message },
      meta: { command, raw: text.slice(0, 2000) }
    }));
    process.exit(1);
  }
  console.log(JSON.stringify({
    status: data && typeof data.status === "string" ? data.status : "ok",
    data: data && typeof data === "object" && Object.prototype.hasOwnProperty.call(data, "data") ? data.data : data,
    ...(data && typeof data === "object" && data.error ? { error: data.error } : {}),
    meta: {
      ...((data && typeof data === "object" && data.meta && typeof data.meta === "object") ? data.meta : {}),
      command,
    },
    warnings: Array.isArray(data?.warnings) ? data.warnings : [],
  }));
});
' "$command_name"
}

enrich_geo_nearest_meta() {
  local effective_limit="$1"
  node -e '
const effectiveLimitRaw = process.argv[1] || "";
const limitProvided = effectiveLimitRaw !== "";
const effectiveLimit = limitProvided ? Number(effectiveLimitRaw) : null;
let text = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => { text += chunk; });
process.stdin.on("end", () => {
  let data;
  try {
    data = text ? JSON.parse(text) : null;
  } catch (err) {
    console.log(JSON.stringify({
      status: "error",
      error: { code: "BAD_JSON_FROM_SQL", message: err.message },
      meta: { command: "geo.nearest", raw: text.slice(0, 2000) }
    }));
    process.exit(1);
  }
  const meta = data && typeof data === "object" && data.meta && typeof data.meta === "object" ? data.meta : {};
  console.log(JSON.stringify({
    ...(data && typeof data === "object" ? data : {}),
    meta: {
      ...meta,
      command: "geo.nearest",
      effective_limit: effectiveLimit,
      limit_provided: limitProvided,
      capped: false,
    },
  }));
});
' "$effective_limit"
}

urlencode() {
  node -e 'process.stdout.write(encodeURIComponent(process.argv[1] || ""));' "$1"
}

get_arg() {
  local name="$1"
  shift
  while [[ $# -gt 0 ]]; do
    if [[ "$1" == "$name" ]]; then
      printf '%s' "${2:-}"
      return 0
    fi
    shift
  done
  return 0
}

build_query_string() {
  node -e '
const args = process.argv.slice(1);
const params = new URLSearchParams();
for (let i = 0; i < args.length; i++) {
  const key = args[i];
  if (!key.startsWith("--")) continue;
  const value = args[i + 1] && !args[i + 1].startsWith("--") ? args[++i] : "true";
  const name = key.slice(2);
  if (name === "kind" || name === "json" || name === "reason" || name === "sql") continue;
  params.set(name, value);
}
const out = params.toString();
process.stdout.write(out ? `?${out}` : "");
' -- "$@"
}

ensure_query_detail() {
  local query_string="$1"
  shift
  local detail
  detail="$(get_arg --detail "$@")"
  if [[ -n "$detail" ]]; then
    printf '%s' "$query_string"
    return 0
  fi
  if [[ -z "$query_string" ]]; then
    printf '?detail=compact'
  else
    printf '%s&detail=compact' "$query_string"
  fi
}

emit_diagnostics() {
  local mode="$1"
  local layer_filter="$2"
  local only_problematic="$3"
  local source_payload="$4"
  local layer_payload="$5"
  node - "$mode" "$layer_filter" "$only_problematic" "$source_payload" "$layer_payload" <<'NODE'
const [mode, layerFilter, onlyProblematicRaw, sourceText, layerText] = process.argv.slice(2);

function fail(code, message, meta = {}) {
  console.log(JSON.stringify({
    status: "error",
    error: { code, message },
    meta,
  }));
  process.exit(1);
}

function parseJson(text, name) {
  try {
    return JSON.parse(text);
  } catch (err) {
    fail("BAD_DIAGNOSTICS_INPUT", `Could not parse ${name} JSON: ${err.message}`);
  }
}

const sourceDoc = parseJson(sourceText, "source status");
const layerDoc = parseJson(layerText, "layer catalog");
const sourceRows = Array.isArray(sourceDoc.sources)
  ? sourceDoc.sources
  : Array.isArray(sourceDoc.data?.sources)
    ? sourceDoc.data.sources
    : Array.isArray(sourceDoc)
      ? sourceDoc
      : null;
const layers = Array.isArray(layerDoc)
  ? layerDoc
  : Array.isArray(layerDoc.data)
    ? layerDoc.data
    : null;

if (!sourceRows) fail("BAD_SOURCE_STATUS_SHAPE", "Source status response does not contain a sources array");
if (!layers) fail("BAD_LAYER_CATALOG_SHAPE", "Layer catalog response is not an array");

const sourcesByLayer = new Map();
for (const source of sourceRows) {
  const layerId = source.layerId || source.layer_id || "unknown";
  if (!sourcesByLayer.has(layerId)) sourcesByLayer.set(layerId, []);
  sourcesByLayer.get(layerId).push(source);
}

function normalizeStatus(value) {
  return String(value || "unknown").toLowerCase();
}

function normalizeCompleteness(value) {
  return String(value || "unknown").toLowerCase();
}

function isOkSource(source) {
  const status = normalizeStatus(source.status);
  const completeness = normalizeCompleteness(source.completeness);
  return ["completed", "ok", "success", "available"].includes(status)
    && ["complete", "ok", "available"].includes(completeness);
}

function sourceReason(source) {
  const status = normalizeStatus(source.status);
  const completeness = normalizeCompleteness(source.completeness);
  if (status === "auth_required") return `auth_required:${source.sourceId}`;
  if (status === "rate_limited") return `rate_limited:${source.sourceId}`;
  if (status === "unsupported") return `unsupported:${source.sourceId}`;
  if (status === "unavailable") return `source_unavailable:${source.sourceId}`;
  if (["error", "failed", "degraded"].includes(status)) return `source_${status}:${source.sourceId}`;
  if (!["complete", "ok", "available"].includes(completeness)) {
    return `incomplete:${source.sourceId}:${completeness}`;
  }
  return null;
}

function sumMetric(sources, key) {
  return sources.reduce((sum, source) => {
    const value = Number(source.latestIngest?.[key] ?? 0);
    return Number.isFinite(value) ? sum + value : sum;
  }, 0);
}

function maxIso(sources, key) {
  const values = sources
    .map((source) => source.latestIngest?.[key])
    .filter(Boolean)
    .sort();
  return values.at(-1) || null;
}

function summarizeLayer(layer) {
  const layerId = layer.layer_id || layer.layerId;
  const sources = sourcesByLayer.get(layerId) || [];
  const reasons = [];
  const sourceSummaries = sources.map((source) => {
    const reason = sourceReason(source);
    if (reason) reasons.push(reason);
    if (source.latestIngest?.errorMessage) reasons.push(`latest_error:${source.sourceId}`);
    return {
      source_id: source.sourceId,
      status: source.status || "unknown",
      completeness: source.completeness || "unknown",
      canonical_target: source.canonicalTarget || null,
      coverage_scope: source.coverageScope || null,
      raw_capture_mode: source.rawCaptureMode || null,
      storage_policy_id: source.storagePolicyId || null,
      latest_ingest: source.latestIngest ? {
        started_at: source.latestIngest.startedAt || null,
        completed_at: source.latestIngest.completedAt || null,
        upstream_bytes: source.latestIngest.upstreamBytes ?? null,
        raw_count: source.latestIngest.rawCount ?? null,
        normalized_count: source.latestIngest.normalizedCount ?? null,
        changed_count: source.latestIngest.changedCount ?? null,
        parse_ms: source.latestIngest.parseMs ?? null,
        db_write_ms: source.latestIngest.dbWriteMs ?? null,
        raw_persist_ms: source.latestIngest.rawPersistMs ?? null,
        total_ms: source.latestIngest.totalMs ?? null,
        render_batch_bytes: source.latestIngest.renderBatchBytes ?? null,
        error_message: source.latestIngest.errorMessage || null,
      } : null,
    };
  });

  const replay = Boolean(layer.capabilities?.replay);
  const coverageScope = layer.coverage_scope || layer.coverageScope || null;
  if (!replay) reasons.push("replay_disabled");
  if (coverageScope === "viewport") reasons.push("viewport_scope");
  if (sources.length === 0) reasons.push("no_source_status");

  const okCount = sources.filter(isOkSource).length;
  let status = "unknown";
  let completeness = "unknown";
  if (sources.length === 0) {
    status = "unknown";
    completeness = "unknown";
  } else if (okCount === sources.length) {
    status = "ok";
    completeness = "complete";
  } else if (okCount > 0) {
    status = "partial";
    completeness = "partial";
  } else {
    status = "unavailable";
    completeness = "unavailable";
  }

  return {
    layer_id: layerId,
    display_name: layer.display_name || layer.displayName || layerId,
    layer_type: layer.layer_type || layer.layerType || null,
    history_mode: layer.history_mode || layer.historyMode || null,
    coverage_scope: coverageScope,
    replay,
    status,
    completeness,
    reasons: [...new Set(reasons)],
    source_count: sources.length,
    ok_source_count: okCount,
    latest_completed_at: maxIso(sources, "completedAt"),
    ingest_totals: {
      upstream_bytes: sumMetric(sources, "upstreamBytes"),
      raw_count: sumMetric(sources, "rawCount"),
      normalized_count: sumMetric(sources, "normalizedCount"),
      changed_count: sumMetric(sources, "changedCount"),
      render_batch_bytes: sumMetric(sources, "renderBatchBytes"),
      total_ms: Number(sumMetric(sources, "totalMs").toFixed(2)),
    },
    sources: sourceSummaries,
  };
}

let layerStatuses = layers.map(summarizeLayer);
if (mode === "get_layer_status") {
  if (!layerFilter) fail("MISSING_LAYER", "diagnostics get_layer_status requires --layer");
  const item = layerStatuses.find((layer) => layer.layer_id === layerFilter);
  if (!item) {
    fail("LAYER_NOT_FOUND", `No layer found for ${layerFilter}`, {
      command: "diagnostics.get_layer_status",
      requested_layer: layerFilter,
      known_layer_count: layerStatuses.length,
    });
  }
  console.log(JSON.stringify({
    status: item.status === "ok" ? "ok" : "partial",
    data: item,
    meta: {
      command: "diagnostics.get_layer_status",
      source_status_updated_at: sourceDoc.updatedAt || null,
    },
  }));
  process.exit(0);
}

if (mode !== "list_layer_statuses") {
  fail("UNKNOWN_DIAGNOSTICS_MODE", `Unknown diagnostics mode: ${mode}`);
}

if (["1", "true", "yes"].includes(String(onlyProblematicRaw || "").toLowerCase())) {
  layerStatuses = layerStatuses.filter((layer) => layer.status !== "ok");
}

console.log(JSON.stringify({
  status: "ok",
  data: {
    updated_at: sourceDoc.updatedAt || null,
    layers: layerStatuses,
    totals: {
      layers: layerStatuses.length,
      ok: layerStatuses.filter((layer) => layer.status === "ok").length,
      partial: layerStatuses.filter((layer) => layer.status === "partial").length,
      unavailable: layerStatuses.filter((layer) => layer.status === "unavailable").length,
      unknown: layerStatuses.filter((layer) => layer.status === "unknown").length,
    },
  },
  meta: {
    command: "diagnostics.list_layer_statuses",
    source_count: sourceRows.length,
    only_problematic: ["1", "true", "yes"].includes(String(onlyProblematicRaw || "").toLowerCase()),
  },
}));
NODE
}

args_to_json() {
  node -e '
const args = process.argv.slice(1);
const out = {};
for (let i = 0; i < args.length; i++) {
  const key = args[i];
  if (!key.startsWith("--")) continue;
  const name = key.slice(2).replace(/-/g, "_");
  const value = args[i + 1] && !args[i + 1].startsWith("--") ? args[++i] : true;
  if (name === "json") {
    try {
      Object.assign(out, JSON.parse(String(value)));
    } catch (err) {
      console.log(JSON.stringify({ __bad_json: err.message }));
      process.exit(0);
    }
  } else if (name === "coordinates") {
    try {
      out[name] = JSON.parse(String(value));
    } catch {
      out[name] = String(value).split(";").map((pair) => pair.split(",").map(Number));
    }
  } else if (name === "geojson" || name === "metadata") {
    try {
      out[name] = JSON.parse(String(value));
    } catch {
      out[name] = value;
    }
  } else {
    out[name] = value;
  }
}
process.stdout.write(JSON.stringify(out));
' -- "$@"
}

emit_help() {
  local topic="${1:-root}"
  node -e '
const topic = process.argv[1] || "root";
const docs = {
  root: {
    usage: "worldview-cli.sh <command> ...",
    commands: ["catalog", "layers", "sources", "diagnostics", "coverage", "resolver", "geometry", "query", "geo", "selection", "legend", "view", "sql", "map", "replay", "source"],
    examples: [
      "worldview-cli.sh source capabilities",
      "worldview-cli.sh query aggregate --kind entities --layer vessel --bbox <west,south,east,north> --from <iso> --to <iso> --group_by hour",
      "worldview-cli.sh geo corridor --kind entities --layer vessel --coordinates \"[[lng,lat],[lng,lat]]\" --radius_m 50000 --from <iso> --to <iso>",
      "worldview-cli.sh selection create --json \"{...}\""
    ]
  },
  query: {
    usage: "worldview-cli.sh query <search|track|live-status|aggregate|timeline|related|satellite-overpasses> ...",
    examples: [
      "worldview-cli.sh query search --kind entities --layer vessel --bbox <west,south,east,north> --from <iso> --to <iso> --limit 20",
      "worldview-cli.sh query aggregate --kind entities --layer vessel --bbox <west,south,east,north> --from <iso> --to <iso> --group_by hour",
      "worldview-cli.sh query timeline --kind events --layer outage --bbox <west,south,east,north> --from <iso> --to <iso> --group_by hour"
    ]
  },
  replay: {
    usage: "worldview-cli.sh replay <state|track|evidence> ...",
    examples: [
      "worldview-cli.sh replay state --from <iso> --to <iso>",
      "worldview-cli.sh replay track --entity vessel:123 --from <iso> --to <iso>",
      "worldview-cli.sh replay evidence --entity vessel:123 --layer vessel --from <iso> --to <iso>"
    ]
  },
  geo: {
    usage: "worldview-cli.sh geo <nearest|corridor|spatial_join|simplify> ...",
    examples: [
      "worldview-cli.sh geo nearest --kind assets --layer cable --lat <lat> --lng <lng> --limit 20",
      "worldview-cli.sh geo corridor --kind entities --layer vessel --coordinates \"[[lng,lat],[lng,lat]]\" --radius_m 50000 --from <iso> --to <iso> --limit 20",
      "worldview-cli.sh geo spatial_join --moving_layer vessel --static_layer cable --bbox <west,south,east,north> --from <iso> --to <iso> --radius_m 2000 --limit 20",
      "worldview-cli.sh geo spatial_join --left_kind events --left_layer outage --right_kind assets --right_layer cable --radius_m 100000 --limit 20",
      "worldview-cli.sh geo simplify --kind assets --layer cable --tolerance_m 500 --limit 20"
    ]
  },
  "geo.corridor": {
    usage: "worldview-cli.sh geo corridor --kind <entities|events|assets> --coordinates \"[[lng,lat],[lng,lat]]\" [--layer <layer>] [--from <iso>] [--to <iso>] [--radius_m <meters>] [--limit <n>]",
    examples: [
      "worldview-cli.sh geo corridor --kind entities --layer vessel --coordinates \"[[24.0,59.4],[25.4,60.1]]\" --radius_m 50000 --from 2026-05-01T08:30:00Z --to 2026-05-02T08:30:00Z --limit 25"
    ]
  }
};
const doc = docs[topic] || docs.root;
console.log(JSON.stringify({ status: "ok", data: { topic, ...doc }, meta: { command: "help" }, warnings: [] }));
' "$topic"
}

if [[ -z "$cmd" ]]; then
  emit_help root
  exit 0
fi

case "$cmd" in
  help|--help|-h)
    emit_help "${1:-root}"
    ;;
  catalog)
    sub="${1:-describe}"
    shift || true
    case "$sub" in
      describe)
        layer="$(get_arg --layer "$@")"
        source="$(get_arg --source "$@")"
        query_parts=()
        if [[ -n "$layer" ]]; then query_parts+=("layer=$(urlencode "$layer")"); fi
        if [[ -n "$source" ]]; then query_parts+=("source=$(urlencode "$source")"); fi
        if [[ ${#query_parts[@]} -eq 0 ]]; then emit_error "MISSING_TARGET" "catalog describe requires --layer or --source"; exit 1; fi
        query_string="$(IFS='&'; printf '%s' "${query_parts[*]}")"
        "$TOOLS_DIR/backend-api.sh" GET "/api/agent-tools/catalog/describe?${query_string}" | wrap_data "catalog.describe"
        ;;
      *)
        emit_error "UNKNOWN_SUBCOMMAND" "Unknown catalog subcommand: $sub"
        exit 1
        ;;
    esac
    ;;
  layers)
    sub="${1:-list}"
    shift || true
    case "$sub" in
      list)
        "$TOOLS_DIR/backend-api.sh" GET /api/catalog/layers | wrap_data "layers.list"
        ;;
      describe)
        layer="$(get_arg --layer "$@")"
        if [[ -z "$layer" ]]; then emit_error "MISSING_LAYER" "layers describe requires --layer"; exit 1; fi
        "$TOOLS_DIR/backend-api.sh" GET "/api/catalog/layers/$(urlencode "$layer")" | wrap_data "layers.describe"
        ;;
      *)
        emit_error "UNKNOWN_SUBCOMMAND" "Unknown layers subcommand: $sub"
        exit 1
        ;;
    esac
    ;;
  sources)
    sub="${1:-list}"
    shift || true
    case "$sub" in
      list)
        "$TOOLS_DIR/backend-api.sh" GET /api/catalog/sources | wrap_data "sources.list"
        ;;
      describe)
        source="$(get_arg --source "$@")"
        if [[ -z "$source" ]]; then emit_error "MISSING_SOURCE" "sources describe requires --source"; exit 1; fi
        "$TOOLS_DIR/backend-api.sh" GET "/api/catalog/sources/$(urlencode "$source")" | wrap_data "sources.describe"
        ;;
      status)
        "$TOOLS_DIR/backend-api.sh" GET /api/status/sources | wrap_data "sources.status"
        ;;
      *)
        emit_error "UNKNOWN_SUBCOMMAND" "Unknown sources subcommand: $sub"
        exit 1
        ;;
    esac
    ;;
  diagnostics)
    sub="${1:-list_layer_statuses}"
    shift || true
    case "$sub" in
      list_layer_statuses)
        only_problematic="$(get_arg --only-problematic "$@")"
        if [[ -z "$only_problematic" ]]; then only_problematic="$(get_arg --only_problematic "$@")"; fi
        source_payload="$("$TOOLS_DIR/backend-api.sh" GET /api/status/sources)"
        layer_payload="$("$TOOLS_DIR/backend-api.sh" GET /api/catalog/layers)"
        emit_diagnostics "list_layer_statuses" "" "${only_problematic:-false}" "$source_payload" "$layer_payload"
        ;;
      get_layer_status)
        layer="$(get_arg --layer "$@")"
        if [[ -z "$layer" ]]; then emit_error "MISSING_LAYER" "diagnostics get_layer_status requires --layer"; exit 1; fi
        source_payload="$("$TOOLS_DIR/backend-api.sh" GET /api/status/sources)"
        layer_payload="$("$TOOLS_DIR/backend-api.sh" GET /api/catalog/layers)"
        emit_diagnostics "get_layer_status" "$layer" "false" "$source_payload" "$layer_payload"
        ;;
      *)
        emit_error "UNKNOWN_SUBCOMMAND" "Unknown diagnostics subcommand: $sub"
        exit 1
        ;;
    esac
    ;;
  coverage)
    sub="${1:-report}"
    shift || true
    case "$sub" in
      report)
        coverage_sql="$(cat <<'SQL'
WITH summary AS (
  SELECT layer_id, 'position_fixes' AS storage_kind, COUNT(*)::bigint AS record_count, MIN(observed_at) AS min_observed_at, MAX(observed_at) AS max_observed_at, COUNT(DISTINCT source_id)::bigint AS source_count
  FROM core.position_fixes
  WHERE observed_at IS NOT NULL
  GROUP BY layer_id
  UNION ALL
  SELECT layer_id, 'entity_live_states' AS storage_kind, COUNT(*)::bigint AS record_count, MIN(observed_at) AS min_observed_at, MAX(observed_at) AS max_observed_at, COUNT(DISTINCT source_id)::bigint AS source_count
  FROM app.entity_live_states
  WHERE observed_at IS NOT NULL
  GROUP BY layer_id
  UNION ALL
  SELECT layer_id, 'event_snapshots' AS storage_kind, COUNT(*)::bigint AS record_count, MIN(COALESCE(observed_at, valid_from, created_at)) AS min_observed_at, MAX(COALESCE(observed_at, valid_from, created_at)) AS max_observed_at, COUNT(DISTINCT source_id)::bigint AS source_count
  FROM core.event_snapshots
  WHERE COALESCE(observed_at, valid_from, created_at) IS NOT NULL
  GROUP BY layer_id
  UNION ALL
  SELECT layer_id, 'events' AS storage_kind, COUNT(*)::bigint AS record_count, MIN(COALESCE(observed_at, valid_from, created_at)) AS min_observed_at, MAX(COALESCE(observed_at, valid_from, created_at)) AS max_observed_at, COUNT(DISTINCT source_id)::bigint AS source_count
  FROM core.events
  WHERE COALESCE(observed_at, valid_from, created_at) IS NOT NULL
  GROUP BY layer_id
  UNION ALL
  SELECT layer_id, 'asset_snapshots' AS storage_kind, COUNT(*)::bigint AS record_count, MIN(COALESCE(observed_at, created_at)) AS min_observed_at, MAX(COALESCE(observed_at, created_at)) AS max_observed_at, COUNT(DISTINCT source_id)::bigint AS source_count
  FROM core.asset_snapshots
  WHERE COALESCE(observed_at, created_at) IS NOT NULL
  GROUP BY layer_id
  UNION ALL
  SELECT layer_id, 'assets' AS storage_kind, COUNT(*)::bigint AS record_count, MIN(COALESCE(last_observed_at, updated_at, created_at)) AS min_observed_at, MAX(COALESCE(last_observed_at, updated_at, created_at)) AS max_observed_at, COUNT(DISTINCT source_id)::bigint AS source_count
  FROM core.assets
  WHERE COALESCE(last_observed_at, updated_at, created_at) IS NOT NULL
  GROUP BY layer_id
  UNION ALL
  SELECT layer_id, 'observations' AS storage_kind, COUNT(*)::bigint AS record_count, MIN(observed_at) AS min_observed_at, MAX(observed_at) AS max_observed_at, COUNT(DISTINCT source_id)::bigint AS source_count
  FROM core.observations
  WHERE observed_at IS NOT NULL
  GROUP BY layer_id
  UNION ALL
  SELECT COALESCE(layer_id, 'satellite') AS layer_id, 'orbital_elements' AS storage_kind, COUNT(*)::bigint AS record_count, MIN(observed_at) AS min_observed_at, MAX(observed_at) AS max_observed_at, COUNT(DISTINCT source_id)::bigint AS source_count
  FROM core.orbital_elements
  WHERE observed_at IS NOT NULL
  GROUP BY COALESCE(layer_id, 'satellite')
)
SELECT
  l.layer_id,
  l.display_name,
  l.layer_type,
  l.history_mode,
  l.coverage_scope,
  l.capabilities,
  s.storage_kind,
  CASE
    WHEN s.storage_kind = 'orbital_elements' THEN 'computed_replay_input'
    WHEN s.storage_kind IN ('position_fixes', 'event_snapshots', 'asset_snapshots', 'observations') THEN 'local_history'
    WHEN s.storage_kind IN ('entity_live_states', 'events', 'assets') THEN 'current_or_static'
    ELSE 'unknown'
  END AS coverage_role,
  s.record_count,
  s.source_count,
  s.min_observed_at,
  s.max_observed_at,
  date_trunc('hour', s.max_observed_at) AS recommended_hour_start,
  date_trunc('day', s.max_observed_at) AS recommended_day_start,
  'latest_observed_window' AS recommendation_kind
FROM summary s
JOIN catalog.layers l ON l.layer_id = s.layer_id
ORDER BY l.layer_id, s.storage_kind
SQL
)"
        "$TOOLS_DIR/sql-readonly.sh" \
          --reason "agent data coverage report for choosing real replay test windows" \
          --limit 5000 \
          --timeout-ms 30000 \
          --sql "$coverage_sql"
        ;;
      *)
        emit_error "UNKNOWN_SUBCOMMAND" "Unknown coverage subcommand: $sub"
        exit 1
        ;;
    esac
    ;;
  query)
    sub="${1:-}"
    shift || true
    case "$sub" in
      ""|help|--help|-h)
        emit_help query
        ;;
      search)
        kind="$(get_arg --kind "$@")"
        query_string="$(build_query_string "$@")"
        query_string="$(ensure_query_detail "$query_string" "$@")"
        case "$kind" in
          entities|entity)
            "$TOOLS_DIR/backend-api.sh" GET "/api/query/entities/latest${query_string}" | wrap_data "query.search.entities"
            ;;
          events|event)
            "$TOOLS_DIR/backend-api.sh" GET "/api/query/events/latest${query_string}" | wrap_data "query.search.events"
            ;;
          assets|asset)
            "$TOOLS_DIR/backend-api.sh" GET "/api/query/assets/latest${query_string}" | wrap_data "query.search.assets"
            ;;
          *)
            emit_error "BAD_KIND" "query search requires --kind entities|events|assets"
            exit 1
            ;;
        esac
        ;;
      track)
        entity="$(get_arg --entity "$@")"
        if [[ -z "$entity" ]]; then entity="$(get_arg --entity_id "$@")"; fi
        if [[ -z "$entity" ]]; then entity="$(get_arg --entity-id "$@")"; fi
        if [[ -z "$entity" ]]; then emit_error "MISSING_ENTITY" "query track requires --entity"; exit 1; fi
        query_string="$(build_query_string "$@")"
        "$TOOLS_DIR/backend-api.sh" GET "/api/query/entities/$(urlencode "$entity")/track${query_string}" | wrap_data "query.track"
        ;;
      live-status|live_status)
        query_string="$(build_query_string "$@")"
        "$TOOLS_DIR/backend-api.sh" GET "/api/query/entities/live-status${query_string}" | wrap_data "query.live-status"
        ;;
      aggregate)
        body="$(args_to_json "$@")"
        if printf '%s' "$body" | grep -q '"__bad_json"'; then emit_error "BAD_JSON" "query aggregate received invalid --json"; exit 1; fi
        "$TOOLS_DIR/backend-api.sh" POST /api/agent-tools/query/aggregate "$body" | wrap_data "query.aggregate"
        ;;
      timeline)
        body="$(args_to_json "$@")"
        if printf '%s' "$body" | grep -q '"__bad_json"'; then emit_error "BAD_JSON" "query timeline received invalid --json"; exit 1; fi
        "$TOOLS_DIR/backend-api.sh" POST /api/agent-tools/query/timeline "$body" | wrap_data "query.timeline"
        ;;
      related)
        body="$(args_to_json "$@")"
        if printf '%s' "$body" | grep -q '"__bad_json"'; then emit_error "BAD_JSON" "query related received invalid --json"; exit 1; fi
        "$TOOLS_DIR/backend-api.sh" POST /api/agent-tools/query/related "$body" | wrap_data "query.related"
        ;;
      satellite-overpasses|satellite_overpasses|satellite.overpasses)
        body="$(args_to_json "$@")"
        if printf '%s' "$body" | grep -q '"__bad_json"'; then emit_error "BAD_JSON" "query satellite-overpasses received invalid --json"; exit 1; fi
        "$TOOLS_DIR/backend-api.sh" POST /api/agent-tools/query/satellite-overpasses "$body" | wrap_data "query.satellite-overpasses"
        ;;
      *)
        emit_error "UNKNOWN_SUBCOMMAND" "Unknown query subcommand: $sub"
        exit 1
        ;;
    esac
    ;;
  resolver)
    sub="${1:-}"
    shift || true
    case "$sub" in
      region|region.resolve)
        body="$(args_to_json "$@")"
        "$TOOLS_DIR/backend-api.sh" POST /api/agent-tools/resolve/region "$body" | wrap_data "resolver.region"
        ;;
      entity|entity.resolve)
        body="$(args_to_json "$@")"
        "$TOOLS_DIR/backend-api.sh" POST /api/agent-tools/resolve/entity "$body" | wrap_data "resolver.entity"
        ;;
      *)
        emit_error "UNKNOWN_SUBCOMMAND" "Unknown resolver subcommand: $sub"
        exit 1
        ;;
    esac
    ;;
  geometry)
    sub="${1:-}"
    shift || true
    case "$sub" in
      create_aoi|aoi)
        body="$(args_to_json "$@")"
        "$TOOLS_DIR/backend-api.sh" POST /api/agent-tools/geometry/aoi "$body" | wrap_data "geometry.create_aoi"
        ;;
      *)
        emit_error "UNKNOWN_SUBCOMMAND" "Unknown geometry subcommand: $sub"
        exit 1
        ;;
    esac
    ;;
  selection)
    sub="${1:-}"
    shift || true
    case "$sub" in
      create)
        body="$(get_arg --json "$@")"
        if [[ -z "$body" ]]; then emit_error "MISSING_JSON" "selection create requires --json"; exit 1; fi
        "$TOOLS_DIR/backend-api.sh" POST /api/selections "$body" | wrap_data "selection.create"
        ;;
      get)
        selection_id="$(get_arg --selection "$@")"
        if [[ -z "$selection_id" ]]; then emit_error "MISSING_SELECTION" "selection get requires --selection"; exit 1; fi
        "$TOOLS_DIR/backend-api.sh" GET "/api/selections/$(urlencode "$selection_id")" | wrap_data "selection.get"
        ;;
      patch)
        selection_id="$(get_arg --selection "$@")"
        body="$(get_arg --json "$@")"
        if [[ -z "$selection_id" || -z "$body" ]]; then emit_error "MISSING_SELECTION_PATCH" "selection patch requires --selection and --json"; exit 1; fi
        "$TOOLS_DIR/backend-api.sh" POST "/api/selections/$(urlencode "$selection_id")/patch" "$body" | wrap_data "selection.patch"
        ;;
      preview)
        selection_id="$(get_arg --selection "$@")"
        if [[ -z "$selection_id" ]]; then emit_error "MISSING_SELECTION" "selection preview requires --selection"; exit 1; fi
        "$TOOLS_DIR/backend-api.sh" GET "/api/agent-tools/selections/$(urlencode "$selection_id")/preview" | wrap_data "selection.preview"
        ;;
      materialize)
        selection_id="$(get_arg --selection "$@")"
        if [[ -z "$selection_id" ]]; then emit_error "MISSING_SELECTION" "selection materialize requires --selection"; exit 1; fi
        body="$(args_to_json "$@")"
        "$TOOLS_DIR/backend-api.sh" POST "/api/agent-tools/selections/$(urlencode "$selection_id")/materialize" "$body" | wrap_data "selection.materialize"
        ;;
      items)
        selection_id="$(get_arg --selection "$@")"
        limit="$(get_arg --limit "$@")"
        offset="$(get_arg --offset "$@")"
        if [[ -z "$selection_id" ]]; then emit_error "MISSING_SELECTION" "selection items requires --selection"; exit 1; fi
        query=""
        if [[ -n "$limit" ]]; then query="${query}limit=$(urlencode "$limit")"; fi
        if [[ -n "$offset" ]]; then
          if [[ -n "$query" ]]; then query="${query}&"; fi
          query="${query}offset=$(urlencode "$offset")"
        fi
        path="/api/agent-tools/selections/$(urlencode "$selection_id")/items"
        if [[ -n "$query" ]]; then path="${path}?${query}"; fi
        "$TOOLS_DIR/backend-api.sh" GET "$path" | wrap_data "selection.items"
        ;;
      apply)
        layer="$(get_arg --layer "$@")"
        selection_id="$(get_arg --selection "$@")"
        mode="$(get_arg --mode "$@")"
        if [[ -z "$layer" || -z "$selection_id" ]]; then emit_error "MISSING_SELECTION" "selection apply requires --layer and --selection"; exit 1; fi
        body="$(node -e 'process.stdout.write(JSON.stringify({ layer: process.argv[1], selectionId: process.argv[2], mode: process.argv[3] || "only" }));' "$layer" "$selection_id" "${mode:-only}")"
        "$TOOLS_DIR/backend-api.sh" POST /api/map/apply-selection "$body" | wrap_data "selection.apply"
        ;;
      clear)
        layer="$(get_arg --layer "$@")"
        if [[ -z "$layer" ]]; then emit_error "MISSING_LAYER" "selection clear requires --layer"; exit 1; fi
        body="$(node -e 'process.stdout.write(JSON.stringify({ layer: process.argv[1] }));' "$layer")"
        "$TOOLS_DIR/backend-api.sh" POST /api/map/clear-selection "$body" | wrap_data "selection.clear"
        ;;
      *)
        emit_error "UNKNOWN_SUBCOMMAND" "Unknown selection subcommand: $sub"
        exit 1
        ;;
    esac
    ;;
  legend)
    sub="${1:-tree}"
    shift || true
    case "$sub" in
      tree|get_tree)
        "$TOOLS_DIR/backend-api.sh" GET /api/legend/tree | wrap_data "legend.tree"
        ;;
      describe_node|get_node)
        node="$(get_arg --node "$@")"
        if [[ -z "$node" ]]; then node="$(get_arg --id "$@")"; fi
        if [[ -z "$node" ]]; then emit_error "MISSING_NODE" "legend describe_node requires --node"; exit 1; fi
        "$TOOLS_DIR/backend-api.sh" GET "/api/legend/node?id=$(urlencode "$node")" | wrap_data "legend.describe_node"
        ;;
      set_node_state)
        node="$(get_arg --node "$@")"
        enabled="$(get_arg --enabled "$@")"
        target="$(get_arg --target "$@")"
        if [[ -z "$node" || -z "$enabled" ]]; then emit_error "MISSING_NODE_STATE" "legend set_node_state requires --node and --enabled"; exit 1; fi
        body="$(node -e 'process.stdout.write(JSON.stringify({ nodeId: process.argv[1], enabled: ["1","true","yes","on"].includes(String(process.argv[2]).toLowerCase()), target: process.argv[3] || "visibility" }));' "$node" "$enabled" "${target:-visibility}")"
        "$TOOLS_DIR/backend-api.sh" POST /api/view-state/legend-node-state "$body" | wrap_data "legend.set_node_state"
        ;;
      *)
        emit_error "UNKNOWN_SUBCOMMAND" "Unknown legend subcommand: $sub"
        exit 1
        ;;
    esac
    ;;
  view)
    sub="${1:-get}"
    shift || true
    case "$sub" in
      get|get_state)
        "$TOOLS_DIR/backend-api.sh" GET /api/view-state | wrap_data "view.get_state"
        ;;
      summary)
        "$TOOLS_DIR/backend-api.sh" GET /api/agent-tools/view/summary | wrap_data "view.summary"
        ;;
      request_context|request-context|current_request_context|current-view|current_view)
        run_id="$(get_arg --run-id "$@")"
        if [[ -z "$run_id" ]]; then run_id="$(get_arg --run_id "$@")"; fi
        if [[ -z "$run_id" ]]; then run_id="${AGENT_RUN_ID:-}"; fi
        query_parts=()
        if [[ -n "$run_id" ]]; then query_parts+=("run_id=$(urlencode "$run_id")"); fi
        query_string=""
        if [[ ${#query_parts[@]} -gt 0 ]]; then
          query_string="$(IFS='&'; printf '%s' "${query_parts[*]}")"
        fi
        if [[ -n "$query_string" ]]; then
          "$TOOLS_DIR/backend-api.sh" GET "/api/agent-tools/view/request-context?${query_string}" | wrap_data "view.request_context"
        else
          "$TOOLS_DIR/backend-api.sh" GET /api/agent-tools/view/request-context | wrap_data "view.request_context"
        fi
        ;;
      patch)
        body="$(get_arg --json "$@")"
        if [[ -z "$body" ]]; then body="$(args_to_json "$@")"; fi
        "$TOOLS_DIR/backend-api.sh" POST /api/view-state/patch "$body" | wrap_data "view.patch"
        ;;
      *)
        emit_error "UNKNOWN_SUBCOMMAND" "Unknown view subcommand: $sub"
        exit 1
        ;;
    esac
    ;;
  sql)
    sub="${1:-}"
    shift || true
    case "$sub" in
      query)
        "$TOOLS_DIR/sql-readonly.sh" "$@"
        ;;
      *)
        emit_error "UNKNOWN_SUBCOMMAND" "Unknown sql subcommand: $sub"
        exit 1
        ;;
    esac
    ;;
  map)
    "$TOOLS_DIR/map-command.sh" "$@"
    ;;
  replay)
    sub="${1:-}"
    shift || true
    case "$sub" in
      state)
        query_string="$(build_query_string "$@")"
        "$TOOLS_DIR/backend-api.sh" GET "/api/replay/state${query_string}" | wrap_data "replay.state"
        ;;
      track)
        entity="$(get_arg --entity "$@")"
        if [[ -z "$entity" ]]; then emit_error "MISSING_ENTITY" "replay track requires --entity"; exit 1; fi
        query_string="$(build_query_string "$@")"
        "$TOOLS_DIR/backend-api.sh" GET "/api/replay/track/$(urlencode "$entity")${query_string}" | wrap_data "replay.track"
        ;;
      evidence|moving-evidence|moving_evidence|validate-moving|validate_moving)
        entity="$(get_arg --entity "$@")"
        if [[ -z "$entity" ]]; then entity="$(get_arg --entity_id "$@")"; fi
        if [[ -z "$entity" ]]; then entity="$(get_arg --entity-id "$@")"; fi
        layer="$(get_arg --layer "$@")"
        if [[ -z "$layer" ]]; then layer="$(get_arg --layer_id "$@")"; fi
        if [[ -z "$layer" ]]; then layer="$(get_arg --layer-id "$@")"; fi
        from_ts="$(get_arg --from "$@")"
        to_ts="$(get_arg --to "$@")"
        if [[ -z "$entity" ]]; then emit_error "MISSING_ENTITY" "replay evidence requires --entity"; exit 1; fi
        if [[ -z "$layer" ]]; then layer="${entity%%:*}"; fi
        if [[ "$layer" == "maritime" || "$layer" == "vessels" ]]; then layer="vessel"; fi
        if [[ "$layer" == "aviation" || "$layer" == "air" || "$layer" == "aircrafts" ]]; then layer="aircraft"; fi
        if [[ "$layer" == "satellites" || "$layer" == "space" ]]; then layer="satellite"; fi
        if [[ -z "$from_ts" || -z "$to_ts" ]]; then emit_error "MISSING_WINDOW" "replay evidence requires --from and --to"; exit 1; fi
        if [[ ! "$entity" =~ ^[A-Za-z0-9:_./-]+$ ]]; then emit_error "BAD_ENTITY" "replay evidence entity contains unsupported characters"; exit 1; fi
        if [[ ! "$layer" =~ ^[A-Za-z0-9_-]+$ ]]; then emit_error "BAD_LAYER" "replay evidence layer contains unsupported characters"; exit 1; fi
        evidence_sql="$(node - "$entity" "$layer" "$from_ts" "$to_ts" <<'NODE'
const [entityId, layerId, fromTs, toTs] = process.argv.slice(2);
function lit(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}
process.stdout.write(`WITH fixes AS (
  SELECT pf.entity_id,
         pf.layer_id,
         pf.observed_at,
         pf.geom
  FROM core.position_fixes pf
  WHERE pf.entity_id = ${lit(entityId)}
    AND pf.layer_id = ${lit(layerId)}
    AND pf.observed_at >= ${lit(fromTs)}::timestamptz
    AND pf.observed_at <= ${lit(toTs)}::timestamptz
)
SELECT ${lit(entityId)} AS entity_id,
       ${lit(layerId)} AS layer_id,
       ${lit(fromTs)}::timestamptz AS window_from,
       ${lit(toTs)}::timestamptz AS window_to,
       COUNT(*)::int AS fix_count,
       (COUNT(*) >= 2) AS has_motion,
       MIN(observed_at) AS first_fix_at,
       MAX(observed_at) AS last_fix_at,
       ST_Y((ARRAY_AGG(geom ORDER BY observed_at ASC))[1]) AS first_lat,
       ST_X((ARRAY_AGG(geom ORDER BY observed_at ASC))[1]) AS first_lng,
       ST_Y((ARRAY_AGG(geom ORDER BY observed_at DESC))[1]) AS last_lat,
       ST_X((ARRAY_AGG(geom ORDER BY observed_at DESC))[1]) AS last_lng
FROM fixes;
`);
NODE
)"
        "$TOOLS_DIR/sql-readonly.sh" \
          --reason "validate moving entity replay evidence for exact final replay window" \
          --timeout-ms 30000 \
          --sql "$evidence_sql" | wrap_data "replay.evidence"
        ;;
      *)
        emit_error "UNKNOWN_SUBCOMMAND" "Unknown replay subcommand: $sub"
        exit 1
        ;;
    esac
    ;;
  source)
    "$TOOLS_DIR/source-fetch.sh" "$@"
    ;;
  geo)
    sub="${1:-}"
    shift || true
    case "$sub" in
      ""|help|--help|-h)
        emit_help geo
        ;;
      nearest)
        kind="$(get_arg --kind "$@")"
        lat="$(get_arg --lat "$@")"
        lng="$(get_arg --lng "$@")"
        layer="$(get_arg --layer "$@")"
        limit="$(get_arg --limit "$@")"
        if [[ -z "$kind" || -z "$lat" || -z "$lng" ]]; then
          emit_error "MISSING_ARGS" "geo nearest requires --kind assets|entities|events --lat --lng"
          exit 1
        fi
        if [[ ! "$lat" =~ ^-?[0-9]+([.][0-9]+)?$ || ! "$lng" =~ ^-?[0-9]+([.][0-9]+)?$ ]]; then
          emit_error "BAD_COORDINATES" "lat/lng must be decimal numbers"
          exit 1
        fi
        limit_clause=""
        limit_args=()
        if [[ -n "$limit" ]]; then
          if [[ ! "$limit" =~ ^[0-9]+$ ]]; then emit_error "BAD_LIMIT" "limit must be an integer"; exit 1; fi
          if (( limit < 1 )); then emit_error "BAD_LIMIT" "limit must be a positive integer"; exit 1; fi
          limit_clause="LIMIT ${limit}"
          limit_args=(--limit "$limit")
        fi
        layer_filter=""
        if [[ -n "$layer" ]]; then
          safe_layer="$(printf '%s' "$layer" | sed "s/'/''/g")"
          layer_filter="AND layer_id = '${safe_layer}'"
        fi
        point_sql="ST_SetSRID(ST_MakePoint(${lng}, ${lat}), 4326)"
        case "$kind" in
          assets|asset)
            nearest_sql="SELECT asset_id AS id, layer_id, source_id, asset_kind AS kind, subtype, display_name, ST_Y(ST_PointOnSurface(geom)) AS lat, ST_X(ST_PointOnSurface(geom)) AS lng, ST_Distance(geom::geography, ${point_sql}::geography) AS distance_m, properties FROM core.assets WHERE geom IS NOT NULL ${layer_filter} ORDER BY geom <-> ${point_sql} ${limit_clause}"
            ;;
          events|event)
            nearest_sql="SELECT event_id AS id, layer_id, source_id, event_kind AS kind, subtype, ST_Y(ST_PointOnSurface(geom)) AS lat, ST_X(ST_PointOnSurface(geom)) AS lng, ST_Distance(geom::geography, ${point_sql}::geography) AS distance_m, properties FROM core.events WHERE geom IS NOT NULL ${layer_filter} ORDER BY geom <-> ${point_sql} ${limit_clause}"
            ;;
          entities|entity)
            if [[ -n "$layer" ]]; then
              safe_layer="$(printf '%s' "$layer" | sed "s/'/''/g")"
              entity_layer_filter="AND e.layer_id = '${safe_layer}'"
            else
              entity_layer_filter=""
            fi
            nearest_sql="SELECT e.entity_id AS id, e.layer_id, e.source_id, e.entity_kind AS kind, e.subtype, e.display_name, ST_Y(p.geom) AS lat, ST_X(p.geom) AS lng, ST_Distance(p.geom::geography, ${point_sql}::geography) AS distance_m, e.properties FROM core.entities e JOIN app.entity_live_states p ON p.entity_id = e.entity_id WHERE p.geom IS NOT NULL ${entity_layer_filter} ORDER BY p.geom <-> ${point_sql} ${limit_clause}"
            ;;
          *)
            emit_error "BAD_KIND" "geo nearest --kind must be assets, entities, or events"
            exit 1
            ;;
        esac
        "$TOOLS_DIR/sql-readonly.sh" --reason "geo nearest ${kind} from ${lat},${lng}" "${limit_args[@]}" --sql "$nearest_sql" | enrich_geo_nearest_meta "$limit"
        ;;
      corridor)
        if [[ $# -eq 0 ]]; then
          emit_help "geo.corridor"
          exit 0
        fi
        body="$(args_to_json "$@")"
        "$TOOLS_DIR/backend-api.sh" POST /api/agent-tools/geo/corridor "$body" | wrap_data "geo.corridor"
        ;;
      spatial_join|spatial-join)
        body="$(args_to_json "$@")"
        "$TOOLS_DIR/backend-api.sh" POST /api/agent-tools/geo/spatial-join "$body" | wrap_data "geo.spatial_join"
        ;;
      simplify|simplified_geometry)
        body="$(args_to_json "$@")"
        "$TOOLS_DIR/backend-api.sh" POST /api/agent-tools/geo/simplify "$body" | wrap_data "geo.simplify"
        ;;
      *)
        emit_error "UNKNOWN_SUBCOMMAND" "Unknown geo subcommand: $sub"
        exit 1
        ;;
    esac
    ;;
  *)
    emit_error "UNKNOWN_COMMAND" "Unknown command: $cmd"
    exit 1
    ;;
esac
