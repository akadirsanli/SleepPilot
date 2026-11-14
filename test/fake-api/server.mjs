#!/usr/bin/env node
/**
 * Fake OpenAI-compatible provider used by the test suite. It is a TEST DOUBLE, not a model.
 * Behaviour is selected from the prompt shape (manager JSON, developer tool loop, reviewer,
 * closing report) and is deterministic. Run with `node server.mjs`; it prints
 * `listening <url>` on stdout and accepts SIGTERM.
 */
import http from 'node:http';

const port = Number(process.env.FAKE_API_PORT || 0);
const apiKey = process.env.FAKE_API_KEY || 'test-key';
const models = (process.env.FAKE_API_MODELS || 'fake-coder,fake-manager').split(',');

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  if (req.method === 'GET' && url.pathname === '/v1/models') {
    if (!auth(req)) return unauthorized(res);
    return json(res, { object: 'list', data: models.map((id) => ({ id, object: 'model', name: id })) });
  }
  if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
    if (!auth(req)) return unauthorized(res);
    const body = await readBody(req);
    const reply = decide(body);
    if (body.stream === false) return json(res, nonStream(reply, body.model));
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
    for (const chunk of streamChunks(reply, body.model)) res.write(`data: ${JSON.stringify(chunk)}\n\n`);
    res.end('data: [DONE]\n\n');
    return;
  }
  res.writeHead(404, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { message: 'not found' } }));
});

function auth(req) {
  return (req.headers.authorization || '') === `Bearer ${apiKey}`;
}
function unauthorized(res) {
  res.writeHead(401, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { message: 'invalid api key' } }));
}
function json(res, value) {
  res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(value));
}
async function readBody(req) {
  let s = '';
  for await (const c of req) s += c;
  return JSON.parse(s || '{}');
}

function promptText(body) {
  return (body.messages || [])
    .filter((m) => m.role === 'system' || m.role === 'user')
    .map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)))
    .join('\n');
}

function decide(body) {
  const text = promptText(body);
  const assistantCount = (body.messages || []).filter((m) => m.role === 'assistant').length;
  if (/SLEEPPILOT model check|Reply with exactly: OK/.test(text)) return { text: 'OK' };
  if (/Decide the next step|"decision": "continue"/.test(text)) {
    return { text: '```json\n{"decision":"complete","next_task_id":null,"reasoning":"fake server completes the run","user_question":null,"task_updates":[],"new_tasks":[]}\n```' };
  }
  if (/Break the objective into|Reply with ONLY a JSON object.*plan/i.test(text) && /"tasks"/.test(text)) {
    return {
      text: JSON.stringify(
        {
          summary: 'Fake plan',
          tasks: [
            { title: 'Create a greeting file', description: 'Write hello.txt with a greeting.', acceptance: ['hello.txt exists'], priority: 1, depends_on: [], files: ['hello.txt'] },
            { title: 'Verify the file', description: 'Read hello.txt and report.', acceptance: ['content is correct'], priority: 2, depends_on: [1], files: ['hello.txt'] },
          ],
          verification_notes: 'fake server',
          questions: [],
        },
        null,
        2,
      ),
    };
  }
  if (/You are the REVIEWER/.test(text)) return { text: '```json\n{"verdict":"pass","issues":[],"missing_verification":[],"summary":"fake review"}\n```' };
  if (/closing report|comprehensive report/i.test(text)) return { text: '# Closing report\n\nThe fake server completed the run.\n' };
  if (/You are the DEVELOPER|CURRENT TASK/.test(text)) {
    const step = assistantCount % 3;
    if (step === 0) {
      return {
        toolCalls: [{ id: `call_write_${Date.now()}`, name: 'write', args: { filePath: 'hello.txt', content: 'Hello from the fake API engine.\n' } }],
      };
    }
    if (step === 1) {
      return { toolCalls: [{ id: `call_read_${Date.now()}`, name: 'read', args: { filePath: 'hello.txt' } }] };
    }
    return { text: 'Created hello.txt and read it back.\n\nSLEEPPILOT_STATUS: done — hello.txt written and verified' };
  }
  return { text: 'ok' };
}

function streamChunks(reply, model) {
  const id = `chatcmpl-fake-${Date.now()}`;
  const created = Math.floor(Date.now() / 1000);
  const base = { id, object: 'chat.completion.chunk', created, model };
  const chunks = [];
  if (reply.toolCalls?.length) {
    chunks.push({ ...base, choices: [{ index: 0, delta: { role: 'assistant', content: null }, finish_reason: null }] });
    for (let i = 0; i < reply.toolCalls.length; i++) {
      const call = reply.toolCalls[i];
      const args = JSON.stringify(call.args || {});
      chunks.push({
        ...base,
        choices: [
          {
            index: 0,
            delta: { tool_calls: [{ index: i, id: call.id, type: 'function', function: { name: call.name, arguments: args.slice(0, Math.ceil(args.length / 2)) } }] },
            finish_reason: null,
          },
        ],
      });
      chunks.push({
        ...base,
        choices: [{ index: 0, delta: { tool_calls: [{ index: i, function: { arguments: args.slice(Math.ceil(args.length / 2)) } }] }, finish_reason: null }],
      });
    }
    chunks.push({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] });
  } else {
    const text = reply.text || '';
    chunks.push({ ...base, choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] });
    for (let i = 0; i < text.length; i += 80) chunks.push({ ...base, choices: [{ index: 0, delta: { content: text.slice(i, i + 80) }, finish_reason: null }] });
    chunks.push({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
  }
  chunks.push({ ...base, choices: [], usage: { prompt_tokens: 200, completion_tokens: 40, total_tokens: 240 } });
  return chunks;
}

function nonStream(reply, model) {
  const message = { role: 'assistant', content: reply.text || null };
  if (reply.toolCalls?.length) message.tool_calls = reply.toolCalls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args || {}) } }));
  return {
    id: `chatcmpl-fake-${Date.now()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message, finish_reason: reply.toolCalls?.length ? 'tool_calls' : 'stop' }],
    usage: { prompt_tokens: 200, completion_tokens: 40, total_tokens: 240 },
  };
}

server.listen(port, '127.0.0.1', () => {
  const addr = server.address();
  console.log(`listening http://127.0.0.1:${addr.port}/v1`);
});
process.on('SIGTERM', () => server.close(() => process.exit(0)));
