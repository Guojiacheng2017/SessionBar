#!/bin/bash
STATUS="${1:-working}"
TASK="${2:-Active}"
SERVER_PORT="${3:-8989}"

AGENT_SLUG="${SESSIONBAR_AGENT:-${AGENTBAR_AGENT:-claude}}"
AGENT_SLUG=$(printf '%s' "$AGENT_SLUG" | tr '[:upper:]' '[:lower:]' | tr -cd 'a-z0-9_-')
if [ -z "$AGENT_SLUG" ]; then
  AGENT_SLUG="agent"
fi

case "$AGENT_SLUG" in
  claude) DEFAULT_SESSION_TYPE="Claude Code" ;;
  codex) DEFAULT_SESSION_TYPE="Codex" ;;
  gemini) DEFAULT_SESSION_TYPE="Gemini CLI" ;;
  copilot) DEFAULT_SESSION_TYPE="Copilot" ;;
  opencode) DEFAULT_SESSION_TYPE="OpenCode" ;;
  pi) DEFAULT_SESSION_TYPE="Pi" ;;
  *) DEFAULT_SESSION_TYPE="$AGENT_SLUG" ;;
esac

SESSION_TYPE="${SESSIONBAR_SESSION_TYPE:-${AGENTBAR_SESSION_TYPE:-$DEFAULT_SESSION_TYPE}}"
PROJECT_DIR="${SESSIONBAR_PROJECT_DIR:-${AGENTBAR_PROJECT_DIR:-${CLAUDE_PROJECT_DIR:-$(pwd)}}}"
EXPLICIT_SESSION_ID="${SESSIONBAR_SESSION_ID:-${AGENTBAR_SESSION_ID:-}}"

# Codex and Claude hook commands receive the stable agent session id as one
# JSON object on stdin. Prefer it over the fallback scope so each hook event
# updates the same marker even when the hook runner's parent process changes.
read_hook_session_id() {
  local hook_input=""
  if [ -t 0 ]; then
    return
  fi
  if command -v python3 &>/dev/null; then
    hook_input="$(python3 -c 'import select,sys
ready,_,_=select.select([sys.stdin],[],[],0.2)
if ready:
    sys.stdout.write(sys.stdin.readline().rstrip("\\n"))' 2>/dev/null)"
  else
    # Bash 3.2 (the macOS system shell) accepts only integer `read -t` values.
    if ! IFS= read -r -t 1 hook_input 2>/dev/null; then
      return
    fi
  fi
  if [ -z "$hook_input" ]; then
    return
  fi
  if command -v python3 &>/dev/null; then
    python3 -c 'import json,sys
try:
    payload=json.loads(sys.argv[1])
    value=payload.get("session_id") or payload.get("sessionId") or ""
    if isinstance(value, str): print(value)
except Exception:
    pass' "$hook_input" 2>/dev/null
  elif command -v node &>/dev/null; then
    node -e 'try { const payload=JSON.parse(process.argv[1]); const value=payload.session_id || payload.sessionId; if (typeof value === "string") process.stdout.write(value); } catch {}' "$hook_input" 2>/dev/null
  fi
}

if [ -z "$EXPLICIT_SESSION_ID" ]; then
  # Hook stdin is the session identity for this invocation. Only fall back to
  # process-level Codex variables when the hook did not provide one.
  EXPLICIT_SESSION_ID="$(read_hook_session_id)"
fi
if [ -z "$EXPLICIT_SESSION_ID" ]; then
  EXPLICIT_SESSION_ID="${CODEX_THREAD_ID:-${CODEX_SESSION_ID:-}}"
fi
PROJ_NAME=$(basename "$PROJECT_DIR" | tr -d '\n')
STATE_HOME="${SESSIONBAR_HOME:-${AGENTBAR_HOME:-${HOME}/.sessionbar}}"
SESSION_DIR="${STATE_HOME}/sessions"
mkdir -p "$SESSION_DIR" 2>/dev/null || true

my_hash() {
  if command -v md5sum &>/dev/null; then
    md5sum | cut -d' ' -f1
  elif command -v md5 &>/dev/null; then
    md5
  else
    cksum | cut -d' ' -f1
  fi
}

