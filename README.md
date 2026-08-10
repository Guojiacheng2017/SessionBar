# SessionBar

SessionBar is a local relay for AI coding agent sessions.

It is intended to show every active agent session on this computer, grouped by
project directory. A single project may have several simultaneous sessions from
Claude Code, Codex, OpenCode, Gemini, or other agents.

## Session Model

Each reported session is identified by:

- `session_id`: stable ID for one running agent session
- `session_type`: human label, such as `Claude Code`, `Codex`, or `OpenCode`
- `session_name`: optional human-readable session name; displays fall back to `project`, then `session_id`
- `project_path`: absolute project directory
- `project`: project directory basename
- `status`: `working`, `idle`, `blocked`, or `error`
- `task_name`: short current task or tool name
- optional stats: `context_percent`, `tokens`, `turns`, `progress`
- optional usage details: `input_tokens`, `output_tokens`,
  `cache_read_tokens`, `cache_write_tokens`, `token_rate`, `quota_percent`,
  `quota_reset`
- optional workflow buffer: `workflow_events`, recent canonical hook events
  rendered in the Flow detail tab
- optional provider signals: `agent_signals`, for account, agent, project, or
  workspace facts such as API balance, quota, rate-limit state, or service health

The UI groups by `project_path`/`project`, not by agent type. Multiple agents
working on the same project should therefore appear as separate rows under the
same project.

In the TUI, navigation is project-first: before a project is opened, `↑↓` moves
between projects while the session table still shows all sessions. Press `Enter`
to inspect that project's sessions, then `↑↓` moves between sessions. Press `a`
or Backspace to return to all projects.

The TUI uses a monitor-style split cadence. By default it redraws every 500ms
and polls session data every 1000ms, so age/heartbeat tracking stays responsive
without letting collection work jitter the layout. Set `SESSIONBAR_TUI_REFRESH_MS`
for render cadence or `SESSIONBAR_TUI_POLL_MS` for data polling.

## Reporting Contract

Agent hooks call `report.sh`:

```sh
SESSIONBAR_AGENT=codex \
SESSIONBAR_SESSION_TYPE=Codex \
SESSIONBAR_PROJECT_DIR="$PWD" \
SESSIONBAR_SESSION_ID="codex-session-id" \
./report.sh working "Editing files" 8989
```

Arguments:

```text
report.sh <status> <task_name> <server_port>
```

Environment:

- `SESSIONBAR_AGENT`: stable lowercase agent key, e.g. `claude`, `codex`, `opencode`
- `SESSIONBAR_SESSION_TYPE`: display label, e.g. `Claude Code`, `Codex`, `OpenCode`
- `SESSIONBAR_PROJECT_DIR`: project directory; defaults to `CLAUDE_PROJECT_DIR` or `pwd`
- `SESSIONBAR_SESSION_ID`: real agent session ID when available
- `SESSIONBAR_CONTEXT_PERCENT`, `SESSIONBAR_TOKENS`, `SESSIONBAR_TURNS`, `SESSIONBAR_PROGRESS`: optional numeric stats
- `SESSIONBAR_INPUT_TOKENS`, `SESSIONBAR_OUTPUT_TOKENS`,
  `SESSIONBAR_CACHE_READ_TOKENS`, `SESSIONBAR_CACHE_WRITE_TOKENS`,
  `SESSIONBAR_TOKEN_RATE`, `SESSIONBAR_QUOTA_PERCENT`: optional numeric Usage
  metrics
