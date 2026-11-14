// Built-in API harness tools and protocol conversion.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ToolRuntime } from '../../src/engines/api/tools.mjs';
import { developerRuleset } from '../../src/orchestrator/permissions.mjs';
import { toAnthropicMessages, toOpenAiMessages } from '../../src/engines/api/client.mjs';
import { parseTextToolCalls } from '../../src/engines/api/engine.mjs';

function makeRuntime({ profile = 'full', protectedPaths = [], projectDir } = {}) {
  const dir = projectDir || fs.mkdtempSync(path.join(os.tmpdir(), 'sp-tools-'));
  const session = { id: 'ses_test', directory: dir, permissions: developerRuleset(profile, { protectedPaths, projectDir: dir }) };
  const asks = [];
  const runtime = new ToolRuntime({
    session,
    projectDir: dir,
    requestPermission: async (req) => {
      asks.push(req);
      return 'deny';
    },
    answerQuestion: async () => 'test answer',
    onStatus: () => {},
  });
  return { runtime, dir, asks, session };
}

test('tools: write, read, edit, list, glob, grep, status', async () => {
  const { runtime, dir } = makeRuntime({ profile: 'full' });
  let r = await runtime.execute('write', { filePath: 'src/main.rs', content: 'fn main() {}\n' });
  assert.equal(r.ok, true, r.output);
  assert.equal(fs.readFileSync(path.join(dir, 'src', 'main.rs'), 'utf8'), 'fn main() {}\n');
  r = await runtime.execute('read', { filePath: 'src/main.rs' });
  assert.match(r.output, /1\| fn main/);
  r = await runtime.execute('edit', { filePath: 'src/main.rs', oldString: 'main', newString: 'run' });
  assert.equal(r.ok, true, r.output);
  assert.match(fs.readFileSync(path.join(dir, 'src', 'main.rs'), 'utf8'), /fn run/);
  r = await runtime.execute('list', { path: 'src' });
  assert.match(r.output, /main\.rs/);
  r = await runtime.execute('glob', { pattern: '**/*.rs' });
  assert.match(r.output, /src\/main\.rs/);
  r = await runtime.execute('grep', { pattern: 'fn run' });
  assert.match(r.output, /src\/main\.rs:1/);
  let status = null;
  runtime.onStatus = (s) => (status = s);
  r = await runtime.execute('status', { status: 'done', reason: 'ok' });
  assert.equal(r.ok, true);
  assert.deepEqual(status, { status: 'done', reason: 'ok' });
});

test('tools: balanced profile asks for an unknown shell command; full allows it', async () => {
  const { runtime, asks } = makeRuntime({ profile: 'balanced' });
  const denied = await runtime.execute('bash', { command: 'this-command-does-not-exist --flag' });
  assert.equal(denied.ok, false);
  assert.match(denied.output, /Permission|denied/i);
  assert.equal(asks.length, 1);
  assert.equal(asks[0].action, 'shell');
  const unrestricted = makeRuntime({ profile: 'full' });
  const allowed = await unrestricted.runtime.execute('bash', { command: 'echo hi' });
  assert.equal(allowed.ok, true, allowed.output);
  assert.match(allowed.output, /hi/);
});

test('tools: protected paths are denied for writes', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-tools-proj-'));
  const target = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-tools-target-'));
  const { runtime } = makeRuntime({ profile: 'full', protectedPaths: [target], projectDir: dir });
  const r = await runtime.execute('write', { filePath: path.join(target, 'x.txt'), content: 'no' });
  assert.equal(r.ok, false);
  assert.match(r.output, /denied/i);
});

test('protocol conversion: OpenAI and Anthropic tool messages', () => {
  const messages = [
    { role: 'user', content: 'hello' },
    { role: 'assistant', content: 'calling', toolCalls: [{ id: 't1', name: 'read', args: { filePath: 'a' } }] },
    { role: 'tool', toolCallId: 't1', name: 'read', content: 'contents' },
  ];
  const openai = toOpenAiMessages('system', messages);
  assert.equal(openai[0].role, 'system');
  assert.equal(openai[2].tool_calls[0].function.name, 'read');
  assert.equal(openai[3].role, 'tool');
  const anthropic = toAnthropicMessages(messages);
  assert.equal(anthropic[1].content[1].type, 'tool_use');
  assert.equal(anthropic[2].role, 'user');
  assert.equal(anthropic[2].content[0].type, 'tool_result');
});

test('text tool protocol parses a fenced tool call', () => {
  const { calls, text } = parseTextToolCalls('I will read it.\n```tool\n{"name":"read","arguments":{"filePath":"a.rs"}}\n```');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, 'read');
  assert.match(text, /I will read it/);
  assert.equal(parseTextToolCalls('just prose').calls.length, 0);
});
