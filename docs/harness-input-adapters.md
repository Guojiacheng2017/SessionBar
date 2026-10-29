# Harness Input Adapters

SessionBar treats a Harness input as a transport plus a deterministic adapter.
The adapter reads one native payload or artifact and emits the existing
`SessionPayload` / `HookEvent[]` contract. It does not own scheduling, debounce,
last-good state, retries, or Relay deduplication.

## Current Input Matrix

| Harness | Primary input | Additional input | Session source | Notes |
| --- | --- | --- | --- | --- |
| Codex CLI / App | Hook notify | `~/.codex/sessions/**/*.jsonl` fallback; app-server protocol metadata | `hook` / `codex_jsonl` | Hook and JSONL can describe the same native event. App-server enriches names and account usage; it is not liveness. |
| Claude Code | Hook notify | `~/.claude/projects/**/*.jsonl` usage enrichment | `hook` | Transcript files do not replace Hook session state. |
| Claude Desktop | App-maintained `local_*.json` session snapshots | Model catalog files for provider labels | `filesystem_snapshot` | Desktop has no SessionBar Hook. The adapter must read bounded snapshot roots. |
| WorkBuddy Desktop | `~/.workbuddy/sessions/*.json` and `workbuddy.db` session snapshots | Legacy `app/sessions.json`; bounded project JSONL metadata | `filesystem_registry` / `filesystem_snapshot` | Desktop 5.9.3 verified. DB/WAL changes reconcile bounded read-only snapshots; `-shm` and `traces/**` are excluded. |
| CodeBuddy CLI | Hook notify | None | `hook` | Separate adapter from WorkBuddy Desktop. |
| Gemini CLI | Hook notify | None | `hook` | Native event names are normalized by the Hook ontology. |
| Kimi Code CLI / Desktop | Shared user-level TOML Hooks | `~/.kimi-code/session_index.jsonl` and session `state.json` fallback | `hook` / `filesystem_registry` | Native identity is shared; explicit Hooks take precedence. Client provenance is retained without guessing an unrecognized client type. |
| ZCode | User-level native process Hooks | None | `hook` | Separate from the Z.ai API provider. No project-scope hook execution or invented SessionEnd. |
| GitHub Copilot CLI | Hook notify | None | `hook` | Provider entitlement polling is account data, not a session input. |
| Cursor | Hook notify | Hook model metadata | `hook` | `conversation_id` is the native session identity. A Grok model changes `model_provider`, not the Cursor Harness identity. |
| Pi Agent | Extension callbacks normalized as Hook events | None | `hook` | Event-driven; no filesystem polling. |

Codex Flow automatically captures native wait starts through the existing
SessionBar `PreToolUse` hook. Ordinary CLI and App entry points need no `trace`
prefix. Exact native call IDs join completed rollout results, whose receiver
arrays contain only returned subsets and can be empty on timeout. Active native
operations can be recovered when Flow opens; completed history stays outside the
initial live state. Targetless waits provide timing while dependencies stay unknown.
The passive helper records IDs, state and time in the private `codex-hooks/`
state directory, including while Relay is off. Set `SESSIONBAR_HOME` or
`SESSIONBAR_CODEX_HOOK_EVENTS_DIR` consistently for both processes when overriding
it. Existing disabled/untrusted hooks remain unchanged. `sessionbar trace codex`
is still an optional structured-stream diagnostic fallback. Relationships are
shown only when native source evidence establishes them. Remote Harness
registration and OTLP are excluded from this release.

The machine-readable version is `src/harness/harnessInputMatrix.ts`. Bounded
filesystem artifact descriptors are in
`src/harness/filesystemHarnessAdapters.ts`.

## Kimi Code and ZCode Hooks

