# Reused components, tools and ideas

SleepPilot contains **no copied third-party source code**. Everything under `src/`, `ui/`, `test/` and `docs/` was written for this project. The parsers (PE/ELF/Mach-O/ZIP), the API clients, the engine loop and the UI are original and dependency-free.

Since 2.7 the **office tools** (`src/office/`) use the npm packages below. They are installed by `npm install` (the launchers run it once on first start) and loaded only when an office feature is used, so the rest of SleepPilot works without them. All licenses allow commercial use; none is copyleft except MPL-2.0 (file-level: it applies only to resvg's own files, which SleepPilot does not modify).

## npm packages (office tools)

| Package | Used for | License |
|---|---|---|
| [exceljs](https://github.com/exceljs/exceljs) | Read/write .xlsx (styles, formulas, images) | MIT |
| [papaparse](https://github.com/mholt/PapaParse) | CSV parsing (delimiter detection) | MIT |
| [iconv-lite](https://github.com/ashtuchkin/iconv-lite) | Windows-1254 / ISO-8859-9 text | MIT |
| [pdfjs-dist](https://github.com/mozilla/pdf.js) (Mozilla pdf.js) | PDF text extraction | Apache-2.0 |
| [pdfmake](https://github.com/bpampuch/pdfmake) (with pdfkit) | PDF reports | MIT |
| Roboto font (shipped inside pdfmake) | PDF and chart text (accented and non-English letters) | Apache-2.0 |
| [pdf-lib](https://github.com/Hopding/pdf-lib) | PDF merge / page extraction | MIT |
| [docx](https://github.com/dolanmiu/docx) | Write .docx | MIT |
| [mammoth](https://github.com/mwilliamson/mammoth.js) | Read .docx | BSD-2-Clause |
| [pptxgenjs](https://github.com/gitbrent/PptxGenJS) | Write .pptx | MIT |
| [jszip](https://github.com/Stuk/jszip) | Read .pptx | MIT (dual MIT / GPL-3.0; used under MIT) |
| [pngjs](https://github.com/pngjs/pngjs) | PNG pixels (blank detection, image diff) | MIT |
| [Apache ECharts](https://github.com/apache/echarts) | Charts rendered to SVG on the server | Apache-2.0 |
| [@resvg/resvg-js](https://github.com/yisibl/resvg-js) | Chart SVG → PNG | MPL-2.0 |

Their own dependencies are listed in `package-lock.json`; each package's license file is in `node_modules/<package>/`. LibreOffice (optional, MPL-2.0) is only invoked as a separate program by `sleeppilot office convert`.

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
