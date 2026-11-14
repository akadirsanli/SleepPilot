# Changelog

## 2.4.1 — green CI, Node 20 HTML checks and a sharper public README

### Fixed

- **HTML smoke checks now work on Node 20.** The DevTools connection used the
  browser `WebSocket` global, which Node only provides from v22. SleepPilot now
  uses a small RFC 6455 fallback when the global is unavailable.
- **Unavailable HTML checks are reported as skipped, not failed.** A missing
  browser or DevTools connection is an environment limitation, not evidence that
  the project is broken.
- **Flaky sleep-mode recovery test.** The test asserted the paused state after a
  100 ms auto-resume timer; on faster CI runners the timer could fire first. It
  now uses a deterministic 3-second window.

### Changed

- CI jobs have explicit timeouts and read-only repository permissions.
- README adds a product tour, CI status, legal/affiliation disclosure and a
  clearer honest-limits section.
- SECURITY.md documents network access; CONTRIBUTING.md states inbound =
  outbound MIT licensing.

## 2.4.0 — multi-harness routing, per-harness effort and quota fallback

### Added

- **Multi-harness delegation** — `project.settings.harnessRouting`, `rolePins` and `modelProfiles`
  route Manager, Developer, Reviewer, closing and preflight turns to different registered engines.
  `EngineManager` remains the owner of the adapters; `RunController` resolves the route and creates
  role-scoped sessions on the selected harness. Routing is disabled by default and preserves the
  existing single-engine behavior.
- **Per-harness model profiles and reasoning effort** — API supports the exact DeepSeek effort
  vocabulary (`off`, `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`, `ultra`); Claude
  Code uses its real `--effort low|medium|high|xhigh|max`; Codex uses
  `-c model_reasoning_effort=minimal|low|medium|high`. DSH, OpenCode and Command reject effort
  requests instead of silently ignoring them. Unsupported profiles fail at save/start with the
  supported values in the error.
- **Per-role harness/model pinning and adapter-level read-only roles** — Manager, Reviewer, closing
  and preflight sessions are restricted to OpenCode, Claude Code, Codex or the API harness, all of
  which enforce read-only in their own permission/sandbox layer. DSH/Command are rejected for these
  roles. Parallel developers still use the existing file-scope analysis and only run together when
  their scopes do not overlap.
- **Quota-aware fallback chain** — a provider/quota failure (or a harness already in a quota window)
  persists the failed turn, records a `routingSwitches` entry, creates a new session on the next
  route and continues the same task/iteration. Claude's 5-hour exhaustion is detected from its
  stream-json/result/stderr messages and reset hints, not a fixed timer. The controller only pauses
  when every route is blocked. Explicit user resume clears the recorded window; sleep-mode retry
  keeps it.
- **Headless routing surface** — `sleeppilot route --project <path> --task <type> --dry-run --json`
  resolves every role, profile, effort and fallback step without connecting. `--model-profile` is
  available on `ask` and `run`. Every NDJSON turn includes `harness`, `modelProfile` and
  `fallbackStep`; run records include `activeHarness`, `sessionRoutes`, `routingSwitches` and
  `quota`.
- **UI** — Project settings include role harness/profile pins, a fallback chain, the working window
  and editable model-profile JSON; run/turn views show the active harness and switches.

### Tests

- `test/unit/routing.test.mjs` — resolution order, exact effort vocabularies, reset parsing, quota
  `canUse`, adapter flags and DSH's loud refusal.
- `test/integration/routing-fallback.test.mjs` — real `RunController` with fake Claude/DSH/API
  adapters; Claude quota triggers a switch to DSH, the same task completes, the Manager continues on
  API, and per-turn routing fields are asserted.
- `test/integration/cli-route.test.mjs` — `route --dry-run --json` and unsupported-effort failure.

## 2.3.0 — reliable non-OpenCode engines, Scout agent and deeper toolchain detection

### Fixed

