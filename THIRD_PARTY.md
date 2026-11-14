# Reused components, tools and ideas

SleepPilot contains **no copied third-party source code** and installs **no npm packages**. Everything under `src/`, `ui/`, `test/` and `docs/` was written for this project. The parsers (PE/ELF/Mach-O/ZIP), the API clients, the engine loop and the UI are original and dependency-free.

## External programs used at runtime (installed by the user, not redistributed)

| Component | How SleepPilot uses it | License / status | Obligation |
|---|---|---|---|
| Node.js ≥ 20.10 | Runtime | MIT-style; part of the user’s installation | None |
| OpenCode 2.x (optional) | Launched as a separate `opencode serve` process and spoken to over its HTTP/SSE API | MIT for the open-source project; the 2.x desktop build’s license was not re-verified | None — invoked, not redistributed |
| Claude Code CLI (optional) | `claude -p --output-format stream-json` child process | See the installed Anthropic distribution | None — invoked, not redistributed |
| Codex CLI (optional) | `codex exec --json` / `exec resume` child process | See the installed OpenAI distribution | None — invoked, not redistributed |
| GitHub CLI `gh` (optional) | `gh auth status`, `gh repo create`, repository details | MIT | None — invoked |
| DeepSeek Harness (optional) | `dsh --profile headless` child process, NDJSON stream | See the installed DSH distribution | None — invoked |
| Rust / Cargo (optional) | Compiles and tests generated Rust projects | MIT / Apache-2.0 | None |
| Microsoft Edge or Google Chrome (optional) | App window and headless HTML smoke check | Proprietary, ships with Windows / free browser | None — invoked |
| Windows PowerShell / WinForms (optional) | Native folder picker, keep-awake | Part of Windows | None |
| Git (optional) | Read-only `git status` / `rev-parse` / `diff` | GPL-2.0 | None — invoked as a separate program |
| Python 3 / 2.7 (optional) | `ast.parse` syntax checks | PSF | None |
| 7-Zip, objdump, radare2/Rizin, Ghidra, IDA, ilspycmd, de4dot (optional) | Analysis tools the agent may call | Various (GPL, Apache-2.0, proprietary) | Obtain and license them yourself; SleepPilot neither bundles nor installs them |

## Provider APIs

The built-in API engine speaks the public HTTP APIs of providers chosen by the user (DeepSeek, OpenAI, Anthropic, OpenRouter, Groq, Mistral, xAI, Ollama, LM Studio, vLLM, compatible gateways). It uses only their documented/observed request shapes; no provider SDK or code is bundled.

## Ideas and prior art (no code)

| Project | License | Idea credited |
|---|---|---|
| [Hona/opencode-ralph](https://github.com/Hona/opencode-ralph) | MIT | Fresh session per task with persisted plan state |
| [willin/ralph](https://github.com/willin/ralph) | MIT | Task list with explicit acceptance criteria |
| [Flesymeb/HarnessOfHarness](https://github.com/Flesymeb/HarnessOfHarness) | MIT / Apache-2.0 (hoh-lite) | Planner / Developer / read-only QA roles, evidence per iteration, repair-then-next |
| [morluto/rea](https://github.com/morluto/rea) — “Reverse Engineer Anything” | See upstream | The idea of giving an agent a reverse-engineering toolkit and a structured recon → explain → specify → rebuild loop. SleepPilot’s own recon/playbook is original and does not depend on REA; installing REA/MCP tools is optional and up to the user. |
| OpenCode 2.x documentation and `/openapi.json` | MIT / upstream docs | HTTP/SSE contract used by the OpenCode engine |

Ideas and general techniques are not subject to copyright; the projects above are credited because they informed the design.

## Not used / not copied

- **`@opencode/client`, `@opencode/sdk` 2.x** — official but version-locked to the server; SleepPilot uses a small hand-written client and validates operations against the running server.
- **code-yeongyu/oh-my-openagent** — Sustainable Use License (source-available); nothing was taken.
- **Commercial reverse-engineering suites** — not bundled, not downloaded, not licensed by SleepPilot.

## Fonts, images and icons

- `ui/icon.svg` is original.
- The screenshots in `docs/screenshots/` were captured from SleepPilot itself.
- The UI uses system fonts (Segoe UI, Cascadia Mono/Consolas fallbacks); no fonts are bundled.
