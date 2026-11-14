# OpenCode 2.x research notes

> Historical research from the first SleepPilot version. It documents the OpenCode 2.x HTTP/SSE
> contract used by the `opencode` engine. See [ENGINES.md](ENGINES.md) for the current engine layer.

*"Your project keeps building while you sleep."*

Research date: **2026-10-28**. Machine: Windows 11 Pro 10.0.26200, Node.js 24.19.0,
Python 3.10.11, Git 2.52.0. Bun is **not** installed.

Everything marked **verified** below was checked by reading source code, running
commands, or making real requests against the installed OpenCode server on this
machine. Claims taken only from READMEs are marked **README claim (not verified)**.

---

## 1. The installed OpenCode (the integration target)

| Item | Finding | How established |
|---|---|---|
| Install | OpenCode **Desktop** app at `%LOCALAPPDATA%\Programs\@opencode-aidesktop\`. The CLI is bundled as `resources\opencode-cli.exe`; it is **not** on `PATH`. | verified (filesystem) |
| Version | Started the session at **2.0.32**. The desktop app **auto-updated itself to 2.2.0 during this research session** (binary replaced in place). | verified (`opencode-cli.exe --version`, `opencode-cli.version`) |
| Major API generation | OpenCode **2.x** ("V2"). The HTTP API lives under `/api/...` (e.g. `POST /api/session/{id}/prompt`). The OpenCode **1.x** API (`/session`, `/event`, `message.part.updated`, `session.idle`) is a different contract. | verified (`GET /openapi.json` from the running server; v1 docs at opencode.ai/docs/server describe root paths) |
| Background service | The desktop app runs a background server on a random loopback port (`opencode service status` → `http://127.0.0.1:<port>`). Its password is stored in `~/.config/opencode/service.json`. | verified |
| Private server | `opencode-cli serve --hostname 127.0.0.1 --port 0` with env `OPENCODE_PASSWORD=<secret>` prints `server listening on http://127.0.0.1:<port>`. HTTP Basic auth, username **`opencode`**. Wrong user / no auth → `401`. This is the same mechanism the CLI's own `--standalone` mode uses (it spawns `serve --stdio --port 0` with `OPENCODE_PASSWORD`). | verified (spawned it, tested `GET /api/info` with right/wrong credentials; binary strings) |
| Auth reuse | The private server reads the same data directory (`~/.local/share/opencode`), so the user's existing OpenCode Go sign-in and provider configuration are reused. **No API key is needed in SleepPilot.** | verified (models from `opencode-go` provider listed and used) |
| API contract | The server serves its own OpenAPI 3.1 document at `GET /openapi.json` (title "opencode HttpApi"). 2.0.32 → 2.2.0 diff: core session/prompt/permission/form/interrupt operations unchanged; `event.subscribe` gained a `types` filter; `experimental.usage.limits` was **added** in 2.2.0. | verified (fetched and diffed both specs) |
| Official v2 JS packages | `@opencode/client@2.2.0` (README: *"Private generation target"*), `@opencode/sdk@2.2.0` (in-process host that embeds the whole server router), `@opencode/plugin`. Versions move in lock-step with the server. `@opencode-ai/sdk` (1.19.x) is the **v1** SDK. | verified (npm registry, package README) |
| v2 docs | opencode.ai/v2/docs covers install/desktop/web pairing but **does not document the HTTP API**. The only authoritative v2 API contract found is the server's `/openapi.json`. | verified (fetched page) |

### 1.1 OpenCode 2.x behaviors verified with real requests

All of these used the user's real OpenCode Go account against a throw-away folder
(cost of all probes combined: well under US$0.01 as reported by OpenCode).

