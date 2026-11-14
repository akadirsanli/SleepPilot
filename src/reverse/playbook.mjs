import { MIRROR_DIR, MAP_FILE } from '../project/target-mirror.mjs';
import { RECON_DIR } from './recon.mjs';

/**
 * The "Sleep & Reverse & Rust It" playbook.
 *
 * Modes:
 *   analyze  — understand and document the target, with cited evidence.
 *   rust     — understand it, write an implementation-ready SPEC.md, then build a Rust
 *              reimplementation from scratch and prove it with cargo check/test.
 *
 * This is a general reverse-engineering and reimplementation workflow. The user confirms they
 * are authorized to analyse the target; the tool does not impose further subject-matter limits.
 */
export const REVERSE_MODES = [
  {
    id: 'analyze',
    label: 'Analyze',
    tagline: 'Map the program and write a cited technical dossier.',
    description: 'Inventory, architecture, algorithms, file formats and extension points. Every claim cites the target. No code changes to the target.',
  },
  {
    id: 'rust',
    label: 'Analyze + Rust It',
    tagline: 'Reverse-engineer it, specify it, then rebuild it in Rust.',
    description: 'The complete pipeline: cited analysis → implementation-ready SPEC.md → a Rust crate written from scratch → cargo check/test until it builds and passes.',
    recommended: true,
  },
];

export const isRustMode = (mode) => mode === 'rust';

export function reverseObjective({ targetPath, workDir, goals, mode = 'rust', recon = null }) {
  const rust = isRustMode(mode);
  const targetIsFile = recon?.targetIsFile;
  return `You are reverse-engineering an existing program and turning what you learn into a precise technical result. You work in a dedicated workspace; the original target is read-only.

TARGET (original program, read-only): ${targetPath}${targetIsFile ? ' (single file)' : ''}
WORKSPACE (write everything here): ${workDir}

READ FIRST — SleepPilot already did the mechanical reconnaissance for you:
- ${RECON_DIR}/RECON.md — the overview: inventory, binary headers, imports/exports, notable strings, available tools.
- ${RECON_DIR}/recon.json — the same data structured, with offsets and hashes.
- ${RECON_DIR}/TOOLS.md — which analysis tools exist on this machine.
- ${MIRROR_DIR}/${MAP_FILE} — every text file with size, hash, script blocks, symbol index and summarized embedded blobs.
- ${MIRROR_DIR}/ — a read-only copy of the target's text files with the SAME line numbers as the original.

GOAL:
${String(goals || '').trim() || (rust ? 'Understand the program completely and rebuild its behaviour as a working Rust application.' : 'Produce a thorough, evidence-based map of the program.')}

METHOD (follow the phases in order; this is the REA loop: Recon → Explain → Abstract → Specify → Rebuild → Verify)
1. RECON — confirm what the program is, its entry points, stack, file layout and dependencies. Use RECON.md first; do not re-derive what it already measured.
2. EXPLAIN — trace the user-visible behaviour and the main data flow from input to output. Write INVENTORY.md and ARCHITECTURE.md.
3. ABSTRACT — identify the core algorithms, rules, thresholds, constants, state machines, formats and protocols. Write ALGORITHMS.md and FORMATS.md with concrete values.
4. SPECIFY — write SPEC.md: an implementation-ready description. For every component: inputs, outputs, data structures, edge cases, error behaviour, constants and at least a few concrete test vectors.
5. REBUILD${rust ? ' — implement the specification as a Rust application in this workspace. The Cargo project is already scaffolded (Cargo.toml, src/lib.rs, src/main.rs, tests/). Keep the library API in src/lib.rs testable; put the CLI in src/main.rs. Add tests for every documented behaviour and test vector. Run `cargo check` and `cargo test` yourself after each meaningful change.' : ' — write a small, safe analysis script or a documented mod/config starting point that demonstrates one extension without touching the target.'}
6. VERIFY — the task only counts as verified when SleepPilot's checks pass: cargo check, cargo test, the document checks and the citation check. Never claim a test passed unless you ran it and saw the result.

${rust ? `RUST IMPLEMENTATION RULES
- Rust edition 2021. Prefer std; add a dependency only when it is clearly justified and can be fetched in this environment.
- Do not edit or regenerate files under ${MIRROR_DIR}/ or ${RECON_DIR}/, and never write to the target path.
- Keep \`cargo check\` and \`cargo test\` green. If a build fails, fix the failure before starting a new feature.
- Split work into small modules (e.g. src/format.rs, src/engine.rs, src/cli.rs) with unit tests beside them.
- Match the documented behaviour, not a guess: when the spec and the code disagree, update the spec with evidence first.
- The binary produced by the Cargo project is the deliverable. Build it with \`cargo build --release\` near the end.
` : ''}EVIDENCE RULES (enforced by SleepPilot)
- Every claim about text/source cites \`path/file.ext:LINE\` or \`path/file.ext:START-END\`, relative to the target root. Invented line numbers fail the check.
- For binary evidence cite \`binary:path\` plus a section name, import, export or string offset from recon.json. Do not invent addresses.
- Mark anything inferred, guessed or uncertain as such. Say what you could not determine instead of filling the gap.
- Do not cite the mirror path in documents; cite the target-relative path (e.g. \`src/main.rs:42\`).`;
}

