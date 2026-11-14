# Contributing

Thanks for helping SleepPilot. It is a small, dependency-free Node.js project; the barrier to a useful contribution is low.

## Ground rules

- **No runtime dependencies.** Use Node.js built-ins. A new dependency needs a very strong reason and a licence review.
- **Zero secrets in the repository.** Never commit `.env`, API keys, tokens, run data or local paths from your machine.
- **All code, UI text, comments and docs are in English.**
- **Evidence, not claims.** Verification logic must remain based on executed checks; a model’s self-report is never enough.
- **Keep the engines behind the contract.** Changes to the RunController should work for OpenCode, Claude Code, Codex, API, DSH and CLI.
- **Do not weaken security defaults silently.** New permission behaviour must be documented in `SECURITY.md` and `docs/USAGE.md`.

## Development setup

```sh
git clone <your fork>
cd SleepPilot
node --version        # 20.10 or newer
node test/run.mjs
```

No `npm install` is needed. For UI work:

```sh
node src/main.mjs --test-mode --no-open --no-supervisor --port 47901
# open http://127.0.0.1:47901/?t=<token printed by the app>
```

## What to test

- **Engine/protocol changes** — add or extend a fake server under `test/fake-*` and an integration test.
- **Orchestrator changes** — extend `test/integration/run.test.mjs` or `sleep-mode.test.mjs`; cover recovery, limits and failure paths.
- **Reverse/Rust changes** — extend `test/unit/reverse-rust.test.mjs`; cargo checks run automatically when Rust is installed.
- **UI changes** — check Home, Project, Run, Report, Insights, Reverse, Settings and the Toolchain/Scout panel in normal and narrow layouts; console must be free of errors.

## Pull requests

- Keep changes focused; separate refactors from behaviour changes.
- Describe the user-visible effect and the tests you ran.
- Update docs (`README.md`, `docs/*`) when behaviour or setup changes.
- Avoid committing generated files (`target/`, screenshots not needed for docs, logs, test homes).

## Reporting bugs

Use the GitHub issue templates and include:

- SleepPilot version and OS;
- engine (OpenCode / Claude Code / Codex / API provider / DSH / CLI);
- what you expected, what happened, and the relevant log lines;
- reproduction steps (redact keys and private paths).

Security issues: see [SECURITY.md](SECURITY.md), **do not** open a public issue.

## Code style

- ES modules, 2-space indentation, single quotes, semicolons.
- Small focused modules; comments explain *why*, not *what*.
- Error messages are user-facing: plain English, actionable, no secrets.
- Keep UI text short and unambiguous.

## License

By contributing you agree that your contribution is licensed under the MIT licence in [LICENSE](LICENSE).
