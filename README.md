# SessionBar

SessionBar is a local relay for AI coding agent sessions.

It is intended to show every active agent session on this computer, grouped by
project directory. A single project may have several simultaneous sessions from
Claude Code, Codex, OpenCode, Gemini, or other agents.

## Session Model

Each reported session is identified by:

- `session_id`: stable ID for one running agent session
- `session_type`: human label, such as `Claude Code`, `Codex`, or `OpenCode`
- `project_path`: absolute project directory
- `project`: project directory basename
- `status`: `working`, `idle`, `blocked`, or `error`
- `task_name`: short current task or tool name
- optional stats: `context_percent`, `tokens`, `turns`, `progress`

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

The legacy `AGENTBAR_*` names are still accepted for existing hooks.

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

Start the relay:

```sh
sessionbar start
```

Open the web dashboard:

```sh
sessionbar web
```

Open the terminal monitor:

```sh
sessionbar
```

The server listens on `127.0.0.1:8989` by default. Set `PORT` to change the
port, or `SESSIONBAR_HOST` to explicitly bind another host.