- `SESSIONBAR_QUOTA_RESET`: optional short Usage label, e.g. `5h38m`
- `SESSIONBAR_AGENT_SIGNAL`, `SESSIONBAR_AGENT_SIGNAL_SOURCE`,
  `SESSIONBAR_AGENT_SIGNAL_SCOPE`, `SESSIONBAR_AGENT_SIGNAL_KIND`,
  `SESSIONBAR_AGENT_USED`, `SESSIONBAR_AGENT_REMAINING`,
  `SESSIONBAR_AGENT_LIMIT`, `SESSIONBAR_AGENT_UNIT`,
  `SESSIONBAR_AGENT_STATUS`, `SESSIONBAR_AGENT_ERROR_CODE`,
  `SESSIONBAR_AGENT_RESET_AT`, `SESSIONBAR_AGENT_LABEL`: optional canonical
  provider signal fields
- Legacy provider fields remain accepted: `SESSIONBAR_AGENT_BALANCE`,
  `SESSIONBAR_AGENT_BALANCE_UNIT`, and `SESSIONBAR_AGENT_USED_PERCENT`.
- `SESSIONBAR_HOOK_EVENT`: optional native hook event name, e.g. `PreToolUse`;
  SessionBar maps reviewed names to canonical workflow events for the Flow tab

The legacy `AGENTBAR_*` names are still accepted for existing hooks.

Provider-specific hook parsing belongs in SessionBar adapters or hook scripts.
Those adapters should normalize facts from Claude Code, Codex, OpenCode, or
other agents into the canonical `SESSIONBAR_*` fields above before reporting to
the relay.

Provider adapters may emit an `agent_signals` entry with a `source`, a
recommended `scope` (`session`, `agent`, `account`, `project`, or `workspace`),
and a `kind` such as `balance`, `quota`, `rate_limit`, or `service_health`.
Canonical numeric fields are `used`, `remaining`, `limit`, and `used_percent`;
`unit`, `status`, `error_code`, and `reset_at` carry display context. The Usage
detail renders these signals separately from Session Usage as
`Source | Value | Usage | Reset`.

SessionBar does not estimate provider balances, quota, or service health from
session tokens. A provider API adapter may query a credentialed provider
endpoint in a later layer; hook adapters only report facts they actually
receive. Missing or unsupported provider fields remain `--` and do not change
the session's `status`, `task_name`, or session token usage.

### Provider polling

When a supported provider key is present, the relay performs an immediate
account-level query when it starts and refreshes it every five minutes. Set
`SESSIONBAR_PROVIDER_POLL=0` to disable polling or
`SESSIONBAR_PROVIDER_POLL_MS` to change the interval (minimum 30 seconds).
The key is never stored in a session, returned by the API, or written to the
server log.

Supported credentialed sources:

- DeepSeek: `SESSIONBAR_DEEPSEEK_API_KEY` or `DEEPSEEK_API_KEY` reads the API
  balance endpoint.
- MiniMax: `SESSIONBAR_MINIMAX_TOKEN_PLAN_KEY` or `MINIMAX_TOKEN_PLAN_KEY`
  reads Token Plan remaining/used quota.
- Kimi: `SESSIONBAR_KIMI_API_KEY`, `KIMI_API_KEY`, or `MOONSHOT_API_KEY`
  reads the available USD balance from the Kimi Open Platform.
- xAI: `SESSIONBAR_XAI_MANAGEMENT_API_KEY` plus
  `SESSIONBAR_XAI_TEAM_ID` reads the team's prepaid balance. This is a
  Management API key, not an inference key.
- OpenAI: `SESSIONBAR_OPENAI_ADMIN_KEY` or `OPENAI_ADMIN_KEY` reads the
  organization completions usage report for the last 24 hours. A normal
  `OPENAI_API_KEY` is intentionally not accepted for this endpoint.
- Anthropic: `SESSIONBAR_ANTHROPIC_ADMIN_KEY` or `ANTHROPIC_ADMIN_KEY` reads
  the organization messages usage report for the last 24 hours. A Claude
  subscription or Claude Code login does not expose an equivalent balance API.

