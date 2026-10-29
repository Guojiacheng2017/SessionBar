<p align="center">
  <img src="docs/images/sessionbar-wordmark.svg" width="720" alt="SessionBar">
  <br>
  <sub>AI CLI Session Monitor</sub>
</p>

**English** | [简体中文](README.zh-CN.md)

## What's New

- **2026-10-30 · v1.1.0 Runtime:** Shared Provider networking, explicit safe
  restart, owned-process cleanup and debounced targeted filesystem refreshes.
- **2026-10-30 · Harnesses:** Native Kimi Code, ZCode and Cursor reporting;
  WorkBuddy database/WAL discovery, DeepSeek Harness snapshots and Codex identity fixes.
- **2026-10-30 · Agent details:** On-demand Codex, Claude and DeepSeek sub-agent
  inspection, paged conversation records and native execution/Flow evidence.
- **2026-10-30 · UI and Providers:** Terminal Agents/Providers inspectors, a safe
  built-in command box, stable Web updates and clearer cached billing/usage data.
- **2026-10-26 · v1.0.0 fixes retained:** Codex quota-window deduplication,
  30-minute session retention, local browser boundaries and owned-hook cleanup.

> [!NOTE]
> This section keeps the five most recent significant updates. For the full
> history and downloadable packages, see [Releases](https://github.com/Guojiacheng2017/SessionBar/releases).

> [!IMPORTANT]
> SessionBar is still under active development. Some agents, status signals,
> and platform behaviors may not yet be fully covered. Feedback, suggestions,
> and reproducible issue reports from real-world use are highly appreciated.

SessionBar is a local-first dashboard for AI coding sessions. It discovers and
normalizes sessions from multiple agent harnesses, groups them by project
directory, and presents the result in a terminal UI or local Web dashboard.

One project can contain several concurrent Claude Code, Codex, Gemini,
Copilot or WorkBuddy sessions. SessionBar keeps those sessions separate instead
of treating the project as a single agent process.

### Supported harnesses

<p>
  <kbd><img src="https://unpkg.com/@lobehub/icons-static-svg@latest/icons/claude-color.svg" width="14" height="14" alt=""> Claude Code</kbd>
  <kbd><img src="https://unpkg.com/@lobehub/icons-static-svg@latest/icons/openai.svg" width="14" height="14" alt=""> Codex</kbd>
  <kbd><img src="https://unpkg.com/@lobehub/icons-static-svg@latest/icons/gemini-color.svg" width="14" height="14" alt=""> Gemini CLI</kbd>
  <kbd><img src="https://unpkg.com/@lobehub/icons-static-svg@latest/icons/copilot-color.svg" width="14" height="14" alt=""> GitHub Copilot CLI</kbd>
  <kbd><img src="https://unpkg.com/@lobehub/icons-static-svg@latest/icons/claude-color.svg" width="14" height="14" alt=""> Claude Desktop</kbd>
  <kbd><img src="public/provider-icons/workbuddy.svg" width="14" height="14" alt=""> WorkBuddy Desktop</kbd>
  <kbd><img src="https://unpkg.com/@lobehub/icons-static-svg@latest/icons/moonshot.svg" width="14" height="14" alt=""> Kimi Code</kbd>
  <kbd><img src="https://unpkg.com/@lobehub/icons-static-svg@latest/icons/cursor.svg" width="14" height="14" alt=""> Cursor</kbd>
  <kbd><img src="https://unpkg.com/@lobehub/icons-static-svg@latest/icons/deepseek-color.svg" width="14" height="14" alt=""> DeepSeek Harness</kbd>
  <kbd>ZCode</kbd>
</p>

<table>
  <tr>
    <td colspan="2" align="center"><img src="docs/images/tui-landing.png" width="560" alt="SessionBar TUI landing screen"><br><sub><b>TUI · Landing</b></sub></td>
  </tr>
  <tr>
    <td width="50%" align="center"><img src="docs/images/tui-sessions.png" alt="SessionBar TUI project, sessions and activity details"><br><sub><b>TUI · Sessions</b></sub></td>
    <td width="50%" align="center"><img src="docs/images/tui-providers.png" alt="SessionBar TUI provider overview"><br><sub><b>TUI · Providers</b></sub></td>
  </tr>
  <tr>
    <td width="50%" align="center"><img src="docs/images/web-sessions.png" alt="SessionBar Web session overview"><br><sub><b>Web · Sessions</b></sub></td>
    <td width="50%" align="center"><img src="docs/images/web-providers.png" alt="SessionBar Web provider overview"><br><sub><b>Web · Providers</b></sub></td>
  </tr>
</table>

> Captured from this release's actual UI on 2026-10-30, using isolated synthetic
> projects, sessions, system readings, and provider values. No real account data,
> credentials, or personal paths are included. Missing fields stay unavailable;
> actual data coverage depends on the harness and provider adapter.

> SessionBar uses the terminal's background. Colors and contrast vary with the
> active terminal theme.

## Features

- Project path → session → details navigation; independent sessions per agent.
- Overview, Activity, Usage, Flow and Raw tabs; System telemetry when unselected.
- Provider quota, balance and usage trends separate from session status.
- Cached CPU, memory, load, temperature and network readings.
- Alternate-screen TUI rendering and slower background polling.
- One relay per state directory with a dynamic port selected at startup.
- On-demand sub-agent inspection and source-backed execution/Flow views;
  unavailable relationships remain unknown instead of being guessed.
- Debounced targeted discovery, last-good snapshots and safe built-in commands.

## Install and Update

Requirements: **Node.js 22+, npm and Bun**. Node runs the CLI, landing screen and
relay; Bun is required for OpenTUI's native FFI monitor. macOS is the primary
tested platform. Linux support is partial, with some discovery, credential and
temperature adapters limited to macOS. Windows parity is not claimed.

### Release Package

Download `sessionbar-1.1.0.tgz` and `SHA256SUMS` from
[GitHub Releases](https://github.com/Guojiacheng2017/SessionBar/releases/latest).
From the download directory:

```sh
shasum -a 256 -c SHA256SUMS
npm install --global ./sessionbar-1.1.0.tgz
sessionbar
```

This is a GitHub release archive, not an npm registry publication. Download
the archive and its matching checksum file from the same release.

### From Source

```sh
git clone --branch main https://github.com/Guojiacheng2017/SessionBar.git sessionbar
cd sessionbar
npm install
npm run build
npm link
sessionbar
```

Without linking, run `node dist/cli/cli.js`. Update a source installation with
`git pull --ff-only`, `npm install` and `npm run build` from a clean `main`
checkout. Reconcile divergent history without discarding local changes.

## Usage

Landing starts the relay automatically. Select commands with Up/Down or j/k,
then Enter. Shortcuts: `1` monitor, `2` setup, `3` status, `4` settings,
`W` Web and `Q` quit.
Press `:` or Tab to enter built-in commands with completion and history.
This input does not execute arbitrary shell commands.

```sh
sessionbar monitor    # 实时终端面板 / Live terminal dashboard
sessionbar agents     # 按需查看子 Agent / Inspect observed sub-agents
sessionbar providers  # Provider 检查器 / Provider inspector
sessionbar status     # 单次状态输出 / One-shot status
sessionbar web        # 本地网页面板 / Local Web dashboard
sessionbar setup      # 配置 Hook 范围 / Configure hook scope
sessionbar harnesses  # 检查 Harness / Inspect harness availability
sessionbar prune      # 清理过期标记 / Remove stale markers
sessionbar stop       # 显式停止服务 / Explicitly stop the relay
sessionbar restart    # 安全重启并应用环境 / Safely restart with the current environment
```

In Monitor, choose a project with Up/Down and Enter, then choose a session.
Tab, brackets or `1`–`5` switch detail tabs; `a` or Backspace returns to all
projects; `v` switches Providers, `A` switches Agents; `r` refreshes, `/` filters, `w` opens Web
and `q` exits. Without a focused project, all sessions are shown. In Web, click
projects and sessions; scroll down for Providers.
Use `PageUp`, `PageDown`, `Home` and `End` to reach all detail content in small terminals.

Exiting TUI releases that client, not other open clients or browser tabs.
After the last client disconnects, a five-minute reconnection grace applies;
an explicitly started headless relay does not shut down merely for being idle.
Use `sessionbar stop` for an explicit stop. Ordinary refreshes do not reassign
the port. An explicit restart or a new server process can receive a new port.
`sessionbar prune` stops a running relay before deleting stale marker files;
it is maintenance, not a routine refresh command.

### Hooks and Discovery

```sh
sessionbar setup --local   # 当前项目 / Current project
sessionbar setup --global  # 所有项目 / All projects
```

Interactive apps activate SessionBar-managed hooks; one-shot status commands
do not install them. Harnesses may need a restart to load changed configuration.
Claude Code, Gemini CLI, Copilot and Cursor use hook events. Codex also uses
local logs and app-server metadata. Kimi Code and ZCode use user-level native
hooks; they do not claim project-scoped configuration. Claude Desktop and
WorkBuddy use local artifacts, not injected Desktop hooks. WorkBuddy additionally
reads bounded SQLite/WAL snapshots when `sqlite3` is available. DeepSeek Harness
reads versioned checkpoints under `~/.dsh`, independently of the DeepSeek API.
Pi lifecycle callbacks are supported; generic Pi execution graphs and OpenCode
discovery are not claimed. See [input adapters](docs/harness-input-adapters.md).

Custom reporting:

```sh
SESSIONBAR_AGENT=codex \
SESSIONBAR_SESSION_TYPE=Codex \
SESSIONBAR_PROJECT_DIR="$PWD" \
SESSIONBAR_SESSION_ID="agent-session-id" \
./report.sh working "Editing files"
```

`report.sh <status> <task_name> [server_port]` reads the current port from state
when omitted. Session IDs must identify sessions, not just projects. Optional
fields include `SESSIONBAR_CONTEXT_PERCENT`, `SESSIONBAR_TOKENS` and
`SESSIONBAR_HOOK_EVENT`; legacy `AGENTBAR_*` variables remain accepted.

## Runtime and Storage

Default binding is **127.0.0.1** on an available port recorded in
`~/.sessionbar/port`. The same directory contains `server.pid`, `server.log`,
`sessions/`, `settings.json`, `provider-usage-history.json`,
`provider-last-good.json` and `session-usage-history.json`.
Private startup-configuration and Codex-origin caches also live here.

```sh
SESSIONBAR_PORT=8989 sessionbar             # 可选固定端口 / Optional fixed port
SESSIONBAR_HOME="$HOME/.sessionbar-dev" sessionbar  # 独立状态 / Isolated state
```

`SESSION_BAR_PORT` and `PORT` are compatibility aliases. An explicitly selected
port can fail if occupied. State and intermediate files do not belong in the
repository. Sessions without updates remain in memory for up to 30 minutes;
the list is not a permanent conversation archive.
Retained rows are not proof that an agent process is still running. Context
and usage fields remain unavailable when a harness does not report them.

SessionBar-owned state directories use `0700` and updated state files use
`0600` on POSIX. This is not encryption or protection against same-user processes.

## Provider Data

Adapters include OpenAI/Codex, Anthropic, GitHub Copilot, DeepSeek, MiniMax,
Kimi, xAI and compatible CC Switch configurations. Coverage depends on
credentials and upstream APIs. Missing quota is not inferred from session tokens.

[CC Switch](https://github.com/farion1231/cc-switch) is optional and read-only,
providing compatible credentials and seven-day API token history. Without it,
monitoring and official adapters still work. DeepSeek and Kimi can use
`SESSIONBAR_DEEPSEEK_API_KEY` and `SESSIONBAR_KIMI_API_KEY`. WorkBuddy can use a
read-only `SESSIONBAR_WORKBUDDY_BALANCE_COMMAND` returning validated balance JSON.
Local WorkBuddy context/consumption is not treated as an account balance. Grok
CLI billing uses its read-only ACP endpoint when installed and authenticated.
xAI Management API queries require both `SESSIONBAR_XAI_MANAGEMENT_API_KEY` and
`SESSIONBAR_XAI_TEAM_ID` in the startup environment; no Web credential editor
is included. Collected values preserve their original source time.

Provider HTTP uses the Relay's shared network policy: explicit proxy environment
first, otherwise existing macOS system proxies, otherwise the normal system
route. Loopback always connects directly; SessionBar never enables a proxy or
changes system settings. Changed environment needs `sessionbar restart`.
See [runtime boundaries and unsupported proxy modes](docs/relay-runtime.md).

```sh
SESSIONBAR_PROVIDER_POLL=0 sessionbar
SESSIONBAR_PROVIDER_POLL_MS=300000 sessionbar
```

Polling defaults to five minutes, with a 30-second minimum. Successful Provider
rows are retained for up to 30 days. Failed refreshes show the last value,
original collection time and stale marker without renewing expiry. Disabled
polling leaves cache readable without calling subscription or API adapters.

## Privacy and Security

This update supports loopback HTTP only. Do not expose the relay through public
proxies or port forwarding. Browser requests require trusted Host and same
Origin. Device pairing, LAN gateways and remote telemetry are not released here.

Project paths, titles and activity may contain private information visible to
local clients. Provider credentials are not returned in UI payloads. Upstream
Provider APIs and external icons create network requests. Optional `--icloud`
exports session snapshots to the user's iCloud directory.

Production dependencies pass `npm audit --omit=dev` for this update. This is not
a complete security audit or protection against malicious local processes.
Never commit credentials, personal configuration or real snapshots.
Ignore rules are local configuration and are not tracked in the repository.
Before staging changes, exclude credentials, `.env` files, personal agent
configuration, `node_modules/` and `dist/` in your local `.gitignore` or
`.git/info/exclude`. Inspect `git status` and `git diff --cached` before committing.

## Development

Source is organized under `src/agents`, `cli`, `harness`, `hooks`, `providers`, `runtime`, `server`, `sessions`,
`shared`, `system`, `tui` and `web`. Assets are in `public/`, tests in `test/`.
Screenshot and wordmark tools: [scripts/docs/README.md](scripts/docs/README.md).

```sh
npm run build
npm test
```

Tests isolate HOME, credentials and state, use simulated provider endpoints,
and do not require a real account or send model requests.

Add regression tests, keep state outside the repo, preserve unknown values and
separate project and session identity. Experimental cost, native companion
and optical pairing work are excluded from this update.

## Contributions

Code contributions, bug reports, reproducible performance traces and harness
adapter improvements are welcome. By contributing, you agree that your changes
may be distributed under the project's MIT License.

## Related Work and Direction

[Orca](https://github.com/stablyai/orca), [abtop](https://github.com/graykode/abtop),
[Mole](https://github.com/tw93/mole), [Rezi](https://github.com/RtlZeroMemory/Rezi)
and [OpenTUI](https://github.com/anomalyco/opentui) explore adjacent agent,
terminal and system-monitoring workflows. This describes the field, not code
derivation, affiliation or endorsement. SessionBar aims to provide a private,
low-overhead, project-organized view of coding-agent sessions on a machine.

## License

[MIT License](LICENSE). Third-party assets retain their own licenses.
See [third-party notices](docs/THIRD_PARTY_NOTICES.md) for bundled Splide assets
and the README wordmark's font attribution.
