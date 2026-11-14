# Security

SleepPilot is a local, single-user application that drives an AI coding agent with real file and shell access on your machine. Treat it like a powerful automation tool, not a sandbox.

## Credentials

- **OpenCode engine** — SleepPilot does not ask for, read or store OpenCode credentials. It starts its own `opencode serve` on `127.0.0.1` with a random per-launch password; the password exists only in memory and is registered with the log redactor. OpenCode's credential files are never read.
- **API engine** — provider API keys are stored in `credentials.json` under the SleepPilot data folder (`%LOCALAPPDATA%\SleepPilot` on Windows), separate from `settings.json`. The file is created with `0600` permissions where the OS supports it. Keys are never returned to the browser; the UI only sees `hasKey`. Environment variables are used as a fallback and are never copied to disk.
- **Claude Code / Codex CLI** — SleepPilot runs the installed CLIs and reuses their own login. It does not read, copy or store their credential files. The CLIs' own permission/sandbox settings govern the tools they run.
- **DeepSeek Harness** — environment values such as `DEEPSEEK_API_KEY` can be stored in the same credential store and are passed only to the `dsh` child process.
- **GitHub** — no GitHub token is stored. Repository creation and commit/push reuse the GitHub CLI (`gh auth login`) and the machine's existing Git credentials, and only after an explicit user action.
- **Logs and reports** — every persisted string passes through a redactor that masks passwords, tokens, API-key shapes and registered runtime secrets.

## UI server

- `127.0.0.1` only.
- A random 24-byte per-launch token is exchanged once (`/?t=…`) for an `HttpOnly; SameSite=Strict` cookie.
- The `Host` header must be the loopback address (DNS-rebinding defence).
- State-changing requests require `X-SleepPilot: 1` (cross-site form defence).
- CSP `default-src 'self'`; all UI text is HTML-escaped.
- The token is kept in `app-state.json` so a second launch can reopen the window. Any process running as the same user can read it; that is the same trust boundary as the rest of the data folder.

## What the agent may do

SleepPilot drives an agent that edits files and runs commands in the project folder you choose.

| Profile | Behaviour |
|---|---|
| Ask everything | All commands and outside paths ask. |
| Supervised | Reads, builds and common test commands run freely; other commands ask. |
| Full autonomy | The agent asks nothing except a small always-deny list (Git history rewriting, publishing, bulk deletes, registry/system commands). |
| Unrestricted | No permission checks, no deny list. Everything is your responsibility. |

Also available:

- **Protected paths** per project (for example a read-only analysis target).
- **Parallel edit scopes** that restrict each developer to its task's files.
- **Pre-run backup** and a **no automatic commit/push/revert** default; GitHub push is an explicit button.
- **Read-only** Manager/Reviewer sessions.
- **Scout** reads project files and program headers/strings only; it never modifies the project or calls a model.

The `Full autonomy` profile is powerful by design. Use it on projects you trust, keep the backup on, and review changes before committing. `Unrestricted` intentionally removes all remaining guardrails.

## Reverse engineering

Sleep & Reverse & Rust It treats the target as read-only evidence, records SHA-1 hashes and re-verifies them at the end of a run. The tool does not impose subject-matter restrictions beyond requiring you to confirm that you are authorized to analyse the target. **Authorization, licensing and compliance with applicable law are your responsibility.** Do not use SleepPilot against systems you do not own or have permission to test.

For untrusted binaries, use an isolated virtual machine. SleepPilot is not a malware-analysis sandbox.

## Reporting a vulnerability

Please do not open a public issue for security problems. Use GitHub's private vulnerability reporting (“Security” tab → “Report a vulnerability”) on this repository. Include the version, OS, engine, and steps to reproduce.