1. **Create session** `POST /api/session` with `{title, location:{directory}, model:{providerID,id}, permissions:[...]}` → `Session.Info` with `id` (`ses_…`).
2. **Prompt** `POST /api/session/{id}/prompt` `{id:"msg_…", text}` → `200` immediately ("durably admit one session input"). **Re-posting the same `id` is idempotent** — it returned the same inbox item and did not create a second user message. SleepPilot uses this to guarantee *no duplicate task submission*.
3. **Event stream** `GET /api/event` (SSE). Observed types: `session.execution.started/succeeded/failed/interrupted`, `session.step.started/ended/failed`, `session.tool.called/success`, `session.text.delta/ended`, `session.usage.updated` (cost + tokens), `permission.asked/replied`, `session.retry.scheduled`, `form.created/replied/cancelled`. The spec marks the stream **volatile** (missed while disconnected).
4. **Durable state**: `GET /api/session/{id}/message` returns `user`, `assistant` (content: text/reasoning/tool, `finish`, `cost`, `tokens`, structured `error`) and **`idle`** markers with `outcome: succeeded|failed|interrupted`. `GET /api/session/{id}` has cumulative `cost`, `tokens`, `outcome`, `time.idle`. `GET /api/session/active` lists running sessions.
5. **Important pitfall**: with a model that the provider rejected, the turn ended with an `idle` marker `outcome: failed` and a structured error, but a later no-op execution flipped the *session's* `outcome` to `succeeded`. **Session-level `outcome` alone is not trustworthy for a turn; SleepPilot evaluates the messages that follow its own user message.**
6. **Structured provider errors** (`Session.StructuredError.type`): `provider.quota`, `provider.rate-limit`, `provider.auth`, `provider.timeout`, `provider.transport`, `provider.invalid-request`, `provider.no-route`, … plus HTTP `status`. Real example seen: the default free model returned `provider.invalid-request` "This Go model trains on request data… Allow paid endpoints that train on request data in your workspace's Privacy settings". SleepPilot classifies these into distinct pause reasons.
7. **Permissions**: session-level ruleset `[{action, resource, effect: allow|ask|deny}]`. Verified: `shell` asks → `permission.asked` event + `GET /api/session/{id}/permission` → reply `POST …/permission/{rid}/reply {decision: once|always|reject}`. **Later rules override earlier ones** (`shell * ask`, then `shell node * allow`, then `shell git push* deny` → `node` ran, `git push` was denied, `echo` asked). A `* * deny` rule **removes the tools from the model entirely** (useful for read-only Manager/Reviewer sessions). Note: v2 uses action **`shell`** (v1 docs say `bash`).
8. **Interrupt**: `POST /api/session/{id}/interrupt` → `{interrupted:true}`, then `session.step.failed {type:"aborted"}`, `session.execution.interrupted`, idle marker `outcome: interrupted`. On an idle session it returns `{interrupted:false}`. **Immediate interruption is supported and verified.**
9. **Wait**: `POST /api/experimental/session/{id}/wait` blocks until idle (experimental; SleepPilot uses events + polling instead).
10. **Diffs**: `GET /api/session/{id}/diff` returned `[]` in a non-Git folder even though a file was written. SleepPilot therefore computes its own before/after file snapshot (and uses `git diff` when Git exists).
11. **Go allowance** (2.2.0+): `GET /api/experimental/usage/limits` → `go.rolling/weekly/monthly {percent, limited, resetsAt}` and console budgets. On this machine: rolling 1 %, weekly 40 %, monthly 43 % (values reported by OpenCode, at research time). Not available on 2.0.32 → SleepPilot shows "unknown" when absent.
12. **Models**: `GET /api/model` lists `opencode-go/*` models with price tables (`cost.input/output` per 1M tokens). The session `cost` is OpenCode's computation from those tables; for a Go subscription it is an **API-equivalent estimate, not an actual charge**.

---

## 2. Candidate projects

### 2.1 Hona/opencode-ralph

| Question | Answer |
|---|---|
| What it does | Bun + OpenTUI terminal app running the "Ralph" loop: each iteration creates a fresh OpenCode session with a fixed prompt "READ all of plan.md. Pick ONE task … Commit change … create .ralph-done when all tasks complete". (verified: `src/loop.ts`) |
| Multi-iteration | Yes, until `.ralph-done` exists or abort. |
| Plans / progress / memory | `plan.md` checkboxes (parsed for counts), `.ralph-state.json`, `AGENTS.md` for learned details, Git commits. |
| Steering mid-run | No objective-change mechanism; pause via `.ralph-pause` file / `p` key. |
| GUI | Terminal UI only. |
| Windows | Has Windows-aware launcher; requires **Bun** (not installed here). |
| OpenCode version | `@opencode-ai/sdk 1.1.1` — **v1 API only** (`message.part.updated`, `session.idle`). Would not talk to the installed 2.x server. (verified) |
| Auth reuse | Yes (spawns `createOpencodeServer`). |
| Verification | None by design — the prompt tells the agent *"NEVER VERIFY EDIT TOOLS WORKED"*; completion is self-declared. Auto-**commits** every iteration. |
| License | MIT. |
| Maintenance | Last commit 2026-01-07 (≈10 months before research date). |
| Foundation? | **No** — v1-only, Bun, TUI, self-declared completion, auto-commit. Idea reused: fresh session per task + persisted plan. |

