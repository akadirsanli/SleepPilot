# Architecture

## Overview

```
 Browser / Edge app window                     Other tools, cron, CI, DSH
        │  HTTP + SSE, 127.0.0.1, token cookie          │  CLI --json
        └──────────────────────┬────────────────────────┘
                               ▼
                     ┌───────────────────┐
                     │  SleepPilotApp    │  projects, runs, recovery, keep-awake
                     └─────────┬─────────┘
                               ▼
                     ┌───────────────────┐
                     │   RunController   │  plan → developer → checks → review → decision
                     └─────────┬─────────┘
              ┌────────────────┼─────────────────┐
              ▼                ▼                 ▼
      ┌──────────────┐  ┌──────────────┐  ┌──────────────┐
      │ EngineManager│  │ project/,    │  │ store/,      │
      │ 6 engines    │  │ checks/,     │  │ report/,     │
      │              │  │ reverse/,    │  │ web/         │
      │              │  │ analysis/,   │  │ analytics/,  │
      │              │  │ github/      │  │              │
      └──────┬───────┘  └──────────────┘  └──────────────┘
             │
   ┌─────────┼──────────┬──────────┬──────────────┬──────────┐
   ▼         ▼          ▼          ▼              ▼          ▼
 OpenCode  Claude     Codex      API            DeepSeek   Command
 2.x       Code CLI   CLI        harness        Harness    harness
```

Zero runtime dependencies: Node.js built-ins only (`fetch`, `node:test`, `node:http`, `node:child_process`).

## Engine layer

`src/engines/` defines one contract (`base.mjs`) and six implementations:

- `opencode/` (adapter in `src/opencode/`) — a private `opencode serve` process, HTTP + SSE, OpenAPI capability checks.
- `external-cli/` — shared base for installed agent CLIs: persisted session, process lifecycle, JSONL/stream-json parsing, interrupt and crash reconciliation.
- `claude/` — Claude Code `-p --output-format stream-json`, `--session-id`/`--resume`, tool events, usage/cost.
- `codex/` — Codex `exec --json` and `exec resume`, item events, usage, thread id.
- `api/` — SleepPilot’s own agent harness: OpenAI-compatible and Anthropic clients, tool loop, permissions, durable session files.
- `dsh/` — local DeepSeek Harness CLI (`dsh --profile headless --json`), NDJSON streaming, session continuation.
- `cli/` — a command template with `{prompt}`, `{project}`, `{model}`, `{sessionId}`.

`EngineManager` owns the engines, the provider list and the credential store. A project’s `settings.engine` chooses its default engine; a run stores `run.engine = { id, label, version, source, model }`. The RunController only uses the contract, so all engines share planning, retries, checks, review, steering and recovery.

### Multi-harness routing

`src/orchestrator/routing.mjs` and `src/orchestrator/quota-tracker.mjs` add a routing layer above
`EngineManager`; they do not duplicate engine adapters. `RunController` resolves a route per role
(or task type), gets the adapter from `EngineManager`, and creates role-scoped sessions with the
route's model profile and effort. Read-only roles are limited to adapters that enforce read-only at
session level. On a provider/quota failure the controller persists the failed turn, records a
switch in `run.routingSwitches`, creates a new session on the next harness and continues the same
task. Claude's 5-hour window is parsed from its stream/result output; the fallback chain keeps the
run working inside its configured window instead of treating one harness reset as the end of the
run. See `docs/ROUTING.md` for the schema and exact effort vocabulary.

### The turn contract

```
createSession({ directory, title, model, permissions, effort, readOnly }) -> { id, effort, readOnly }
runTurn({ sessionID, text, messageId, metadata, onEvent, onSubmitted })
  -> { status, finalText, allText, tools, errors, usage, transcript,
       quota?: { exhausted, resetsAt, window, message, source } }
turnMessages(sessionID, messageId) -> { found, user, after }
```

`after` uses the OpenCode message shape (`assistant` parts + `idle` marker), so `reconcileTurn()` can evaluate an API, Claude Code, Codex or DSH turn exactly like an OpenCode one. Engines persist every message before returning; a crash therefore never causes a resubmission.

