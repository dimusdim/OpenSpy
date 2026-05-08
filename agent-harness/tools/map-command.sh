#!/usr/bin/env bash
set -euo pipefail

command="${1:-}"
shift || true

emit_help() {
  local topic="${1:-map-command}"
  node -e '
const topic = process.argv[1] || "map-command";
console.log(JSON.stringify({
  status: "ok",
  data: {
    topic,
    usage: "map-command.sh <command> [flags]",
    purpose: "Backend-backed OpenSpy map/view/replay mutations and command diagnostics.",
    boundary: {
      map_command: "Use for backend-backed view-state changes such as selection.apply, selection.clear, layer.filter, legend.set_node_state, view.patch, map.set_layers and source.set_enabled.",
      actions_json: "Use ACTIONS_JSON for browser presentation actions such as map.fly_to, object.open, track.draw, track.animate, imagery.show_scene and replay.play_window."
    },
    common_flags: {
      "--json <object>": "Structured command payload when supported by the backend command",
      "--layer <layer>": "Layer key for layer/selection commands",
      "--selection <selection_id>": "Saved selection handle",
      "--mode <only|add|remove>": "Selection application mode",
      "--at <iso>": "Replay seek timestamp"
    },
    examples: [
      "map-command.sh replay.seek --at 2026-04-01T12:00:00Z",
      "map-command.sh selection.apply --layer vessel --selection sel:hormuz:vessels --mode only",
      "map-command.sh map.set_layers --json \"{...}\""
    ]
  },
  meta: { command: "map-command.help" },
  warnings: []
}));
' "$topic"
}

if [[ -z "$command" ]]; then
  emit_help map-command
  exit 0
fi

case "$command" in
  help|--help|-h)
    emit_help "${1:-map-command}"
    exit 0
    ;;
esac

for arg in "$@"; do
  case "$arg" in
    help|--help|-h)
      emit_help "$command"
      exit 0
      ;;
  esac
done

if [[ "$command" == --* ]]; then
  emit_help map-command
  exit 0
fi

body="$(node -e '
const command = process.argv[1];
const args = process.argv.slice(2);
const payload = {};
for (let i = 0; i < args.length; i++) {
  const key = args[i];
  if (!key.startsWith("--")) continue;
  const name = key.slice(2).replace(/-/g, "_");
  const value = args[i + 1] && !args[i + 1].startsWith("--") ? args[++i] : true;
  if (name === "json") {
    try {
      const parsed = JSON.parse(String(value || "{}"));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        Object.assign(payload, parsed);
      }
    } catch (err) {
      console.log(JSON.stringify({
        status: "error",
        error: { code: "BAD_JSON", message: err instanceof Error ? err.message : "Invalid --json payload" },
        meta: { command }
      }));
      process.exit(2);
    }
  } else {
    payload[name] = value;
  }
}
if (payload.selection && !payload.selection_id) payload.selection_id = payload.selection;
if (payload.selectionId && !payload.selection_id) payload.selection_id = payload.selectionId;
if (payload.selection_id && !payload.selectionId) payload.selectionId = payload.selection_id;
if (payload.layer_id && !payload.layer) payload.layer = payload.layer_id;
if (payload.layerId && !payload.layer) payload.layer = payload.layerId;
if (typeof payload.mode === "string") {
  const mode = payload.mode.toLowerCase();
  if (mode === "add") payload.mode = "append";
  else if (mode === "remove") payload.mode = "exclude";
}
process.stdout.write(JSON.stringify({ command, payload }));
' "$command" "$@")"

exec "$(dirname "$0")/backend-api.sh" POST /api/agent-tools/map-command "$body"
