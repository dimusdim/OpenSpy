#!/usr/bin/env bash
set -euo pipefail

real_shell="/bin/bash"
command_text=""
args=("$@")
saw_command_option=false

for ((i = 0; i < ${#args[@]}; i += 1)); do
  arg="${args[$i]}"
  if [[ "$arg" == "--" ]]; then
    if [[ "$saw_command_option" == true ]]; then
      next_index=$((i + 1))
      if (( next_index < ${#args[@]} )); then
        command_text="${args[$next_index]}"
      fi
      break
    fi
    continue
  fi
  if [[ "$saw_command_option" == false && "$arg" == -* && "$arg" != --* ]]; then
    if [[ "$arg" == *c* ]]; then
      saw_command_option=true
    fi
    continue
  fi
  if [[ "$saw_command_option" == true ]]; then
    if [[ "$arg" == -* && "$arg" != --* ]]; then
      continue
    fi
    command_text="$arg"
    break
  fi
done

if [[ -z "$command_text" ]]; then
  exec "$real_shell" "$@"
fi

node - "$command_text" <<'NODE'
const command = String(process.argv[2] || '').trim();

function fail(message) {
  process.stderr.write(`AI Worldview bash guard: ${message}\n`);
  process.exit(126);
}

function hasControlOperator(input) {
  let quote = null;
  let escaped = false;
  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i];
    const next = input[i + 1];

    if (escaped) {
      escaped = false;
      continue;
    }

    if (ch === '\\') {
      escaped = true;
      continue;
    }

    if (ch === '`') return true;
    if (ch === '$' && next === '(') return true;

    if (quote === "'") {
      if (ch === "'") quote = null;
      continue;
    }

    if (quote === '"') {
      if (ch === '"') quote = null;
      continue;
    }

    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }

    if (ch === ';' || ch === '\n' || ch === '\r' || ch === '&' || ch === '|' || ch === '<' || ch === '>') {
      return true;
    }
  }
  return false;
}

const allowed = [
  /^\.\/tools\/worldview-cli\.sh(?:\s|$)/,
  /^\.\/tools\/(?:backend-api|sql-readonly|source-fetch|map-command)\.sh(?:\s|$)/,
];

function shellUnescapeSingleQuotedEval(value) {
  return value
    .replace(/'\\''/g, "'")
    .replace(/'"'"'/g, "'");
}

function claudeEvalPayload(input) {
  const prefix = "shopt -u extglob 2>/dev/null || true && eval '";
  const suffix = input.match(/'(?: < \/dev\/null)? && pwd -P >\| \/tmp\/claude-[A-Za-z0-9_-]+-cwd$/);
  if (!input.startsWith(prefix) || !suffix) return null;
  return shellUnescapeSingleQuotedEval(input.slice(prefix.length, input.length - suffix[0].length));
}

function validateApprovedCommand(value) {
  if (!allowed.some((pattern) => pattern.test(value))) {
    fail(`command is not an approved AI Worldview entrypoint: ${value}`);
  }

  if (hasControlOperator(value)) {
    fail('shell control operators are not allowed in agent commands');
  }
}

const payload = claudeEvalPayload(command);
validateApprovedCommand(payload || command);

if (!payload && hasControlOperator(command)) {
  fail('shell control operators are not allowed in agent commands');
}
NODE

exec "$real_shell" "$@"