### 2.2 willin/ralph

| Question | Answer |
|---|---|
| What it does | A Bash script (`ralph.sh`) that loops `opencode run "<prompt>" --file AGENTS.md` (or Claude Code) up to N times; stops when output contains `<promise>COMPLETE</promise>`. Uses `prd.json` + `progress.txt`. Fork of snarktank/ralph with Chinese docs + a flowchart web page. (verified) |
| Multi-iteration | Yes (fixed max iterations). |
| Steering | No. GUI: no (the React "flowchart" is documentation). |
| Windows | Requires Bash and `jq`; no native Windows support. |
| OpenCode version | CLI text output; writes an `opencode.json` into the target project. Not verified against 2.x. |
| Verification | Completion is a string the model prints. Claude path uses `--dangerously-skip-permissions`. |
| License | MIT. Maintenance: 4 commits total, last 2026-03-22. |
| Foundation? | **No.** Idea reused: PRD-style task list with explicit acceptance criteria. |

### 2.3 Flesymeb/HarnessOfHarness (HoH / HoH-lite)

| Question | Answer |
|---|---|
| What it does | Research framework (arXiv paper) for multi-day autonomous development, mostly games. Each loop: **Project Planner** (writes dev document, does not edit), **Developer**, **QA Tester** (read-only, records evidence). HoH-lite = Python package `gameloop` with Godot tooling, benchmark adapters. (README claim for the multi-day results; role structure verified in README + configs) |
| OpenCode use | Through the `harbor` benchmark agent wrapper; doctor pins OpenCode **1.14.30**; OpenCode config built for **Bailian** API keys (`BAILIAN_API_KEY`). (verified in source) |
| Steering | Resume from a previous run directory; no live objective change found. |
| GUI | No (CLI + scripts). |
| Windows | Python 3.12+ (this machine has 3.10), Godot 4, shell scripts; not targeted at Windows. |
| Auth reuse | No — expects separate provider credentials. |
| License | Root MIT; `hoh-lite/` Apache-2.0 with NOTICE / third-party notices. |
| Maintenance | Active (last commit 2026-10-20). |
| Foundation? | **No** (benchmark-oriented, Godot/game-specific, v1, separate keys). **Ideas reused**: the three-role structure (planner does not edit, QA read-only), evidence bundles per iteration, "repair-then-next" tester policy. No code copied. |

### 2.4 gitpcl/openorchestrator

| Question | Answer |
|---|---|
| What it does | "Multi-provider cockpit": Python/Textual app that runs Claude Code, Pi, Droid, OpenCode **interactive TUIs in tmux panes** in separate git worktrees and supervises them. (verified: `tool_registry.py` — OpenCode has "no hook integration") |
| Autonomy | Batch/plan TOML for parallel worktrees; supervision of agent panes rather than evidence-based evaluation. |
| GUI | Terminal (Textual). |
| Windows | **No** — requires tmux; classifiers list macOS/Linux only. |
| OpenCode | Drives the TUI through tmux (screen-level), the approach this project explicitly avoids. |
| License | MIT. Maintenance: active (2026-07-04). |
| Foundation? | **No.** |

### 2.5 code-yeongyu/oh-my-openagent (OmO, formerly "oh-my-opencode")

