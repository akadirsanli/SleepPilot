# Changelog

## 2.7.0 — office tools: Excel, CSV, Word, PowerPoint, PDF, PNG

### Added

- **Office tools** (`src/office/`, [docs/OFFICE.md](docs/OFFICE.md)) for building apps that work
  with office files. Read, create, check and compare Excel (.xlsx/.xlsm), CSV/TSV, Word, PowerPoint,
  PDF and PNG/JPEG files, including European data: legacy code pages and `;` CSVs, `1.234,56`
  numbers, `dd.mm.yyyy` dates, and full Unicode text in PDFs and charts.
- **Office check** (project → Checks → *+ Office output check*). Every office file a task created
  or changed must open cleanly and show no sign of a bug (`#REF!`, `#DIV/0!`, `NaN`, `undefined`,
  `[object Object]`, empty document). Your expectations must hold too: sheets, columns, row
  counts, cell values (exact, approximate, contains, min/max, formula), text, PDF pages, Word
  headings and tables, slides, image size, "not blank", "same as a reference file", and the share
  of planted anomalies found. The check is added by itself the first time a task writes an
  Excel/CSV/Word/PowerPoint/PDF file, and at the start of a run in an office project.
- **Synthetic test data with an answer key.** `sleeppilot office sample sales | expenses |
  invoices` writes realistic, fully fictitious sales, expense claims or customer invoices with
  planted anomalies (duplicate receipts, sales outside opening hours, refunds split below an
  approval threshold, staff selling to their own card, self-approval, split invoices, discounts
  over the maximum, wrong overdue status …), the rules in plain English and the answer key. Ordinary records never match a rule by
  accident (tested over many seeds), so an exact implementation scores 100% with no false
  positives.
- **Reports and charts.** Excel with formats, frozen filtered header, totals and chart images;
  Word, PDF and PowerPoint from Markdown or a block spec (headings, tables, key-value boxes,
  callouts, charts, images, classification label, page numbers); charts as PNG/SVG (Apache
  ECharts). PDFs can be merged and pages copied.
- **`sleeppilot office …` command** (inspect, table, text, create, verify, diff, sample, merge,
  pages, convert, status, mcp) — usable by you, scripts, CI and any agent's shell.
- **MCP server** (Settings → MCP → *SleepPilot office tools*): the same tools as `office_*` MCP
  tools for Claude Code and Codex; read-only roles get the reading tools only.
- **Scout** recognises office libraries (openpyxl, pandas, xlsxwriter, python-docx, pdfplumber,
  exceljs, pdf-lib, ClosedXML, EPPlus, NPOI, Open XML SDK, POI, iText, QuestPDF …); the developer
  is then told the exact commands for looking at and verifying office files.
- **The reviewer sees office files.** Binary files have no diff; the reviewer now gets
  SleepPilot's reading of every changed office file (sheets, first rows, column statistics, PDF
  text, problems).
- `doctor` reports whether the office tools are installed.

### Changed

- SleepPilot now has npm dependencies, used **only** by the office tools and loaded only when
  they are used (licenses in THIRD_PARTY.md: MIT, BSD, Apache-2.0, MPL-2.0). The launchers and
  `npm start` install them once; the rest of SleepPilot runs without them.

### Fixed

- **Recovery when OpenCode lost the session.** If, after a crash or restart,
  OpenCode no longer knows the session of the last instruction (HTTP 404
  `SessionNotFoundError`), recovery now treats the instruction as not delivered
  and retries the task in a new session. Before, the whole run ended as an
  unexpected error and the iteration stayed "running".
- **Flaky crash-recovery test.** The fake OpenCode server saved its state only
  every 100 ms, so a crash right after a session was created could bring the
  restarted server back without it. It now saves every change before answering,
  atomically, and the test waits for the "crashed" server to exit.

## 2.6.1 — no more browser windows piling up

### Fixed

- **Browsers left running after HTML checks.** On an HTML project (seen with a 3D
  game) many browser windows stayed open and kept the CPU at 100%. The check
  browser is now always closed: SleepPilot asks it to quit, kills its process
  tree, then every process still using its private profile folder. Leftovers from
  a session that crashed or was restarted are closed when SleepPilot starts and
  when it closes. Only one check browser runs at a time (parallel developers
  queue), it is muted, and it stays off-screen even if a browser ignores
  headless mode.
- **Agents may no longer open visible windows.** Commands such as `start`,
  `Start-Process`, `explorer`, `msedge`, `chrome`, `open` and `xdg-open` are
  denied for the developer (Claude Code: `--disallowedTools`), and the developer
  prompt says why: SleepPilot checks pages headlessly and the user has the live
  preview.

## 2.6.0 — assistant, second opinion, MCP and Android run check

### Added

