/**
 * "Sleep & Reverse": a specialized objective + rules for understanding and documenting a program
 * (a game, an app, a module system…) for interoperability, modding, file-format work or learning.
 *
 * SAFETY BY DESIGN:
 *  - The TARGET folder is never touched: the agent has no access to it at all (protected path).
 *    It reads a read-only MIRROR that SleepPilot builds inside the workspace (`_target/`, see
 *    project/target-mirror.mjs) and writes its findings next to it. At the end of the run
 *    SleepPilot verifies the target's file hashes.
 *  - The objective is scoped to analysis, documentation and a modding/extension starting point.
 *    It never asks to defeat copy protection / DRM, remove license or activation checks, bypass
 *    anti-cheat, or otherwise circumvent a technical protection measure.
 *  - The user confirms, in the setup, that they have the right to analyse the target.
 */
import { languageName } from './prompts.mjs';
import { MIRROR_DIR, MAP_FILE } from '../project/target-mirror.mjs';

/** Build the objective text from the user's goals. language = document language code ('en', 'tr'). */
export function reverseObjective({ targetDir, workDir, goals, language = 'en' }) {
  const g = String(goals || '').trim();
  return `You are documenting and understanding an existing program for interoperability / modding / learning. You do NOT modify the program.

TARGET (the original program, for reference only): ${targetDir}
WORKSPACE (project folder; write your analysis here): ${workDir}
MIRROR (read the program HERE): ${MIRROR_DIR}/ — a read-only copy that SleepPilot made of the target's text files, with the SAME line numbers as the original. Over-long lines (embedded base64 blobs, minified bundles) are replaced by a one-line summary.
MAP: ${MIRROR_DIR}/${MAP_FILE} — every file with size and hash, what each embedded blob is (decoded type and size), script/style blocks with line ranges, and an index of functions, classes and event listeners with line numbers. Read it FIRST; it saves you most of the exploration.

GOAL (what the user wants to understand / be able to do):
${g || 'Produce a thorough map of the program so it can be understood and extended.'}

Work in priority order and write every document into the workspace root, in ${languageName(language)}:
1. INVENTORY.md — structure, technologies, entry points, embedded resources (use the MAP; do not re-derive sizes or types by hand).
2. ARCHITECTURE.md — modules/components and how they talk to each other; the main data flow from input to output; start-up sequence.
3. Algorithms and logic — the core processing step by step (e.g. how input is parsed, which models/rules decide, thresholds and parameters with their values), in a document named after the topic.
4. FORMATS.md — configuration, data structures, file/storage formats, import/export formats, with field meanings and value ranges.
5. MODDING.md — where behaviour can be changed legitimately (settings, constants, extension points, hooks) and what each change does.
6. A small, safe starting point in the workspace (e.g. a documented config/mod file or a read-only analysis script) that demonstrates one extension — never touching the target or the mirror.

EVIDENCE RULES (checked automatically by SleepPilot):
- Every claim about the program cites where it comes from as \`path/file.ext:LINE\` or \`path/file.ext:START-END\`, with the path relative to the target root (e.g. \`index.html:120-134\`). Cited lines must exist; invented line numbers fail the check.
- Prefer reading the exact lines before describing them. Quote only short excerpts. Mark anything inferred or uncertain as such.
- Mention what you could NOT determine (e.g. weights inside an embedded model) instead of guessing.`;
}

export function reverseRules() {
  return `1. Read the program only through ${MIRROR_DIR}/ (and ${MIRROR_DIR}/${MAP_FILE}). The original target folder is not accessible to you; do not try to reach it. Never edit, rename or delete anything under ${MIRROR_DIR}/.
2. Never read, print or decode the omitted blobs in full; the MAP already tells what they are. Keep tool output small: read files in ranges, search with specific patterns.
3. Do not defeat/remove copy protection, DRM, licensing/activation or anti-cheat; do not produce cracks, keygens or patches that bypass protections.
4. Document with evidence: \`file.ext:LINE\` or \`file.ext:START-END\` (relative to the target root). Keep excerpts short and only to support a documented point.
5. Prefer reading and static analysis; do not run the target program and do not claim runtime behaviour you have not evidenced.
6. One analysis step per iteration; write/update the relevant .md file each time.`;
}

/** Checks for a reverse/analysis run (they validate what the agent writes, not the target). */
export function reverseChecks() {
  return [
    { id: 'cite-check', type: 'cite-check', name: 'Evidence citations (file:line exists)', enabled: true, approved: true },
    { id: 'js-syntax', type: 'js-syntax', name: 'JavaScript syntax (node --check)', enabled: true, approved: true },
    { id: 'py-syntax', type: 'py-syntax', name: 'Python syntax (ast.parse)', enabled: true, approved: true },
  ];
}
