#!/usr/bin/env node
// Fake DeepSeek Harness CLI for engine tests. Speaks the small NDJSON event stream SleepPilot
// consumes: session, status, text, tool and final.
const args = process.argv.slice(2);
if (args.includes('--version')) {
  console.log('dsh 9.9.9-fake');
  process.exit(0);
}
if (args.includes('--help')) {
  console.log('Usage: dsh --profile headless [--json] [task...]');
  process.exit(0);
}
let input = '';
for await (const chunk of process.stdin) input += chunk;
const say = (o) => process.stdout.write(JSON.stringify(o) + '\n');
say({ type: 'session', sessionId: 'session-fake-1234', cwd: process.cwd() });
say({ type: 'status', phase: 'turn_start', turn: 1 });
say({ type: 'text', text: `Fake DSH answer to: ${input.trim().slice(0, 80)}` });
say({ type: 'tool', name: 'read', id: 'tool-1', input: { filePath: 'README.md' }, output: 'fake tool output' });
say({ type: 'final', sessionId: 'session-fake-1234', reason: { kind: 'success' }, text: `Fake DSH answer to: ${input.trim().slice(0, 80)}` });
