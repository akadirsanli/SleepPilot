#!/usr/bin/env node
// Fake Codex CLI for engine tests. Emits the same JSONL shape as `codex exec --json`.
import fs from 'node:fs';
const args = process.argv.slice(2);
if (args.includes('--version')) {
  console.log('codex-cli 0.9.9');
  process.exit(0);
}
if (args[0] === 'login' && args[1] === 'status') {
  console.error('Logged in using ChatGPT');
  process.exit(0);
}
if (process.env.FAKE_CODEX_ARGS) fs.appendFileSync(process.env.FAKE_CODEX_ARGS, JSON.stringify(args) + '\n');
let prompt = '';
for await (const c of process.stdin) prompt += c;
const thread = args[0] === 'exec' && args[1] === 'resume' ? args[2] : 'thread-fake-codex';
const say = (o) => process.stdout.write(JSON.stringify(o) + '\n');
say({ type: 'thread.started', thread_id: thread });
say({ type: 'turn.started' });
say({ type: 'item.completed', item: { id: 'item_0', type: 'agent_message', text: `Codex fake answer to: ${prompt.trim().slice(0, 80)}` } });
say({ type: 'item.started', item: { id: 'item_1', type: 'command_execution', command: 'echo hi', aggregated_output: '', exit_code: null, status: 'in_progress' } });
say({ type: 'item.completed', item: { id: 'item_1', type: 'command_execution', command: 'echo hi', aggregated_output: 'hi\n', exit_code: 0, status: 'completed' } });
say({ type: 'turn.completed', usage: { input_tokens: 200, cached_input_tokens: 50, output_tokens: 30, reasoning_output_tokens: 5 } });
