# Sleep & Reverse & Rust It

A reverse-engineering and reimplementation workflow for programs you are authorized to analyse. The target is treated as **read-only evidence**; the deliverables are a cited dossier, an implementation-ready specification and — in Rust mode — a working Rust application verified by `cargo check` / `cargo test`.

> **Authorization and responsibility.** You confirm in the app (or with `--yes` on the CLI) that you have the right to analyse the target. SleepPilot does not impose additional subject-matter restrictions, and it is not a substitute for the law, a licence or a contract. You are responsible for the target and how you use the results.

## Modes

| Mode | Output |
|---|---|
| **Analyze** | `INVENTORY.md`, `ARCHITECTURE.md`, `ALGORITHMS.md`, `FORMATS.md`, `MODDING.md`, plus a small safe analysis script or documented starting point. |
| **Analyze + Rust It** (default) | Everything above, a `SPEC.md` with test vectors, and a Rust crate (`Cargo.toml`, `src/lib.rs`, `src/main.rs`, `tests/`) implemented from the spec. |

## Target scope preview

Before creating a workspace, click **Analyze target scope** on the Reverse & Rust screen. It reads only file names, sizes and magic headers and reports:

- total files, text vs binary files, the largest files and detected PE/ELF/Mach-O/ZIP formats;
- an estimated reconnaissance time;
- a recommended time limit for Analyze or Analyze + Rust;
- the program's runtime/framework from its own headers and strings — .NET/Unity, Electron/Node, Java, Python-packed, Go, Rust or native — with the RE tools it needs;
- risks such as a very large target, a binary-only folder or a target with no readable text.

Nothing is mirrored or modified by the preview. **Apply recommendation** fills the time limit; the full recon runs when the workspace is created.

## What is created

```
workspace/
  _target/                 read-only text mirror, original line numbers
    TARGET_MAP.md          files, hashes, script blocks, symbol index, long lines
    target-map.json
  _recon/                  machine-generated reconnaissance
    RECON.md               inventory, binaries, strings, tools, analysis order
    recon.json             structured facts (offsets, hashes, imports/exports)
    binaries.json          per-binary details
    TOOLS.md               which analysis tools exist on this machine
  INVENTORY.md             original program map
  ARCHITECTURE.md          components, data flow, start-up sequence
  ALGORITHMS.md            rules, thresholds, constants, state machines
  FORMATS.md               file and data formats with field layouts
  MODDING.md               legitimate extension points (when requested)
  SPEC.md                  implementation-ready specification + test vectors
  Cargo.toml               Rust crate (Rust mode)
  src/lib.rs, src/main.rs
  tests/acceptance.rs
  RUST_SETUP.md            only when cargo is missing
```

The target itself is never written to. SleepPilot adds it to the project’s protected paths and protects `_target/` and `_recon/` from edits. At the end of a run it re-hashes every target file and records the integrity result in the report.

## The reconnaissance pass

`src/reverse/recon.mjs` is dependency-free and static. It never executes the target.

- **Inventory** — every file, size, SHA-1, detected kind, extension histogram, largest files.
- **Text** — the mirror keeps line numbers stable; over-long lines (embedded base64, minified bundles) are replaced by a one-line summary that says what they are (WASM, ONNX, PDF, image, ZIP, font, known JS library…). `TARGET_MAP.md` indexes script/style blocks and symbols.
- **PE/COFF** — machine, subsystem, timestamp, sections with entropy, imports (DLL + functions), exports, CLR/.NET flag, PDB path, overlay bytes, packer hints.
- **ELF** — class, endianness, type, machine, entry, interpreter, needed libraries, sections, program headers, symbols, stripped flag.
- **Mach-O** — CPU, file type, linked dylibs, universal binary flag.
- **ZIP/JAR/APK** — central directory listing with sizes and compression.
- **WASM** — detected and labelled.
- **Strings** — ASCII and UTF-16LE, deduplicated, with offsets, classified as URLs, registry keys, paths, emails, IPs, versions, format strings, crypto names, API names, error messages, debug strings and secrets-named strings.
- **Tools** — cargo/rustc, Git, Python, Node, objdump, dumpbin, strings, radare2, Rizin, ilspycmd, de4dot, 7-Zip, Ghidra/IDA/Cutter directories.

