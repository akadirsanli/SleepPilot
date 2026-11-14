#!/usr/bin/env node
// Cross-version test runner: discovers *.test.mjs files and passes explicit paths to `node --test`.
// This avoids relying on shell glob expansion (different on cmd.exe, PowerShell, Node 20/22/24).
import { readdirSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const requested = process.argv.slice(2).filter((a) => !a.startsWith('-'));
const suites = requested.length ? requested : ['unit', 'integration'];
const files = [];
for (const suite of suites) {
  const dir = path.join(here, suite);
  let entries = [];
  try {
    entries = readdirSync(dir);
  } catch {
    continue;
  }
  for (const name of entries) {
    if (!name.endsWith('.test.mjs')) continue;
    if (statSync(path.join(dir, name)).isFile()) files.push(path.join(dir, name));
  }
}
if (!files.length) {
  console.error('No test files found.');
  process.exit(1);
}
const result = spawnSync(process.execPath, ['--test', '--test-concurrency=1', ...files], { stdio: 'inherit' });
process.exit(result.status ?? 1);