export function reverseRules() {
  return `1. The target folder is READ-ONLY and is protected by SleepPilot. Read text through ${MIRROR_DIR}/; use ${RECON_DIR}/ for binary facts. Never edit, rename or delete the target, ${MIRROR_DIR}/ or ${RECON_DIR}/.
2. Work only inside the workspace. Keep temporary files inside the workspace, not in the target.
3. Documents must cite the target with \`file:LINE\` or \`file:START-END\` (relative to the target root). Binary claims cite \`binary:path\` plus a section/offset/import from recon.json.
4. Prefer static analysis. Do not run the target program unless the task explicitly asks and the environment allows it; never claim runtime behaviour you have not observed.
5. Follow the objective's phase order. One coherent analysis or implementation step per iteration.
6. You are responsible for having the right to analyse this target and for complying with applicable law. Do not use the workspace to attack third-party systems.
7. Preserve the existing Rust scaffold and keep the build green; do not delete tests to make a check pass.`;
}

export function reverseChecks(mode = 'rust', { cargo = true } = {}) {
  const rust = isRustMode(mode);
  const checks = [
    { id: 'cite-check', type: 'cite-check', name: 'Evidence citations (file:line exists)', enabled: true, approved: true },
    {
      id: 'doc-check',
      type: 'doc-check',
      name: rust ? 'Required documents (SPEC, INVENTORY, ARCHITECTURE)' : 'Required documents (INVENTORY, ARCHITECTURE, FORMATS)',
      entries: rust ? ['SPEC.md', 'INVENTORY.md', 'ARCHITECTURE.md'] : ['INVENTORY.md', 'ARCHITECTURE.md', 'FORMATS.md'],
      minBytes: 300,
      enabled: !rust,
      approved: true,
    },
    { id: 'py-syntax', type: 'py-syntax', name: 'Python syntax (analysis scripts)', enabled: true, approved: true },
  ];
  if (rust) {
    checks.push(
      { id: 'cargo-check', type: 'cargo', name: 'cargo check', cargo: 'check', enabled: !!cargo, approved: true, timeoutSec: 1800 },
      { id: 'cargo-test', type: 'cargo', name: 'cargo test', cargo: 'test', enabled: !!cargo, approved: true, timeoutSec: 3600 },
      {
        id: 'doc-check-spec',
        type: 'doc-check',
        name: 'Required documents (SPEC, INVENTORY, ARCHITECTURE)',
        entries: ['SPEC.md', 'INVENTORY.md', 'ARCHITECTURE.md'],
        minBytes: 300,
        enabled: true,
        approved: true,
      },
    );
  }
  return checks;
}

export function reverseSetupNotes() {
  return `The workspace is prepared automatically: ${MIRROR_DIR}/ (read-only text mirror), ${RECON_DIR}/ (reconnaissance), and, for the Rust mode, a Cargo project that already builds.`;
}
