import fsp from 'node:fs/promises';
import path from 'node:path';
import { runFile } from '../util/proc.mjs';

let cargoCache;

/** Find the Rust toolchain without assuming it is on PATH. */
export async function detectCargo() {
  if (cargoCache !== undefined) return cargoCache;
  const home = process.env.USERPROFILE || process.env.HOME || '';
  const cargoHome = process.env.CARGO_HOME || (home ? path.join(home, '.cargo') : '');
  const candidates = [
    process.env.CARGO,
    'cargo',
    cargoHome ? path.join(cargoHome, 'bin', process.platform === 'win32' ? 'cargo.exe' : 'cargo') : null,
  ].filter(Boolean);
  for (const file of [...new Set(candidates)]) {
    const r = await runFile(file, ['--version'], { timeoutMs: 20_000 });
    if (!r.error && r.exitCode === 0) {
      const version = `${r.stdout || ''}${r.stderr || ''}`.trim().split('\n')[0];
      cargoCache = { found: true, file, version, source: file === 'cargo' ? 'PATH' : 'configured' };
      return cargoCache;
    }
  }
  cargoCache = { found: false, file: null, version: null, source: null };
  return cargoCache;
}

export function resetCargoCache() {
  cargoCache = undefined;
}

export function crateNameFrom(name) {
  const base = String(name || 'reverse-app')
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return /^[a-z]/.test(base) ? base : `app-${base || 'rust'}`;
}

/**
 * Create a minimal, dependency-free Cargo project that already builds. The agent will replace
 * the placeholder library with the reverse-engineered implementation; the tests stay meaningful.
 */
export async function scaffoldRustProject({ projectDir, name = null, force = false } = {}) {
  const dir = path.resolve(projectDir);
  await fsp.mkdir(dir, { recursive: true });
  const cargoFile = path.join(dir, 'Cargo.toml');
  if (!force && (await exists(cargoFile))) {
    const cargo = await detectCargo();
    return { scaffolded: false, reason: 'A Cargo project already exists.', cargo };
  }
  const crate = crateNameFrom(name || path.basename(dir));
  const files = {
    'Cargo.toml': `[package]
name = "${crate}"
version = "0.1.0"
edition = "2021"
description = "Reverse-engineered reimplementation built with SleepPilot"
license = "MIT"

[lib]
name = "${crate.replace(/-/g, '_')}"
path = "src/lib.rs"

[[bin]]
name = "${crate}"
path = "src/main.rs"

[profile.release]
lto = true
codegen-units = 1
strip = true
`,
    'src/lib.rs': `//! ${crate} — implementation reconstructed from a documented specification.
//!
//! Keep the public API small and testable. Add modules as the specification grows.

/// Example entry point; replace it with the actual documented behaviour.
pub fn run(input: &str) -> String {
    format!("{}: {}", env!("CARGO_PKG_NAME"), input.trim())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn run_prefixes_input() {
        assert!(run("hello").ends_with("hello"));
    }
}
`,
    'src/main.rs': `use std::io::Read;

fn main() {
    let mut input = String::new();
    if std::io::stdin().read_to_string(&mut input).is_err() {
        eprintln!("failed to read stdin");
        std::process::exit(2);
    }
    println!("{}", ${crate.replace(/-/g, '_')}::run(&input));
}
`,
    'tests/acceptance.rs': `//! Behavioural tests derived from SPEC.md and the target's observed behaviour.
//! Add a test for every documented rule and test vector.

#[test]
fn scaffold_is_ready() {
    let value = ${crate.replace(/-/g, '_')}::run("test");
    assert!(!value.is_empty());
}
`,
    '.gitignore': `/target
**/*.rs.bk
Cargo.lock
`,
    'README.md': `# ${crate}

A Rust reimplementation produced with **SleepPilot — Sleep & Reverse & Rust It**.

The reverse-engineering dossier lives in this workspace (\`SPEC.md\`, \`INVENTORY.md\`,
\`ARCHITECTURE.md\`, \`FORMATS.md\`, \`ALGORITHMS.md\`). Build and test with:

\`\`\`sh
cargo test
cargo build --release
\`\`\`
`,
  };
  for (const [rel, content] of Object.entries(files)) {
    const file = path.join(dir, ...rel.split('/'));
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await fsp.writeFile(file, content, 'utf8');
  }
  const cargo = await detectCargo();
  let baseline = null;
  if (cargo.found) {
    baseline = await runFile(cargo.file, ['check', '--quiet'], { cwd: dir, timeoutMs: 180_000 });
  } else {
    await fsp.writeFile(
      path.join(dir, 'RUST_SETUP.md'),
      `# Rust toolchain not found\n\nSleepPilot created the Cargo project, but \`cargo\` is not available on this machine, so it cannot compile or test it.\n\nInstall Rust from https://rustup.rs/ (on Windows: the MSVC toolchain), then reopen the project. The Rust checks stay disabled until cargo is on PATH or \`CARGO\` points to it.\n`,
      'utf8',
    );
  }
  return {
    scaffolded: true,
    crate,
    dir,
    cargo,
    baseline: baseline ? { exitCode: baseline.exitCode, output: `${baseline.stdout || ''}${baseline.stderr || ''}`.slice(-4000) } : null,
  };
}

export async function runCargo(args, { cwd, timeoutMs = 600_000 } = {}) {
  const cargo = await detectCargo();
  if (!cargo.found) return { ok: false, error: 'cargo-not-found', output: 'cargo was not found. Install Rust from https://rustup.rs/ or set CARGO to cargo.exe.' };
  const r = await runFile(cargo.file, args, { cwd, timeoutMs });
  return {
    ok: !r.error && r.exitCode === 0,
    error: r.error ? r.error.message : null,
    exitCode: r.exitCode,
    output: `${r.stdout || ''}${r.stderr || ''}`.trim(),
    durationMs: r.durationMs,
  };
}

/** Cargo checks used by the run controller after each iteration. */
export function cargoChecks({ test = true, clippy = false } = {}) {
  const list = [
    { id: 'cargo-check', type: 'cargo', name: 'cargo check', cargo: 'check', enabled: true, approved: true, timeoutSec: 1800 },
  ];
  if (test) list.push({ id: 'cargo-test', type: 'cargo', name: 'cargo test', cargo: 'test', enabled: true, approved: true, timeoutSec: 3600 });
  if (clippy) list.push({ id: 'cargo-clippy', type: 'cargo', name: 'cargo clippy', cargo: 'clippy -- -D warnings', enabled: true, approved: true, timeoutSec: 1800 });
  return list;
}

export async function rustStatus() {
  const cargo = await detectCargo();
  const rustc = cargo.found ? await runFile('rustc', ['--version'], { timeoutMs: 20_000 }) : { error: true };
  return {
    cargo: cargo.found ? { file: cargo.file, version: cargo.version } : null,
    rustc: !rustc.error && rustc.exitCode === 0 ? `${rustc.stdout || ''}`.trim() : null,
    install: 'https://rustup.rs/',
  };
}

async function exists(p) {
  try {
    await fsp.access(p);
    return true;
  } catch {
    return false;
  }
}