- **Assistant (💬, lower-right corner).** Status cards that need no model call
  (engine not connected or signed out, paused or failed run and why, blocked
  tasks, missing goal/checks/workspace/Android tools — each with a button to the
  right screen) and a chat that answers questions about the app, the project and
  the run. It sees the live state and the text of the current screen. Choose a
  preferred model and two alternatives with ⚙ (saved); when one is not available
  the next answers. Read-only: it explains, it never changes anything.
- **Second opinion when stuck.** When a task fails the same way twice, is about to
  be blocked, changes nothing twice in a row, or stalls/times out, another engine
  (read-only) diagnoses it. Its advice opens the developer's next prompt; it can
  also split a too-big task or give up on one that cannot succeed here. At most two
  per task; on by default (Project → Advanced); billed as "Second opinion".
- **Reviewer screenshots on request.** The reviewer can ask to see up to three
  pages (desktop, phone or tablet size); SleepPilot takes them in a real browser
  and the reviewer judges with the images. Nothing is captured otherwise.
- **MCP servers for the agents** (Settings → MCP): Playwright, Context7 or any
  server, for Claude Code, Codex and OpenCode; developer-only or all roles; tokens
  are kept in the credential file.
- **Android run check.** After the build the app is installed and started on a USB
  phone or a headless emulator; a crash (with its stack trace) fails the task, and
  one screenshot is kept for the reviewer.
- **Sound** when a run finishes, fails or needs you (Settings → App, with a test
  button), and an option to hide the assistant button.

### Changed

- **The Run screen no longer flashes.** Live updates change only what differs
  instead of rebuilding the conversation, task list and status bar several times a
  second (measured: 30 entrance animations in 12 s for 3 messages → 5). Three or
  more tool calls in a row fold into one line. "Reduce motion" is respected.
- Notifications stack in the top-right corner instead of replacing each other.

### Fixed

- A closed panel with the hidden attribute could still cover the lower-right
  corner and block clicks there; the hidden attribute now always wins.
- The headless browser (HTML checks, screenshots) also starts when SleepPilot runs
  as root (Linux containers).

## 2.5.0 — workspace, live preview, Android APKs and phone access

### Added

- **Phone access is one click away.** A 📱 button in the top bar (and on the Home
  screen) shows whether phone access is on and opens its QR code; before, it was
  only reachable as the last-but-one tab of Settings.
- **Workspace.** Settings → Workspace (or the Home card) chooses one folder for all
  projects. SleepPilot keeps `projects/<name>/` and `exports/<name>/` inside it; a
  new project then needs only a name, and folder names are made safe for build
  tools (`Yarış Oyunu` → `yaris-oyunu`). Folders copied in by hand can be opened as
  projects with one click.
- **Live preview.** The new Preview screen shows a project's web app in a phone,
  tablet or desktop frame while the agent writes it. Static pages reload on every
  saved file and their JavaScript errors appear in a console panel; bundler
  projects (Vite, Next.js, …) run their own dev server after you approve the
  command. A run starts the static preview by itself, and finished projects can be
  previewed at any time.
- **Android APKs.** The new Android screen detects Android Studio's JDK and SDK
  (no PATH or system-variable changes), builds debug/release APKs and Play Store
  bundles with a live log, explains failed builds, inspects the produced APK
  (package, version, SDK levels, ABIs, signature), copies it to the workspace's
  `exports/` folder, creates and keeps a release signing key, installs and starts
  the app on a USB-connected phone and shows its error log. APKs can be downloaded
  straight to the phone over phone access. Gradle can be downloaded on request
  (SHA-256 verified).
- **Android build check.** After each task the Gradle build runs; a task is only
  verified when an APK is produced.
- **Project templates:** web app, native Kotlin Android app, HTML/JS app in an
  Android shell (previewed live, packaged as an APK), libGDX 3D Android game.
  Each comes with an `AGENTS.md`, the checks that prove the work and pinned
  versions. See [docs/ANDROID.md](docs/ANDROID.md).
- Scout and the toolchain screen recognise Android projects, Android Studio, the
  Android SDK, adb and Gradle.

- **Phone access.** Settings → Phone shows a QR code. Scan it with your phone and
  you can watch and control runs from the phone: start, pause, stop, steer, answer
  permissions and questions. It works over [Tailscale](https://tailscale.com), so
  only your own devices can connect, from home or away; SleepPilot is never
  opened to the Wi-Fi or the internet. It is off until you turn it on. The phone
  keeps its sign-in across restarts, and "Sign out all phones" makes a new QR code.
  The phone cannot see API keys, open dialogs on the PC, close the app or change
  phone access.
- A dependency-free QR encoder (`src/util/qr.mjs`).

### Fixed

- **Claude Code / Codex sign-in status.** A plain-text "Not logged in" was read as
  *signed in* because it contains "logged in". The engine now shows "not signed
  in", and the pause message says how to sign in (`claude auth login`, then
  `claude auth status`).
- On narrow screens, a wide table or long path no longer widens the whole page.

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