| Question | Answer |
|---|---|
| What it is now | Package `oh-my-opencode` v5.1.49 (2026-10-27), a large monorepo (≈11 800 files, Bun + Rust). The README now centres on **OmO Native**: a standalone `omo` binary built on its own "senpi" engine, installed with `irm https://get.omo.dev/install.ps1 \| iex`. The OpenCode **plugin** ("OpenCode edition") still exists in `packages/omo-opencode`. (verified) |
| Same as older Oh My OpenCode? | **No.** Older releases were purely an OpenCode plugin (Sisyphus agent, background agents, "ultrawork"/todo-continuation hooks). Current architecture is primarily its own native agent runtime; the OpenCode plugin is one of several editions. |
| OpenCode 2.x | The changelog first said *"We know about OpenCode v2. Our answer to it is coming… please run OmO Native"*; a later entry says the plugin *"loads on OpenCode 2"* by exporting a v2 `setup`. It still depends on `@opencode-ai/sdk`/`@opencode-ai/plugin` **1.18.31** (v1 packages). Functional behavior on 2.x: **not verified**. |
| Integration with this machine | **Not installed**: `GET /api/plugin` on the user's server lists only built-in `opencode.*` plugins; `~/.config/opencode/opencode.jsonc` has no plugin entry; no `~/.omo`. |
| Steering / GUI | In-session prompts/"todo" UX; a desktop app is announced as *coming soon* (README claim). No external run supervisor with objective history. |
| License | **Sustainable Use License 1.0** (source-available, *not* OSI open source): use only for internal business or non-commercial/personal purposes; redistribution only free of charge for non-commercial purposes; must ship the license terms and modification notices. Reusing its code would impose these terms on SleepPilot's future GitHub publication. |
| Foundation? | **No.** Different runtime, v1 packages, restrictive license, not installed. Nothing reused. |

### 2.6 Other options considered

* **Official `@opencode/client` 2.2.0** — generated from the same contract; labelled *"Private generation target"*, lock-stepped to the server version. Because the desktop app auto-updated 2.0.32 → 2.2.0 during this session, pinning SleepPilot to one client version would break on the next silent update. **Not used**; SleepPilot uses a small hand-written HTTP client limited to operations it validates at runtime against the server's own `/openapi.json`.
* **Official `@opencode/sdk` 2.2.0** — in-process host (embeds `@opencode/server`, `@opencode/core`, `effect`). Would duplicate the installed OpenCode and pin versions. Not used.
* **`opencode run --format json`** — works, but one process per turn, no permission replies, no interrupt, weaker reconciliation. Kept only as a documented fallback idea.
* **Background service (`service.json` password)** — works, but requires reading another app's secret file and shares execution with the desktop UI. SleepPilot instead launches its **own** loopback-only server with a fresh random password (same mechanism as OpenCode's own `--standalone`).

---

## 3. Recommendation and chosen architecture

No candidate is a suitable foundation (all are v1-only, terminal-only, non-Windows, or license-restricted, and none evaluates work by real evidence). SleepPilot is therefore implemented from scratch, **reusing ideas, not code**:

| Idea | Source |
|---|---|
| Fresh session per task with persisted, concise project state | opencode-ralph, willin/ralph |
| Task list with acceptance criteria | willin/ralph (PRD) |
| Planner / Developer / read-only QA roles, evidence bundle per iteration, repair-then-next | HarnessOfHarness |

**Chosen stack** (justification in `docs/ARCHITECTURE.md`):

* **Node.js ≥ 20, zero npm runtime dependencies** — Node is already installed; no supply-chain surface; built-in `fetch`, `node:test`.
* **OpenCode integration**: own private `opencode-cli serve` on `127.0.0.1:<random>` with a random per-launch `OPENCODE_PASSWORD` (memory only, never logged); thin HTTP + SSE client; startup capability check against `/openapi.json`; requires OpenCode **2.x** (1.x is detected and reported as unsupported rather than half-supported).
* **GUI**: local web UI served on loopback with a per-launch access token, opened in a Microsoft Edge `--app` window (falls back to the default browser). Native Windows folder picker through PowerShell/WinForms.
* **Persistence**: per-project JSON + JSONL under `%LOCALAPPDATA%\SleepPilot\` (atomic writes), nothing written into the user's project except by OpenCode itself.
* **Verification**: only executed evidence counts — user-approved commands, built-in syntax checks, a headless-Edge HTML smoke check. Reviewer verdicts from a model are recorded as opinions, never as verification.

## 4. Reused components and licenses

No third-party source code is copied or bundled. Runtime dependencies: Node.js (MIT-style, user-installed), OpenCode (MIT, user-installed, invoked as an external process), Microsoft Edge (installed with Windows, used as an app window and for headless HTML checks). See `THIRD_PARTY.md`.