Verified against the official [Kimi Hooks](https://www.kimi.com/code/docs/en/kimi-code-cli/customization/hooks.html),
[Kimi Desktop settings](https://www.kimi.com/code/docs/en/kimi-code-desktop/settings-and-extensions.html),
[Kimi data locations](https://www.kimi.com/code/docs/en/kimi-code-cli/configuration/data-locations.html)
and [ZCode Hooks](https://zcode.z.ai/en/docs/hooks) references.

- Kimi rules live in `$KIMI_CODE_HOME/config.toml` (default `~/.kimi-code`).
  Desktop uses the same user rules. SessionBar appends a marked block containing
  only the supported `event`, `command` and `timeout` fields. A TOML parser
  validates before writing; removing an intact LF/CRLF block preserves unrelated
  config bytes. If a formatter removed its markers, cleanup identifies owned
  rules structurally and rewrites TOML formatting while preserving other settings.
  User settings inserted inside a managed block cause a safe skip, not deletion.
- ZCode rules live in `~/.zcode/cli/config.json`; `SESSIONBAR_ZCODE_HOME` is a
  SessionBar-only path override for this adapter. Hooks use `type: process` with
  explicit Node argv and millisecond timeouts. Explicitly disabled user hooks
  stay disabled; existing inactive hooks are not silently enabled. Project-scope
  setup is skipped because ZCode does not execute it.
- Both use the existing interactive registration/teardown lifecycle. Malformed
  configs are left untouched. Automatic registration does not create a config for
  an unavailable harness. New harness sessions may be needed to load changed rules.
- The bounded, fail-open bridge posts only canonical metadata to the runtime
  loopback port and writes no hook stdout. It does not read credentials, start a
  model, grant permission, inject prompts, or retain raw tool output/transcripts.
  Kimi observes session/turn, tool, permission, completion/interruption and
  compaction events. ZCode observes only its seven documented core events.
- `SessionStart` means ready, not already working. Permission result uses the
  explicit approved/denied/error decision. Heartbeat and subagent notifications
  do not mark the parent working. Unknown events are skipped, not inferred.
- Kimi Hook IDs match the existing file adapter, so one conversation remains one
  session. The file source cannot overwrite explicit Hook state or client labels.
  Without explicit client provenance the file fallback is labeled `Kimi Code`,
  not falsely labeled CLI. Windows project paths are supported.
- Neither Hook contract documents account balance/quota or session token usage;
  these fields remain unavailable rather than inferred from the harness brand or
  arbitrary tool results. Provider integrations remain independent.

Tests use isolated temporary configs and simulated Hook stdin/Relay endpoints.
No Kimi or ZCode login, real session, or inference request is required or tested.

## WorkBuddy Version Compatibility

The Desktop 5.9.3 audit confirmed that live JSON registry records still exist,
but SQLite `sessions` is also required. The adapter combines both and deduplicates
by native conversation ID. DB/WAL changes use the shared debounced Runtime;
reads are limited to 80 recent local sessions and do not checkpoint the database.
Windows drive/UNC project paths and committed WAL updates are covered by fixtures.
The optional `sqlite3` executable is required for the database route; if absent,
legacy discovery remains available.

Credits come only from `session_usage.credit_json`; `used`/`size` describe context
occupancy, not a credit balance. A missing credit map yields no fabricated usage
row. The source timestamp is retained, so an old credit cache is not a new account
balance. Current remaining credits and subscription entitlement were not established
by these local tables. Synthetic regression fixtures cover schema compatibility,
read-only WAL access and freshness; private calibration records are not included.

## Planned Harnesses

| Harness | Status | Integration decision |
| --- | --- | --- |
| Grok Bot | Deferred | Keep it distinct from Cursor. Individual accounts currently expose no verified live-session interface; Enterprise inference hooks or OTLP action records can become a separate adapter when configured. |

Until an individual Grok Bot session interface is available, it remains absent
from the machine-readable input matrix and session discovery. X Subscription's
shared weekly pool is Provider/account data, not a Harness event source.

## Filesystem Watcher Choice

The released Runtime uses Node **`fs.watch`** with bounded adapter roots,
300 ms debounce, targeted reads and five-minute reconciliation. Adapters remain
independent of the watcher implementation. The following options describe future
backend choices, not additional dependencies shipped by this release.

| Option | Cross-platform recursion | Write stability | Dependency cost | Decision |
| --- | --- | --- | --- | --- |
| Chokidar v4 | macOS, Linux, Windows | Normalizes atomic writes; optional `awaitWriteFinish` | One dependency; Node 14+ | Preferred Runtime backend. Watch only adapter roots and cap depth. |
| Node `fs.watch` | Recursive support exists on current Node releases, but platform and filesystem caveats remain | Raw `rename`/`change`; filename may be absent; inode replacement needs recovery | Zero dependencies | Acceptable only behind a Runtime backend with reconciliation and rescan logic. |
| `fs.watchFile` | Per-file stat polling | Stable but delayed | Zero dependencies; higher I/O/CPU | Fallback for a small explicit file set, not recursive trees. |
| Watchpack | Cross-platform directory manager | Built-in aggregation | Larger abstraction oriented around bundler invalidation | Not selected; aggregation/debounce belongs to SessionBar Runtime. |

References:

- [Chokidar](https://github.com/paulmillr/chokidar)
- [Node.js filesystem watch APIs and caveats](https://nodejs.org/api/fs.html#fswatchfilename-options-listener)
- [Watchpack](https://github.com/webpack/watchpack)

No watcher dependency is added in this Harness-side change. The next Runtime
version can choose Chokidar v4 without changing adapter contracts. Chokidar v5
requires Node 20 and is ESM-only; v4 keeps a wider runtime compatibility range.

## Runtime Boundary

Filesystem adapters declare:

- roots and maximum recursion depth;
- accepted relative paths;
- snapshot versus append-only read mode;
- the native contract represented by an artifact.

Runtime owns:

- starting and stopping watchers;
- debounce and `awaitWriteFinish` policy;
- bounded rescans after overflow, rename, or watcher failure;
- single-flight reads and last-good state;
- event ordering, source precedence, and Relay dedupe;
- lifecycle cleanup and backoff.

This prevents each Harness from growing its own polling loop or reliability
policy.

## Source Identity And Dedupe

Every adapter should produce a `HarnessSourceIdentity`. Runtime computes the
dedupe key in this priority order:

1. `harness + native_session_id + native_event_id`
2. `harness + native_session_id + canonical event kind + semantic_fingerprint`
3. `harness + native_session_id + artifact + cursor` as a source-local fallback

Transport is deliberately excluded from the first two keys. A Hook event and a
JSONL event with the same native id or semantic fingerprint therefore collapse
to one change. The semantic fingerprint must be built from canonical,
non-sensitive facts such as event kind, tool name, native timestamp, and native
sequence. It must not hash prompts, model output, access tokens, or full raw
payloads.

When a provider exposes neither a native id nor enough stable semantic facts,
the artifact cursor cannot prove cross-transport equivalence. Runtime should
retain both observations and rely on deterministic session snapshot merge,
rather than guessing that two events are identical.

## Platform Paths

`appDataRoot()` follows standard application data roots:

- macOS: `~/Library/Application Support/<app>`
- Linux: `$XDG_CONFIG_HOME/<app>` or `~/.config/<app>`
- Windows: `%APPDATA%\<app>` or `~/AppData/Roaming/<app>`

WorkBuddy's `~/.workbuddy` and Codex's `~/.codex` remain home-relative on every
platform. Paths are matched with the platform-specific `node:path` implementation
and normalized to `/` only after calculating a safe relative path.
## DeepSeek Harness (DSH)

DSH is an independent harness, not the DeepSeek API balance provider.
The read-only adapter watches `~/.dsh/storages/session_projcache/sessions/*.json`
and `~/.dsh/storages/workspace.json` through the shared file-source Runtime.
Override the data root with `SESSIONBAR_DSH_HOME`.

Verified against the installed Desktop runtime's `dsh-session-projection-cache`
(document version 7, session format 4), `dsh-token-meter` and workspace schemas.
These are internal, versioned checkpoints; unknown generations are skipped.
Upstream source: <https://github.com/deepseek-ai/deepseek-harness>.

Only recent snapshots (30 minutes, up to 80 per reconciliation, maximum 2 MiB
per snapshot) are read. Changed checkpoint paths are read individually. Archived
sessions and subagent checkpoints are excluded; sessions sharing a project keep
distinct native IDs. No credentials, transcripts, prompt injection, extra DSH
process or model requests are required.

The adapter maps title, project, explicit turn/question state, total usage buckets,
turn count and context pressure. Input is uncached input; cache-read/write remain
separate and all four buckets contribute once to total tokens. DSH may use other
model providers, so the harness does not imply `model_provider=deepseek`.
Cached snapshots cannot establish live process liveness: unfinished turns older
than 30 seconds are shown as idle. No workflow graph, API balance or provider
quota is inferred. Desktop vs CLI provenance is not present in these shared files.
