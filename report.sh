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
  *) DEFAULT_SESSION_TYPE="$AGENT_SLUG" ;;
esac

SESSION_TYPE="${SESSIONBAR_SESSION_TYPE:-${AGENTBAR_SESSION_TYPE:-$DEFAULT_SESSION_TYPE}}"
PROJECT_DIR="${SESSIONBAR_PROJECT_DIR:-${AGENTBAR_PROJECT_DIR:-${CLAUDE_PROJECT_DIR:-$(pwd)}}}"
EXPLICIT_SESSION_ID="${SESSIONBAR_SESSION_ID:-${AGENTBAR_SESSION_ID:-}}"
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
if TTY=$(tty 2>/dev/null); then
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
PROJ_PATH="${SESSIONBAR_PROJECT_DIR:-${AGENTBAR_PROJECT_DIR:-${CLAUDE_PROJECT_DIR:-$PROJECT_DIR}}}"

# Cleanup on session end
if [ "$STATUS" = "idle" ] && [ "${TASK}" = "Session ended" ]; then
  rm -f "$ID_FILE"
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

append_number_field "progress" "${SESSIONBAR_PROGRESS:-${AGENTBAR_PROGRESS:-}}"
append_number_field "context_percent" "${SESSIONBAR_CONTEXT_PERCENT:-${AGENTBAR_CONTEXT_PERCENT:-}}"
append_number_field "tokens" "${SESSIONBAR_TOKENS:-${AGENTBAR_TOKENS:-}}"
append_number_field "turns" "${SESSIONBAR_TURNS:-${AGENTBAR_TURNS:-}}"

# SID_ESC / STATUS_ESC / TASK_ESC are already JSON-string-encoded by json_escape
# (json.dumps includes surrounding quotes + escapes interior chars).
# Embed them directly — no extra shell quoting.
curl -s -X POST "http://localhost:${SERVER_PORT}/session/status" \
  -H "Content-Type: application/json" \
  -d "{\"session_id\":${SID_ESC},\"session_type\":${SESSION_TYPE_ESC},\"status\":${STATUS_ESC},\"task_name\":${TASK_ESC},\"project\":${PROJ_ESC},\"project_path\":${PROJ_PATH_ESC}${EXTRA_FIELDS}}" \
  > /dev/null 2>&1 || true