- **Claude Code / Codex / DSH “file argument must be of type string. Received null”** — saving global settings (`cliPath: null`, meaning auto-detect) no longer erases the executable path detected at connect time. Reproduced with a real Codex model check and fixed; the same guard covers DSH. A missing path now produces a clear configuration error instead of a raw spawn failure.
- Command-harness turns with no command now fail with a configuration message rather than spawning an empty command.
- Navigation no longer moves the active-nav highlight while a guarded screen load is still running; project scope/GitHub/Scout loaders ignore duplicate in-flight requests.
- Toolchain probes use a 4-second cap and more parallelism, so Scout/Project screens load faster when an optional executable hangs.
- Release preparation: updated package metadata, PR/issue templates, CI doctor behaviour, launcher encoding, privacy-safe demo screenshots, and added `docs/PUBLISHING.md`.

### Added

- **Scout agent** — a deterministic internal agent that reads project manifests/source files and program headers/imports/strings. It returns the stack, frameworks, required tools (with live install status), suggested checks, risks and confidence. The Project screen shows a Scout card; its checks can be imported in one click.
- **Toolchain detection from files, no EXE picker** — Settings → Toolchain now has *Detect stack* (project folder) and *Detect runtime* (program file/folder). Project Scout detects Node/TypeScript, Rust, Python, Go, .NET/Unity, Java/Kotlin, C/C++, Docker, Godot, Unreal, Swift, Dart/Flutter and more. Program Scout detects PE/ELF/Mach-O, .NET, Unity, Electron/Node, Python-packed, Java, Go, Rust and native runtimes.
- **Practical toolchain tools** — npm, pnpm, .NET SDK, Java, Go, CMake, Make, Docker, objdump, UPX and ilspycmd in the catalogue; install links and live status in Scout results; copyable diagnostics.
- Toolchain probes now run in parallel (seconds instead of serial waits).
- Scout profile is recorded on the run and in its report; Reverse & Rust preview includes the detected runtime and required tools.

## 2.2.0 — Claude Code, Codex, scope analysis, multi-project work and GitHub

### Added

- **Claude Code engine** — runs the installed `claude` CLI headlessly (`-p --output-format stream-json`), reuses its login/tools/MCP setup, streams text/reasoning/tool events, records usage and cost, and resumes the same Claude session. Read-only roles use plan mode; developer roles map to accept-edits/bypass.
- **Codex CLI engine** — runs `codex exec --json`, resumes the Codex thread with `exec resume`, streams command/file-change events and token usage, and reuses Codex's own login and sandbox. Read-only roles use the read-only sandbox.
- **Upfront scope analysis** — Project and Reverse & Rust screens measure files/code/tests/binaries/risks and recommend a time limit, iteration count, parallelism and scope. One click applies the recommendation.
- **Concurrent projects** — one run per project, configurable global limit (default 3), active-run list on Home and a run switcher. The store, engine sessions and shutdown/recovery paths are all multi-controller.
- **GitHub integration** — repository/remote/CLI status, initialise Git, create a repository with `gh`, and explicit commit & push. Nothing is pushed automatically; no GitHub token is stored.
- **Insights** — active hours, measured lines written, verified/failed tasks, tokens/cost, 14-day activity, most-active projects, engines/models and recent runs.
- **UI motion and feedback** — global progress bar, spinners on buttons, skeleton scope/toolchain cards, pulsing live-run state, animated task segments, per-turn and run-level tok/s.
- **Right-click app menu** — close SleepPilot (with an active-run warning), close the window, or reload the interface.
- Architecture/Node version shown in Settings → App and `doctor` (`process.arch`); the app has no 32/64-bit build of its own.
- Tests: fake Claude Code/Codex CLIs, scope analysis, GitHub helpers, multi-project concurrency.

### Fixed