HASH=$(echo "$PROJECT_DIR" | my_hash)
if [ -n "$EXPLICIT_SESSION_ID" ]; then
  SESSION_SCOPE=$(printf '%s' "$EXPLICIT_SESSION_ID" | my_hash | cut -c1-16)
  TTY_ID="session-${SESSION_SCOPE}"
elif TTY=$(tty 2>/dev/null); then
  TTY_ID=$(echo "$TTY" | my_hash)
else
  TTY_ID="notty-${PPID:-$$}"
fi
SCOPE_KEY="${AGENT_SLUG}-${HASH}-${TTY_ID}"
SCOPE_SHORT=$(printf '%s' "$SCOPE_KEY" | my_hash | cut -c1-8)

ID_FILE="${SESSION_DIR}/sessionbar-id-${AGENT_SLUG}-${HASH}-${TTY_ID}"

# First call: derive a stable per-agent session ID. Claude can use its transcript
# UUID; other agents get a namespaced fallback ID.
if [ ! -f "$ID_FILE" ]; then
  REAL_ID="$EXPLICIT_SESSION_ID"
  REAL_ID_SOURCE=""
  if [ -n "$REAL_ID" ]; then
    REAL_ID_SOURCE="explicit"
  fi
  if [ "$AGENT_SLUG" = "claude" ] && [ -z "$REAL_ID" ]; then
    ESCAPED=$(echo "$PROJECT_DIR" | sed 's|/|-|g')
    TRANSCRIPT_DIR="${HOME}/.claude/projects/${ESCAPED}"
    if [ -d "$TRANSCRIPT_DIR" ]; then
      # Prefer .jsonl files (main sessions), fall back to directories (sub-agents)
      LATEST=$(ls -t "$TRANSCRIPT_DIR"/*.jsonl 2>/dev/null | head -1)
      if [ -z "$LATEST" ]; then
        LATEST=$(ls -dt "$TRANSCRIPT_DIR"/*/ 2>/dev/null | head -1)
      fi
      if [ -n "$LATEST" ]; then
        REAL_ID=$(basename "$LATEST" .jsonl)
        REAL_ID_SOURCE="claude-transcript"
      fi
    fi
  fi
  # Fallback if transcript discovery failed
  if [ -z "$REAL_ID" ]; then
    REAL_ID="${AGENT_SLUG}-${PROJ_NAME}"
    REAL_ID_SOURCE="fallback"
  fi
  # Claude transcript IDs are already real session IDs. Fallback IDs need the
  # marker scope so simultaneous sessions do not collapse into one row.
  if [ "$REAL_ID_SOURCE" != "explicit" ] && [ "$REAL_ID_SOURCE" != "claude-transcript" ]; then
    case "$REAL_ID" in
      *-"$SCOPE_SHORT") ;;
      *) REAL_ID="${REAL_ID}-${SCOPE_SHORT}" ;;
    esac
  fi
  # Store as: {agent-session-id}__{project}; double underscore separates the project name.
  echo "${REAL_ID}__${PROJ_NAME}" > "${ID_FILE}.tmp"
  mv "${ID_FILE}.tmp" "$ID_FILE" 2>/dev/null
fi

SESSION_ID=$(cat "$ID_FILE")
# Migrate legacy auto-generated marker files that used only the latest Claude
# transcript ID. Without the scope suffix, multiple sessions in one project
# collapse into one server entry because session_id is the server key.
if [ -z "$EXPLICIT_SESSION_ID" ]; then
  RAW_ID="${SESSION_ID%%__*}"
  if [ "$RAW_ID" = "$SESSION_ID" ]; then
    PROJECT_PART="$PROJ_NAME"
  else
    PROJECT_PART="${SESSION_ID#*__}"
  fi
  if [ "$AGENT_SLUG" = "claude" ] && printf '%s' "$RAW_ID" | grep -Eq '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'; then
    :
  elif [ "$AGENT_SLUG" = "claude" ] && printf '%s' "$RAW_ID" | grep -Eq '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-[a-f0-9]{8}$'; then
    RAW_ID="${RAW_ID%-????????}"
    SESSION_ID="${RAW_ID}__${PROJECT_PART}"
    echo "$SESSION_ID" > "${ID_FILE}.tmp"
    mv "${ID_FILE}.tmp" "$ID_FILE" 2>/dev/null
  else
    case "$RAW_ID" in
      *-"$SCOPE_SHORT") ;;
      *)
        SESSION_ID="${RAW_ID}-${SCOPE_SHORT}__${PROJECT_PART}"
        echo "$SESSION_ID" > "${ID_FILE}.tmp"
        mv "${ID_FILE}.tmp" "$ID_FILE" 2>/dev/null
        ;;
    esac
  fi
