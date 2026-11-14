#!/usr/bin/env node
// Fake Claude Code CLI for engine tests. Emits the same stream-json shape as `claude -p`.
import fs from 'node:fs';
const args = process.argv.slice(2);
if (args.includes('--version')) {
  console.log('2.1.0');
  process.exit(0);
}
if (args[0] === 'auth' && args[1] === 'status') {
  console.log(JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty' }));
  process.exit(0);
}
if (process.env.FAKE_CLAUDE_ARGS) fs.appendFileSync(process.env.FAKE_CLAUDE_ARGS, JSON.stringify(args) + '\n');
let prompt = '';
for await (const c of process.stdin) prompt += c;
const sessionId = args.includes('--session-id') ? args[args.indexOf('--session-id') + 1] : 'session-fake-claude';
const say = (o) => process.stdout.write(JSON.stringify(o) + '\n');
say({ type: 'system', subtype: 'init', session_id: sessionId, model: 'claude-fake', permissionMode: 'bypassPermissions' });
say({ type: 'assistant', session_id: sessionId, message: { role: 'assistant', content: [{ type: 'text', text: `Claude fake answer to: ${prompt.trim().slice(0, 80)}` }], usage: { input_tokens: 100, output_tokens: 20 } } });
say({ type: 'assistant', session_id: sessionId, message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'Write', input: { file_path: 'hello.txt', content: 'hi' } }] } });
say({ type: 'user', session_id: sessionId, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'File written' }] } });
say({ type: 'result', subtype: 'success', is_error: false, session_id: sessionId, result: 'Claude fake done.', duration_ms: 10, total_cost_usd: 0.0002, usage: { input_tokens: 120, output_tokens: 25, cache_read_input_tokens: 5 } });
