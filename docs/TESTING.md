# Testing

SleepPilot is tested with `node:test`. The default suite uses **fake engines** only: no account, no API key, no usage.

```sh
node test/run.mjs
```

CI runs the same command on Windows with Node 20/22/24.

## Unit tests

`test/unit/`:

| File | Covers |
|---|---|
| `core.test.mjs` | OpenCode detection, error classification, turn reconciliation, JSON extraction, task invariants, permission rulesets, snapshots/diffs, redaction, verification, settings sanitisation, model advice, generated-file detection, inspection, Python syntax checks, chat records, tool catalog |
| `resilience.test.mjs` | Bounded diff memory behaviour, supervisor restarts, freeze handling, memory guard, single-instance lock |
| `reverse.test.mjs` | Target mirror line fidelity, blob detection, citations, protected target paths |
| `reverse-rust.test.mjs` | String extraction, PE headers, recon bundle, ZIP listing, crate names, Rust scaffold, cargo/document checks, reverse workspace setup |
| `api-tools.test.mjs` | Built-in harness tools (read/write/edit/list/glob/grep/bash/status), permission profiles, protected paths, OpenAI/Anthropic message conversion, text tool protocol |
| `toolchain.test.mjs` | Candidate-path expansion, diagnostic attempts, manual installed/missing/ignored overrides, bad manual paths |
| `scope.test.mjs` | Project metrics (code/tests/TODOs), size class, time/iteration recommendation; reverse-target text/binary counts and recon estimate |
| `scout.test.mjs` | Scout project stack/manifests/checks and program-file PE/script runtime detection |
| `github.test.mjs` | Git detection, branch on an unborn repository, `ensureGitRepo`, no-remote push rejection, real commit/push to a local bare remote |
| `analytics.test.mjs` | Cross-project active time, line, task, token and cost aggregation; daily series and top-project ranking |

## Integration tests

`test/integration/` runs the real `RunController` and `SleepPilotApp` against test doubles:

| File | Covers |
|---|---|
| `run.test.mjs` | Plan → iterations → checks → verified → report; failing checks and repair; objective change; steering; pause/resume; permissions/questions; rejected permission; 429/quota; Go allowance; crash recovery; sleep mode; time limits; task carry-over; live settings; provider model fallback; overtime; token saving; chat records; report statistics; OpenCode startup 503; turn caps; plan review |
| `sleep-mode.test.mjs` | Unattended permission/question handling; closing report; reverse setup and target protection |
| `parallel.test.mjs` | Parallel developer waves, file scopes and command-check sharing |
| `resilience.test.mjs` | Connection loss, retries, restart/recovery paths |
| `web-and-adapter.test.mjs` | UI API, token auth, SSE, adapter capabilities |
| `api-engine.test.mjs` | Built-in API engine: real tool loop (write + read), plan, review, completion and persisted evidence against a fake OpenAI-compatible provider |
| `dsh-engine.test.mjs` | DSH engine: detection through a fake `dsh.cmd`, NDJSON turn, session persistence/recovery and detected-path retention |
| `ollama.test.mjs` | Ollama discovery (`/api/version`, `/api/tags`), provider creation and a local API-engine turn against a fake Ollama service |
| `claude-codex-engine.test.mjs` | Claude Code stream-json parsing, tool events, usage/cost, `--resume`, and detected CLI path surviving a null auto-detect settings save; Codex `exec`/`resume`, item events, usage, thread id and the same path regression |
| `multi-project.test.mjs` | Two projects run concurrently, each project rejects a second run, both finish and leave no active runs |

### Test doubles

- `test/fake-opencode/server.mjs` — a fake OpenCode 2.x HTTP/SSE server with sessions, permissions, forms, errors, durable messages and scripted actions.
- `test/fake-api/server.mjs` — a fake OpenAI-compatible provider that streams text and tool calls and returns manager/developer/reviewer replies based on the prompt.
- `test/fake-dsh/fake-dsh.mjs` — a fake `dsh` CLI that prints the NDJSON event stream.
- `test/fake-ollama/server.mjs` — a fake local Ollama service (`/api/version`, `/api/tags`, `/v1/models`, `/v1/chat/completions`).
- `test/fake-claude/claude.mjs` and `test/fake-codex/codex.mjs` — fake installed CLIs that emit the real stream-json/JSONL event shapes.
- `test/fixtures/fake-worker.mjs` — crash/hang helper for supervisor tests.

The fakes are **test doubles only**; nothing here pretends to be a real model or provider.

## Rust tests

When `cargo` is installed, `reverse-rust.test.mjs` runs a real `cargo check` and `cargo test` on a scaffolded project. Without cargo, those checks are asserted to report a clear “cargo not found” error and the rest of the suite still passes.

The Rust scaffold is intentionally dependency-free, so `cargo check`/`cargo test` work offline after the toolchain is installed.

## Real OpenCode tests

Opt-in, uses your own OpenCode 2.x installation and spends a small amount of usage:

```powershell
$env:SLEEPPILOT_REAL=1
node test/run.mjs real
```

These verify the real HTTP/SSE contract, capability detection and end-to-end turns. They are never part of CI.

## Manual smoke tests

```sh
# UI with the fake OpenCode server
node src/main.mjs --test-mode --no-open --no-supervisor

# Command line
node src/main.mjs doctor
node src/main.mjs engines --connect
node src/main.mjs ask --engine api --project . --prompt "Reply OK" --json
```

For the API engine, point `--base-url` at a local fake/real OpenAI-compatible endpoint. For Claude Code/Codex, install and sign in to the real CLI and connect the engine in Settings. For DSH, install DeepSeek Harness and connect the `dsh` engine in Settings.

## What is *not* tested

- Real third-party providers (OpenAI/Anthropic/DeepSeek) are not called by CI; only their protocols are.
- A real Ghidra/IDA headless run is not automated.
- The Edge app window (only the loopback UI/API) is not driven by CI.