fi
touch "$ID_FILE" 2>/dev/null || true
PROCESS_FILE="${SESSION_DIR}/sessionbar-process-${AGENT_SLUG}-${HASH}-${TTY_ID}"

is_positive_integer() {
  printf '%s' "$1" | grep -Eq '^[1-9][0-9]*$'
}

find_owning_agent_pid() {
  local pid="${PPID:-$$}"
  local parent=""
  local command=""
  local depth=0
  while is_positive_integer "$pid" && [ "$depth" -lt 32 ]; do
    command=$(ps -p "$pid" -o comm= 2>/dev/null | tr -d '[:space:]')
    case "$command" in
      *"$AGENT_SLUG"*)
        printf '%s' "$pid"
        return
        ;;
    esac
    parent=$(ps -p "$pid" -o ppid= 2>/dev/null | tr -d '[:space:]')
    if ! is_positive_integer "$parent" || [ "$parent" = "$pid" ]; then
      break
    fi
    pid="$parent"
    depth=$((depth + 1))
  done
  return 1
}

PROCESS_PID="${SESSIONBAR_PROCESS_PID:-${AGENTBAR_PROCESS_PID:-}}"
if ! is_positive_integer "$PROCESS_PID"; then
  PROCESS_PID=$(find_owning_agent_pid)
fi
if is_positive_integer "$PROCESS_PID"; then
  printf '%s\n' "$PROCESS_PID" > "${PROCESS_FILE}.tmp.$$"
  mv "${PROCESS_FILE}.tmp.$$" "$PROCESS_FILE" 2>/dev/null || true
fi
PROJ_PATH="${SESSIONBAR_PROJECT_DIR:-${AGENTBAR_PROJECT_DIR:-${CLAUDE_PROJECT_DIR:-$PROJECT_DIR}}}"
SESSION_NAME="${SESSIONBAR_SESSION_NAME:-${AGENTBAR_SESSION_NAME:-${CLAUDE_SESSION_NAME:-}}}"

# Cleanup on session end
if [ "$STATUS" = "idle" ] && [ "${TASK}" = "Session ended" ]; then
  rm -f "$ID_FILE" "$PROCESS_FILE"
fi

# Escape JSON string — use python3/node for correct handling of all control chars and Unicode
json_escape() {
  local s="$1"
  if command -v python3 &>/dev/null; then
    python3 -c "import json,sys; sys.stdout.write(json.dumps(sys.argv[1]))" "$s"
  elif command -v node &>/dev/null; then
    node -e "process.stdout.write(JSON.stringify(process.argv[1]))" "$s"
  else
    # Fallback: manual escape for common cases
    local escaped="" i ch
    for (( i=0; i<${#s}; i++ )); do
      ch="${s:$i:1}"
      case "$ch" in
        '"' ) escaped+='\"' ;;
        '\' ) escaped+='\\' ;;
        '/' ) escaped+='\/' ;;
        $'\b' ) escaped+='\b' ;;
        $'\f' ) escaped+='\f' ;;
        $'\n' ) escaped+='\n' ;;
        $'\r' ) escaped+='\r' ;;
        $'\t' ) escaped+='\t' ;;
        * ) escaped+="$ch" ;;
      esac
    done
    echo "$escaped"
  fi
}

SID_ESC=$(json_escape "$SESSION_ID")
TASK_ESC=$(json_escape "$TASK")
STATUS_ESC=$(json_escape "$STATUS")
SESSION_TYPE_ESC=$(json_escape "$SESSION_TYPE")
PROJ_ESC=$(json_escape "$PROJ_NAME")
PROJ_PATH_ESC=$(json_escape "$PROJ_PATH")

EXTRA_FIELDS=""
append_number_field() {
  local key="$1"
  local value="$2"
  if [ -n "$value" ] && printf '%s' "$value" | grep -Eq '^[0-9]+([.][0-9]+)?$'; then
    EXTRA_FIELDS="${EXTRA_FIELDS},\"${key}\":${value}"
  fi
}