Personal GitHub Copilot usage is read separately from the local Copilot client
credential at `~/.config/github-copilot/apps.json`. SessionBar calls the
Copilot entitlement endpoint used by the local client and displays the live
personal plan name, AI credit `used/remaining/entitlement`, and the reset time.
The plan allowance is never hardcoded or requested as user input. This uses a
private, undocumented client endpoint rather than the public GitHub Billing
API, so a schema or authentication change makes the row disappear instead of
showing guessed quota data. Copilot Business and Enterprise organization pools
remain separate subscription sources and are not mixed with this personal row.

When no explicit DeepSeek API key is configured, SessionBar also checks the
active Claude provider in CC Switch's local `~/.cc-switch/cc-switch.db` and
uses its DeepSeek credential as a read-only fallback. The credential is held
only in memory for the request and is never written to SessionBar state or
logs. Disable this integration with `SESSIONBAR_CCSWITCH=0`.

The provider overview displays account-level API rows directly from the poll,
so a provider does not need a matching session to appear there. Provider
signals are also attached to matching agent sessions so the existing `Usage`
inspector can show them. Override the default target with
`SESSIONBAR_<PROVIDER>_TARGET`, for example
`SESSIONBAR_DEEPSEEK_TARGET=Codex`. Use a comma-separated target list or `*` to
match all sessions. Optional `SESSIONBAR_<PROVIDER>_BASE_URL` and
`SESSIONBAR_<PROVIDER>_LABEL` are available for compatible deployments.

Subscription-only products such as Codex ChatGPT plans, Claude Code plans, and
provider dashboards without a documented account endpoint remain hook/session
signals rather than guessed balances.

Inside the app, `hookAdapters.ts` is the native-payload boundary. It extracts
common facts from provider hook payloads, including native event names, current
tool/activity labels, and session token usage aliases. It deliberately does not
infer model intent or store provider quota as session usage; quota-like limits
belong to agent-level signals.

Adapter samples:

- tool start: `{ event: "PreToolUse", tool_input: { arguments: { command:
  "npm test" } } }` normalizes to `working`, `running: npm test`, and
  `tool: npm test`.
- tool failure: `{ hook_event_name: "PostToolUseFailure", error: { message:
  "exit status 1" } }` normalizes to `error` with an `error: exit status 1`
  activity event.
- context compaction: `{ hookEventName: "PostCompact" }` normalizes to
  `Context compacted` and still appears as a canonical Flow event.

If `SESSIONBAR_SESSION_ID` is absent, `report.sh` creates a fallback ID namespaced
by agent, project, and terminal. This prevents a Codex hook from updating a
Claude Code row in the same project.

## State Directory

SessionBar stores intermediate runtime state under:

```text
~/.sessionbar/
```

The server PID is written to `~/.sessionbar/server.pid`. Hook marker files are
written to `~/.sessionbar/sessions/`. Runtime state should not be written to the
project root or `/tmp`; set `SESSIONBAR_HOME` only when you explicitly want an
alternate state directory.

## Server

Opening SessionBar starts the local relay automatically when it is not already
reachable:

```sh
sessionbar
```

`setup` does not start the service. It only chooses where Claude Code hooks are
installed:

```sh
sessionbar setup --local   # local focus: this project's .claude/settings.json
sessionbar setup --global  # global focus: ~/.claude/settings.json
```

Hook registration follows the application lifecycle. Opening the default TUI,
`monitor`, or `web` registers SessionBar's configured hooks after the relay is
ready. `start`, `status`, `prune`, tests, and harness calls do not register
hooks. Leaving the TUI removes only SessionBar-managed hooks; the relay remains
available until `sessionbar stop` is requested. Hook reports use a short curl
connection timeout and silently return when the relay is unavailable, so an
agent harness is never made to wait for SessionBar.

Open the terminal monitor directly:

```sh
sessionbar monitor
```

Open the web dashboard:

```sh
sessionbar web
```

The server listens on `127.0.0.1:8989` by default. Set `PORT` to change the
port, or `SESSIONBAR_HOST` to explicitly bind another host.
