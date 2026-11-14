# Limitations and non-goals

SleepPilot is deliberately a local, dependency-free, single-user application. Some limits are design choices, not bugs.

## Orchestration

- **One active run per project, multiple projects at once.** The default global limit is 3 (configurable). Parallel developers still happen *inside* one run; very large concurrent runs share CPU, memory and provider rate limits.
- **The Manager is a model.** Plans, decisions and reviews can be wrong. Verification comes from executed checks; the manager only chooses what to do next.
- **Costs are estimates.** OpenCode reports API-equivalent cost; API providers report tokens but often no cost. SleepPilot estimates only when prices are configured and never claims an invoice.
- **Time is measured as active time.** Pauses are excluded. Overtime is bounded.
- **No automatic commit/push/revert.** The GitHub card can commit and push, but only after an explicit click and confirmation. In the *Full autonomy* profile a small deny list still blocks Git history rewriting, publishing, formatting disks and shutdown; *Unrestricted* removes it and is entirely your responsibility.
- **Recovery is bounded.** Repeated crashes stop automatic recovery after `MAX_CRASH_RECOVERIES` and wait for a person. A turn that was in flight when the process died is reconciled as interrupted, not replayed.
- **The closing report is prose.** It is a model-written summary and may contain mistakes; the measured sections of the report are the source of truth.

## Engines

- **OpenCode 2.x only.** 1.x has a different API and is reported as unsupported rather than half-supported.
- **Claude Code and Codex are external agents.** SleepPilot supervises their turns and evaluates the resulting files, but their internal tool loop, permission prompts, MCP servers and context management remain theirs. In headless mode their CLI permission/sandbox setting is the boundary; SleepPilot cannot answer a Claude/Codex permission prompt.
- **The built-in API harness is not an OpenCode replacement.** It has a focused tool set and no LSP, no MCP client, no multi-file patch DSL and no subagents. It talks to chat-completion providers, nothing else.
- **Provider coverage varies.** Native tool calling, streaming and usage reporting depend on the provider. Local models with weak tool calling may loop or ignore tools; the step cap and retry logic keep the run safe.
- **Anthropic support** covers Messages API streaming and tool use; provider-specific features such as prompt caching flags are not exposed.
- **DeepSeek Harness** is integrated through its `headless` profile. Its internal tools, permissions and models are managed by DSH; SleepPilot supervises at the task level and cannot answer DSH permission prompts itself.
- **The command harness is one process per turn.** It has no session protocol; use the API/Claude/Codex/DSH/OpenCode engines for long multi-turn repairs.
- **Scope recommendations are heuristics.** File counts and line counts are useful, but they cannot know how hard the actual feature is. Treat the recommended time as a starting point.

## Verification

- **A passing check is evidence of that check, not of correctness.** A syntax check does not prove semantics; a command check only proves the command exited 0.
- **HTML smoke** needs Microsoft Edge/Chrome and only covers load + console/resource errors.
- **Citations** prove a cited line exists, not that the prose interprets it correctly.
- **No coverage measurement, no formal verification.**
- **Rust checks require a local cargo.** A missing toolchain disables those checks; it does not silently pass them.

## Reverse & Rust

- **Static analysis only by default.** SleepPilot does not run the target; runtime behaviour must be evidenced by tools you choose.
- **Reconnaissance is not a decompiler.** It parses headers, imports/exports, sections, strings and archives. For real disassembly/decompilation, install objdump/rizin/Ghidra and let the agent run them.
- **Packed/obfuscated binaries** will look like high-entropy sections. Unpacking is a task for the agent and external tools.
- **The mirror summarizes over-long lines.** Very large single-line blobs are described, not copied into the model’s context; some detail is intentionally lost.
- **Rust It produces a reimplementation, not a byte-identical clone.** The spec and tests define what is reproduced. Assets, proprietary data and undocumented behaviour are not magically recovered.
- **Legal responsibility stays with you.** Authorization, licensing and applicable law are not automated.

## Platform

- **Windows is the primary target.** The Edge app window, native folder picker, keep-awake and taskkill process-tree logic are Windows-specific. The UI, API/Claude/Codex/DSH/CLI engines, CLI and tests work on Linux/macOS, but some niceties (folder picker, app window) fall back or are unavailable.
- **Architecture follows Node.js.** SleepPilot has no native binary; `process.arch` reports the installed Node architecture (64-bit Node is recommended). The app is not compiled as a 32-bit or 64-bit executable.
- **No installer.** `SleepPilot.cmd` / `sleeppilot.sh` plus Node are the distribution.
- **No auto-update.** Update by pulling the repository.

## Deliberate non-goals

- Hosting SleepPilot as a multi-user web service.
- Storing or syncing secrets in the cloud.
- Bypassing provider billing, quotas or access controls.
- Being a general-purpose malware-analysis sandbox. Use an isolated VM for untrusted binaries.