append_string_field() {
  local key="$1"
  local value="$2"
  if [ -n "$value" ]; then
    local escaped
    escaped=$(json_escape "$value")
    EXTRA_FIELDS="${EXTRA_FIELDS},\"${key}\":${escaped}"
  fi
}

append_number_field "progress" "${SESSIONBAR_PROGRESS:-${AGENTBAR_PROGRESS:-}}"
append_number_field "context_percent" "${SESSIONBAR_CONTEXT_PERCENT:-${AGENTBAR_CONTEXT_PERCENT:-}}"
append_number_field "tokens" "${SESSIONBAR_TOKENS:-${AGENTBAR_TOKENS:-}}"
append_number_field "turns" "${SESSIONBAR_TURNS:-${AGENTBAR_TURNS:-}}"
append_number_field "input_tokens" "${SESSIONBAR_INPUT_TOKENS:-${AGENTBAR_INPUT_TOKENS:-}}"
append_number_field "output_tokens" "${SESSIONBAR_OUTPUT_TOKENS:-${AGENTBAR_OUTPUT_TOKENS:-}}"
append_number_field "cache_read_tokens" "${SESSIONBAR_CACHE_READ_TOKENS:-${AGENTBAR_CACHE_READ_TOKENS:-}}"
append_number_field "cache_write_tokens" "${SESSIONBAR_CACHE_WRITE_TOKENS:-${AGENTBAR_CACHE_WRITE_TOKENS:-}}"
append_number_field "token_rate" "${SESSIONBAR_TOKEN_RATE:-${AGENTBAR_TOKEN_RATE:-}}"
append_number_field "quota_percent" "${SESSIONBAR_QUOTA_PERCENT:-${AGENTBAR_QUOTA_PERCENT:-}}"
append_string_field "quota_reset" "${SESSIONBAR_QUOTA_RESET:-${AGENTBAR_QUOTA_RESET:-}}"
append_string_field "hook_event" "${SESSIONBAR_HOOK_EVENT:-${AGENTBAR_HOOK_EVENT:-}}"
append_string_field "session_name" "$SESSION_NAME"
if is_positive_integer "$PROCESS_PID"; then
  append_number_field "process_pid" "$PROCESS_PID"
fi

# Runtime samples are optional hook overrides. The server samples the persisted
# process root rather than this short-lived hook process.
RUNTIME_FIELDS=""
append_runtime_number_field() {
  local key="$1"
  local value="$2"
  if [ -n "$value" ] && printf '%s' "$value" | grep -Eq '^[0-9]+([.][0-9]+)?$'; then
    RUNTIME_FIELDS="${RUNTIME_FIELDS},\"${key}\":${value}"
  fi
}

runtime_cpu="${SESSIONBAR_CPU_PERCENT:-${AGENTBAR_CPU_PERCENT:-}}"
runtime_gpu="${SESSIONBAR_GPU_PERCENT:-${AGENTBAR_GPU_PERCENT:-}}"
runtime_memory_percent="${SESSIONBAR_MEMORY_PERCENT:-${AGENTBAR_MEMORY_PERCENT:-}}"
runtime_memory_bytes="${SESSIONBAR_MEMORY_BYTES:-${AGENTBAR_MEMORY_BYTES:-}}"
runtime_process_count="${SESSIONBAR_PROCESS_COUNT:-${AGENTBAR_PROCESS_COUNT:-}}"

if [ "$STATUS" = "working" ] || [ "$STATUS" = "blocked" ]; then
  append_runtime_number_field "cpu_percent" "$runtime_cpu"
  append_runtime_number_field "gpu_percent" "$runtime_gpu"
  append_runtime_number_field "memory_percent" "$runtime_memory_percent"
  append_runtime_number_field "memory_bytes" "$runtime_memory_bytes"
  append_runtime_number_field "process_count" "$runtime_process_count"
  append_runtime_number_field "sampled_at" "$(date +%s 2>/dev/null)000"
  if [ -n "$RUNTIME_FIELDS" ]; then
    EXTRA_FIELDS="${EXTRA_FIELDS},\"runtime\":{${RUNTIME_FIELDS#,}}"
  fi
fi