- Settings no longer waits for the full toolchain probe before rendering; results are cached for 30 seconds and refresh explicitly.
- Claude/Codex engine process arguments for resumed turns (Codex resume rejects `--color`/`--sandbox`).
- Small-model task placeholders copied from JSON examples are filtered out.
- A developer turn that returns text without using any tool is nudged twice before being accepted.
- Codex/Claude auth errors now point at the right login command.
- Objective changes are only blocked for the project whose run is active, not for every active project.
- "Hedefi uygula" fallback task title is English again.

## 2.1.0 — reliable toolchain detection and local AI

### Added

- **Improved toolchain detection** — PATH plus common install locations (`~/.cargo/bin`, Program Files, LocalAppData, Scoop, npm/pnpm global, Python `Python3*`), per-row detection attempts under **Why?**, and manual *Installed / Missing / Ignore* overrides with optional path verification.
- **Ollama local AI** — Settings → Local AI detects the binary/service, lists models from `/api/tags`, and adds an `ollama` provider with one click (no key). Fully local turns verified end-to-end.
- `test/fake-ollama`, `test/unit/toolchain.test.mjs`, `test/integration/ollama.test.mjs`.

### Fixed

- Cargo/rustc were reported missing when installed by rustup outside PATH; they are now found via `~/.cargo/bin` and `CARGO_HOME`.
- GUI tools (Ghidra, ImHex) can be found by directory and marked manually; a wrong manual path is flagged instead of silently accepted.

## 2.0.0 — multi-engine harness and Sleep & Reverse & Rust It

### Added

- **Engine layer** with one contract and four backends:
  - **Built-in API harness** — OpenAI-compatible and Anthropic streaming/tool calling, real file/shell/web tools, permissions, session persistence and crash recovery.
  - **DeepSeek Harness bridge** — local `dsh --profile headless` NDJSON integration with session continuation.
  - **Command harness** — any CLI agent via a command template.
- **Sleep & Reverse & Rust It**:
  - binary-aware reconnaissance for PE/COFF, ELF, Mach-O, ZIP/JAR/APK and WASM;
  - section/import/export/string analysis, entropy, packer hints, tool detection;
  - `_recon/RECON.md`, `recon.json`, `binaries.json`, `TOOLS.md`;
  - implementation-ready `SPEC.md` workflow;
  - dependency-free Rust scaffold (library, CLI, acceptance tests);
  - `cargo check` / `cargo test` check type with automatic cargo detection;
  - document checks and target-integrity verification.
- **Headless CLI**: `run`, `ask`, `reverse`, `engines`, `doctor`, `web`, JSON/NDJSON output.
- **New single-page UI** — Home, Project, Run, Report, Reverse & Rust, Settings; English only; engine/provider management.
- **Global settings model** with API provider presets, credential store, DSH/CLI configuration.
- **New tests** — fake OpenAI-compatible provider, fake DSH CLI, API engine end-to-end tool loop, reverse recon and Rust checks.
- **Repository files** — CONTRIBUTING, CODE_OF_CONDUCT, CHANGELOG, issue/PR templates, screenshots, editor config, cross-platform launcher.

### Changed

- Permission rulesets now apply to the built-in API engine as well; reads inside the project never ask.
- Added the **Unrestricted** profile and removed subject-matter limits from the reverse playbook (authorization remains the user’s responsibility).
- Reports and logs are engine-neutral instead of OpenCode-specific.
- `SleepPilot.cmd` now handles Node version parsing more robustly; added `sleeppilot.sh`.
- Research notes moved to `docs/OPENCODE-RESEARCH.md`.

### Fixed

- `.cmd`/`.bat` spawning with paths containing spaces (DeepSeek Harness detection).
- CLI exit assertion on Windows (graceful exit after flushing).
- Raw runner now ignores Rust `target/` and other build output during inspection/snapshots.
- Various English-only and consistency fixes.

## 0.1.0 — initial OpenCode supervisor

- Manager / Developer / Reviewer orchestration for OpenCode 2.x.
- Sleep mode, supervisor, crash recovery, evidence-based checks, reports, UI.