### Claude Code and Codex

Both are **external agent CLIs** with their own tool loop. SleepPilot supervises the turn boundary, not the individual tool calls:

- `src/engines/external-cli/engine.mjs` owns the session file, spawn/kill, timeout, stdout line parser, transcript and result shape.
- Claude Code events: `system`, `assistant` (text/thinking/tool_use), `user` (tool_result) and `result` (usage/cost). Sessions use `--session-id` then `--resume`.
- Codex events: `thread.started`, `item.started`/`item.completed` (`agent_message`, `reasoning`, `command_execution`, `file_change`) and `turn.completed` usage. Sessions use `exec` then `exec resume`.
- Read-only roles use Claude's `--permission-mode plan` or Codex's read-only sandbox. Developer roles map the SleepPilot profile to Claude/Codex permissions/sandbox. Their internal permission prompts cannot be routed through SleepPilot; the CLI setting is the boundary.
- Authentication is the CLI's own (`claude auth login`, `codex login`); no key is stored by SleepPilot.

### The built-in API harness

- Tools: `read`, `write`, `edit`, `list`, `glob`, `grep`, `bash`, `webfetch`, `question`, `status`.
- Permission evaluation reuses the OpenCode rulesets (`developerRuleset`, `readOnlyRuleset`), so profiles, protected paths and parallel edit scopes behave identically.
- Providers are normalised in `src/engines/api/providers.mjs`; model lists are refreshed from `/models` when available.
- Ollama discovery (`src/engines/api/ollama.mjs`) reads `/api/version` and `/api/tags`, then seeds an `ollama` provider pointing at the local OpenAI-compatible `/v1` endpoint. No key is involved.
- Native tool calling is used when the provider supports it; otherwise the engine falls back to a fenced `tool` block protocol.
- Sessions live in `<data>/engine-sessions/api/*.json`; tool output is capped and long histories are trimmed.

## Run state machine

```
created → running → paused / waiting_user → running …
                 ↘ completed / stopped / failed
```

```
prepare (git status, optional backup)
recover active turn (after a restart)
plan          Manager (read-only): inspect project → JSON task list
loop:
  controls      stop / pause requests
  limits        active time / iterations / tokens / cost
  quota gate    OpenCode Go allowance when available
  steering      pending instructions → manager rewrites objective + tasks
  pick task     forced task, else highest-priority runnable task
  iterate:
    snapshot before (persisted index)
    developer turn (fresh session per task; repairs continue it)
    snapshot after → diff (works without Git)
    checks        command / syntax / HTML / doc / cargo
    reviewer turn (read-only, optional)
    evaluate      deterministic
    manager decision JSON (continue | repair | ask_user | complete)
  no task left → waiting_user? pause : improvement mode? : finish
```

**Roles.** Manager and Reviewer sessions get a read-only ruleset (`* * deny`, then read/glob/grep/list allow). The Developer gets the profile ruleset. In unattended mode the `question` action is denied so a question cannot stop the night.

**Parallel developers.** With `parallelDevelopers > 1` the Manager gives every task a `files` scope. `selectWave` picks up to N runnable tasks whose scopes do not overlap. Each gets its own session whose ruleset adds `edit/write/patch * deny` + allow for its files. Turns run concurrently; one snapshot diff is split per task; command/cargo checks are cached for the wave.

**Evaluation** (`evaluate()`): `needs_user` → waiting_user; `blocked` → blocked; a failed executed check → test_failed (failure signature hashed; same signature `maxAttemptsSameFailure` times → blocked); checks passed + changes + reviewer not negative → **verified**; otherwise → implemented_unverified. A model can never set verified/implemented (`applyTaskUpdates` enforces it).

**Time.** Active time excludes pauses. Overtime (`overtimeMin`, up to `overtimeMaxRounds`) is granted while requested tasks remain. When time runs out during a developer turn the answer is awaited (`finalGraceMin`), checks run, and the run finishes.