AGENT_SIGNAL="${SESSIONBAR_AGENT_SIGNAL:-${AGENTBAR_AGENT_SIGNAL:-}}"
AGENT_SIGNAL_FIELDS=""
AGENT_SIGNAL_ATTRIBUTES=""
append_agent_number_field() {
  local key="$1"
  local value="$2"
  if [ -n "$value" ] && printf '%s' "$value" | grep -Eq '^[0-9]+([.][0-9]+)?$'; then
    AGENT_SIGNAL_ATTRIBUTES="${AGENT_SIGNAL_ATTRIBUTES},\"${key}\":${value}"
  fi
}

append_agent_string_field() {
  local key="$1"
  local value="$2"
  if [ -n "$value" ]; then
    local escaped
    escaped=$(json_escape "$value")
    AGENT_SIGNAL_ATTRIBUTES="${AGENT_SIGNAL_ATTRIBUTES},\"${key}\":${escaped}"
  fi
}

if [ -n "$AGENT_SIGNAL" ]; then
  AGENT_SIGNAL_ESC=$(json_escape "$AGENT_SIGNAL")
  append_agent_string_field "source" "${SESSIONBAR_AGENT_SIGNAL_SOURCE:-${AGENTBAR_AGENT_SIGNAL_SOURCE:-}}"
  append_agent_string_field "scope" "${SESSIONBAR_AGENT_SIGNAL_SCOPE:-${AGENTBAR_AGENT_SIGNAL_SCOPE:-}}"
  append_agent_string_field "kind" "${SESSIONBAR_AGENT_SIGNAL_KIND:-${AGENTBAR_AGENT_SIGNAL_KIND:-}}"
  append_agent_number_field "used" "${SESSIONBAR_AGENT_USED:-${AGENTBAR_AGENT_USED:-}}"
  append_agent_number_field "remaining" "${SESSIONBAR_AGENT_REMAINING:-${AGENTBAR_AGENT_REMAINING:-}}"
  append_agent_number_field "limit" "${SESSIONBAR_AGENT_LIMIT:-${AGENTBAR_AGENT_LIMIT:-}}"
  append_agent_string_field "unit" "${SESSIONBAR_AGENT_UNIT:-${AGENTBAR_AGENT_UNIT:-}}"
  append_agent_string_field "status" "${SESSIONBAR_AGENT_STATUS:-${AGENTBAR_AGENT_STATUS:-}}"
  append_agent_string_field "error_code" "${SESSIONBAR_AGENT_ERROR_CODE:-${AGENTBAR_AGENT_ERROR_CODE:-}}"
  append_agent_number_field "balance" "${SESSIONBAR_AGENT_BALANCE:-${AGENTBAR_AGENT_BALANCE:-}}"
  append_agent_string_field "balance_unit" "${SESSIONBAR_AGENT_BALANCE_UNIT:-${AGENTBAR_AGENT_BALANCE_UNIT:-}}"
  append_agent_number_field "used_percent" "${SESSIONBAR_AGENT_USED_PERCENT:-${AGENTBAR_AGENT_USED_PERCENT:-}}"
  append_agent_number_field "reset_at" "${SESSIONBAR_AGENT_RESET_AT:-${AGENTBAR_AGENT_RESET_AT:-}}"
  append_agent_string_field "label" "${SESSIONBAR_AGENT_LABEL:-${AGENTBAR_AGENT_LABEL:-}}"
  AGENT_SIGNAL_FIELDS=",\"agent_signals\":[{\"signal\":${AGENT_SIGNAL_ESC}${AGENT_SIGNAL_ATTRIBUTES}}]"
fi

# SID_ESC / STATUS_ESC / TASK_ESC are already JSON-string-encoded by json_escape
# (json.dumps includes surrounding quotes + escapes interior chars).
# Embed them directly — no extra shell quoting.
curl -s -X POST "http://localhost:${SERVER_PORT}/session/status" \
  --connect-timeout 1 --max-time 2 \
  -H "Content-Type: application/json" \
  -d "{\"session_id\":${SID_ESC},\"session_type\":${SESSION_TYPE_ESC},\"status\":${STATUS_ESC},\"task_name\":${TASK_ESC},\"project\":${PROJ_ESC},\"project_path\":${PROJ_PATH_ESC}${EXTRA_FIELDS}${AGENT_SIGNAL_FIELDS}}" \
  > /dev/null 2>&1 || true
