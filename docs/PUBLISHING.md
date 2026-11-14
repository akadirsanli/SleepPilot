# Publishing SleepPilot to GitHub

This is the release checklist for the repository itself. It assumes the account name **`akadirsanli`**; change it everywhere if your GitHub account is different.

## Pre-flight

```sh
node --version                  # 20.10 or newer
node test/run.mjs               # full suite: fake engines, no usage
node src/main.mjs doctor        # local environment report
git status --short              # must be empty
git log --oneline -1
```

Expected release state:

- version **2.4.0**
- clean `main` branch
- tag **`v2.4.0`**
- no `.env`, credentials, run data or local settings in the working tree
- CI workflow already at `.github/workflows/test.yml`

## Create the repository

With the GitHub CLI (recommended):

```sh
gh auth login
gh repo create akadirsanli/SleepPilot --public --source=. --remote=origin --push
git push origin v2.4.0
```

Without `gh`:

```sh
git remote add origin https://github.com/akadirsanli/SleepPilot.git
git push -u origin main
git push origin v2.4.0
```

If the repository already exists, use `git remote add origin` and `git push -u origin main`.

## Repository settings

Suggested description:

> Autonomous engineering harness with OpenCode, Claude Code, Codex, OpenAI-compatible APIs, DeepSeek Harness and custom CLIs. Scout toolchain detection, evidence-based verification, multi-project runs, GitHub publishing and Sleep & Reverse & Rust It.

Suggested topics:

```
autonomous-agents  agent-orchestrator  opencode  claude-code  codex-cli
deepseek  openai-compatible  ollama  rust  reverse-engineering
toolchain-detection  github  windows  nodejs
```

Enable:

- **Issues** and the provided issue templates
- **Discussions** (optional)
- **Private vulnerability reporting** (Security → Report a vulnerability)
- **Secret scanning** and **push protection**
- **Dependabot alerts** (no runtime dependencies, but useful for Actions)
- **Branch protection** on `main`: require the `tests` workflow, no force-push, no deletion
- **Actions permissions**: allow GitHub Actions; the workflow only uses `actions/checkout`, `actions/setup-node` and `dtolnay/rust-toolchain`

## Release v2.4.0

Create a GitHub Release from tag `v2.4.0` with a short summary and a link to `CHANGELOG.md`:

> 2.4.0 adds multi-harness routing with per-role engine/model/effort pins, exact Claude/Codex/API effort support, adapter-level read-only enforcement for Manager/Reviewer sessions, quota-aware fallback that detects Claude's 5-hour window and keeps a longer working window alive, and a headless `sleeppilot route --dry-run` surface with routing fields on every NDJSON turn.

Attach no generated binaries; SleepPilot is run from source with Node.js.

## Optional npm publication

`package.json` includes `bin`, `files`, `repository`, `homepage` and `bugs`. SleepPilot has no runtime dependencies. If publishing to npm:

```sh
npm pack --dry-run
npm publish --access public
```

Check the resulting file list first. Do not publish local screenshots of private projects.

## Privacy check

The documentation screenshots were captured with the demo project `C:\demo\SleepPilotDemo`, and the unused local `settings.png`/`report.png` screenshots were removed. Before making the repository public, confirm that no screenshot shows a private project name, API key, token or personal path you do not want to publish. The tracked text files contain no personal absolute paths or real credentials; the only key-shaped string is a fake fixture in `test/unit/core.test.mjs`.

SleepPilot's real data lives outside the repository (`%LOCALAPPDATA%\SleepPilot` on Windows, `~/.local/share/SleepPilot` elsewhere), and `.gitignore` excludes local settings, credentials, logs, build output and test homes.

## After the push

- Confirm the CI matrix passes on Windows for Node 20, 22 and 24, and the Rust job on Ubuntu.
- Open the repository page and check the README renders (screenshots, badges and tables).
- Check that the `tests` badge/actions are green.
- Create the `v2.4.0` release.
- Share the security policy and contribution guide with contributors.