**Unattended.** A watchdog declines unanswered permissions and cancels unanswered forms after `permissionTimeoutMin`; the developer is told and continues. Transient provider/connection/quota pauses resume automatically (bounded). At start each selected role model gets a one-line preflight request. Before the terminal state a read-only closing-report session receives SleepPilot’s measured facts and its answer is stored.

**Recovery.** Runs active when the app stopped are re-opened as paused. A clean shutdown waits for the user. A crash/kill during an unattended run resumes by itself after a delay (bounded per run). The persisted `activeTurn` is reconciled through `turnMessages`: found+idle → evaluated normally; found without idle → interrupted, task retried with a recovery note; not found → never admitted, task retried. The message is never submitted twice.

## Multiple projects

`SleepPilotApp.controllers` is a map of active runs, not a single slot. Each controller owns one project, one engine session and its own snapshots/checks. `startRun` enforces **one run per project** and a global `maxConcurrentRuns` (default 3); different projects may run together. `state()` exposes `activeRuns` (plus a legacy first `activeRun`). Shutdown persists every controller, and the supervisor recovers all unfinished runs on restart.

## Scope analysis, analytics and GitHub

- `src/analysis/scope.mjs` performs a deterministic, local scan (files, code lines, tests, TODOs, generated dirs, binary headers for reverse targets). It returns a size class, risks and a recommended hours/iterations/parallelism/profile. No model is called.
- `src/scout/scout.mjs` is the **Scout agent**: deterministic read-only discovery. For projects it reads manifests/lockfiles/sources to identify stacks, required tools and suggested checks. For targets it parses PE/ELF/Mach-O headers, imports and strings to identify .NET/Unity, Electron/Node, Java, Python, Go, Rust or native runtimes and the required RE tools. The app decorates its result with live toolchain status and records a compact profile on `run.scout`; the report includes it.
- `src/analytics/analytics.mjs` aggregates persisted run records across projects: active milliseconds, measured line changes, task states, tokens/cost, daily activity. `GET /api/analytics` feeds the Insights screen.
- `src/github/github.mjs` detects Git/remote/GitHub CLI state and performs **explicit** init/create/push actions. It never pushes automatically and never stores a GitHub token; repository creation reuses `gh auth login`, push reuses existing Git credentials.

## Verification

`src/checks/runner.mjs`:

| Type | What it executes |
|---|---|
| `command` | A command the user explicitly approved, in the project folder |
| `js-syntax` | `node --check` on changed JS files |
| `py-syntax` | `ast.parse` with the chosen interpreter (Python 2.7 supported via `interpreter`) |
| `html-smoke` | Headless Edge via DevTools protocol: page load, console errors, failed resources |
| `cite-check` | `file:line` claims in changed Markdown against the target map |
| `doc-check` | Required documents exist and are non-trivial |
| `cargo` | `cargo check`, `cargo test`, `cargo build`, `cargo clippy`, `cargo fmt` in the project |

`verificationFrom()` turns executed results into a verdict. Only passed executed checks verify a task.

## Persistence

```
%LOCALAPPDATA%\SleepPilot\
  settings.json, credentials.json, app-state.json, logs\
  engine-sessions\api\<session>.json
  engine-sessions\dsh\<session>.json
  engine-sessions\cli\<session>.json
  projects\<slug>-<hash(dir)>\project.json       identity, objective + history, rules, settings, checks, inspection, reverse setup
  projects\…\runs\run_…\run.json                 state, tasks, iterations summary, steering, usage, sessions, pending, activeTurn, engine
  projects\…\runs\run_…\events.jsonl             append-only event log
  projects\…\runs\run_…\iterations\NNNN.json     prompt, output, tools, diff patches, checks, review, decision
  projects\…\runs\run_…\iterations\NNNN.before.json  pre-iteration fingerprints
  projects\…\runs\run_…\turns.jsonl              chat transcript per turn
  projects\…\runs\run_…\report.md
  backups\<project>\<timestamp>\
```