Everything is written to `_recon/RECON.md` and `recon.json` first, so the agent spends its context on analysis rather than re-deriving headers. The agent can still run `bash` with any installed tool (objdump, rizin, Ghidra headless, …) on files it is authorized to analyse.

## Evidence rules

- Text claims: `path/file.ext:LINE` or `path/file.ext:START-END`, relative to the target root. The citation check verifies that the file and the line exist; an invented line fails the check.
- Binary claims: `binary:path` plus a section, import, export or string offset from `recon.json`. Addresses must not be invented.
- Inferred/uncertain claims are marked as such; unknown behaviour is stated as unknown.
- Reviewer verdicts and model “done” messages do not verify a task. Only executed checks do.

## The Rust implementation

The scaffold is deliberately minimal and dependency-free:

```toml
[package]
name = "reverse-app"
version = "0.1.0"
edition = "2021"

[lib]
path = "src/lib.rs"

[[bin]]
path = "src/main.rs"
```

- `src/lib.rs` is the testable library API.
- `src/main.rs` is a small stdin/stdout CLI.
- `tests/acceptance.rs` holds behavioural tests derived from `SPEC.md`.
- `cargo check` and `cargo test` are enabled as checks automatically when `cargo` is available.
- The agent is instructed to keep the build green, add modules and tests as the spec grows, and to build the release binary near the end.

### Cargo detection

SleepPilot looks for `CARGO`, `cargo` on `PATH`, then `%USERPROFILE%\.cargo\bin\cargo.exe` (or `$CARGO_HOME/bin/cargo`). If missing, the Rust checks are disabled with a clear message; install Rust from https://rustup.rs/ and reopen the project. The rest of the app (analysis docs) still works.

### What “Rust It” does not do

- It does not copy the original binary or its proprietary assets into the new application.
- It does not automatically match undocumented behaviour that was never observed or specified; those gaps stay explicit in `SPEC.md`.
- It does not guarantee legal clearance. The user provides authorization and decides what may be reproduced.

## Running it

### GUI

**Reverse & Rust → New workspace**:

1. target file or folder (folder picker for directories; type a single file path directly);
2. separate workspace folder;
3. goal (what to understand/rebuild);
4. mode and engine;
5. time limit and unattended option;
6. authorization checkbox;
7. **Prepare workspace**, then review the objective and start the run on the Project screen.

Large targets can take a minute to mirror and scan. The recon report is written before the run starts.

### CLI

```sh
node src/main.mjs reverse \
  --target C:\games\demo \
  --workspace C:\work\demo-re \
  --mode rust \
  --goal @goal.md \
  --hours 10 \
  --engine opencode \
  --yes --start
```

`--json` prints a machine-readable summary. Without `--start`, the workspace is prepared and the command exits; start it later with `run --project <workspace>`.

## Checks in a reverse run

| Check | Purpose |
|---|---|
| `cite-check` | Every `file:line` in changed Markdown points at a real line of the target. |
| `doc-check` | Required documents exist and have real content (`SPEC.md`, `INVENTORY.md`, `ARCHITECTURE.md`; or `FORMATS.md` in Analyze mode). |
| `py-syntax` | Analysis scripts parse. |
| `cargo check` | The Rust implementation compiles. |
| `cargo test` | The Rust tests pass. |
| `js-syntax` | Added analysis scripts with JavaScript parse. |

The run ends with a target-integrity check (SHA-1) shown in the report.

## Tips

- For a single file target, type the full path; the folder picker only returns directories.
- Put the workspace **outside** the target folder.
- Start with a narrow, concrete goal (one format, one workflow, one algorithm); broad goals produce broad dossiers.
- If the target is packed or highly optimized, use the recon report to decide which external tool the agent should run, and keep those commands scoped to files you may analyse.
- Review `SPEC.md` before the Rust phase grows; it is the contract the implementation is judged against.
- `cargo test` is the strongest evidence you will get. Keep tests in `tests/acceptance.rs` aligned with the spec.