JSON is written atomically (temp file + rename, retries for Windows locks). Persisted strings pass through the redactor. Nothing is written into a user project by SleepPilot itself; the agent writes there.

## UI server security

- Binds `127.0.0.1` only.
- A random per-launch token is exchanged once (`/?t=…`) for an `HttpOnly; SameSite=Strict` cookie.
- The `Host` header must be the loopback address (DNS-rebinding defence).
- State-changing requests need `X-SleepPilot: 1` (cross-site form defence).
- CSP `default-src 'self'`; all UI text is escaped.
- API keys are never included in `/api/state`; the UI sees only `hasKey`.
- File downloads (APK/AAB) are limited to `.apk`/`.aab` files inside the project or its exports folder.
- From the phone listener, choosing the workspace folder, approving a preview command and downloading Gradle are refused (PC-only).

## Staying alive

1. **Bounded diff** (`project/snapshot.mjs`): edit distance is capped; huge changes are reported as delete-all/add-all without unbounded memory.
2. **Supervisor** (`src/supervisor.mjs`): a parent process restarts the app after a crash, OOM, freeze (no heartbeat) or `{type:'restart'}` request; the process tree is killed, the reason is logged and passed to the next start.
3. **Stall watchdog** (unattended): no progress for `stallLimitMs` interrupts the turn; a second stall asks the supervisor for a restart.
4. **Single instance** lock: a second launch reopens the existing window and never takes over running work.
5. **Memory guard**: saves runs and restarts before V8’s uncatchable OOM.

## Workspace, preview and Android

- `src/workspace/workspace.mjs` — the workspace layout (`projects/`, `exports/`, marker, README), safe folder names, the Home/Settings view.
- `src/preview/preview.mjs` — `StaticPreview` (read-only file server on its own loopback port; live reload over SSE; an injected client script reports page errors to the UI with `postMessage`, checked against the preview's origin), `CommandPreview` (an approved dev-server command; the URL is read from its output) and `PreviewManager` (one preview per project). The UI page allows only `frame-src http://127.0.0.1:* http://localhost:*`.
- `src/android/toolchain.mjs` — read-only JDK/SDK/Gradle/adb detection with fixes for every missing piece; the shared, cached result also exports `JAVA_HOME`/`ANDROID_HOME` to processes SleepPilot starts (only when the user has not set them).
- `src/android/project.mjs` — Gradle project discovery (also in `android/` sub-folders), APK/AAB inspection with a small ZIP reader (`src/util/zip.mjs`) and a binary `AndroidManifest.xml` parser.
- `src/android/templates.mjs` — the project templates; never overwrites a file.
- `src/android/build.mjs` — the build runner (wrapper → detected/downloaded Gradle), failure diagnosis, export, `keytool` signing, `gradle wrapper`, the SHA-256-checked Gradle download and `adb`. On macOS/Linux the wrapper jar is started with the detected `java` directly: a POSIX shell drops environment variables whose names contain dots (`ORG_GRADLE_PROJECT_android.injected.signing.*`), which carry the signing passwords without putting them on the command line.
- `src/android/service.mjs` — per-project builds (one at a time, streamed to the UI), signing keys (keystore in `android-keys/`, password in the credential store), devices.
- The `android-build` check type (`src/checks/runner.mjs`) runs the same build after a task; a missing toolchain is an environment error, not a failed task.

## Reverse & Rust

`src/reverse/`:

- `setup.mjs` validates paths, builds the mirror, runs recon, scaffolds Rust, stores objective/rules/checks.
- `recon.mjs` produces `_recon/RECON.md`, `recon.json`, `binaries.json`, `TOOLS.md`.
- `pe.mjs`, `elf.mjs`, `macho.mjs`, `strings.mjs` are dependency-free static parsers.
- `playbook.mjs` holds modes, objective, rules and checks.
- `rust.mjs` scaffolds a Cargo project, detects cargo and runs cargo commands.

The target is added to protected paths; `_target/` and `_recon/` are protected from edits; target hashes are recorded and re-verified at the end of the run.
