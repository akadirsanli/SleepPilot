#!/usr/bin/env node
// Fake local Ollama service for tests. Implements the native discovery endpoints and enough of
// the OpenAI-compatible surface to verify provider setup and a simple local turn.
import http from 'node:http';

const port = Number(process.env.FAKE_OLLAMA_PORT || 0);
const models = (process.env.FAKE_OLLAMA_MODELS || 'qwen2.5-coder:0.5b,llama3.1:8b').split(',');

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  if (req.method === 'GET' && url.pathname === '/api/version') return json(res, { version: '0.9.9-test' });
  if (req.method === 'GET' && url.pathname === '/api/tags') {
    return json(res, {
      models: models.map((name) => ({
        name,
        model: name,
        size: 400_000_000,
        details: { family: 'qwen2', parameter_size: '0.5B', quantization_level: 'Q4_K_M' },
      })),
    });
  }
  if (req.method === 'GET' && url.pathname === '/v1/models') {
    return json(res, { object: 'list', data: models.map((id) => ({ id, object: 'model' })) });
  }
  if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
    const body = await readBody(req);
    const reply = { role: 'assistant', content: 'Local Ollama test answer.' };
    if (body.stream === false) {
      return json(res, {
        id: 'chatcmpl-fake-ollama',
        object: 'chat.completion',
        model: body.model,
        choices: [{ index: 0, message: reply, finish_reason: 'stop' }],
        usage: { prompt_tokens: 20, completion_tokens: 6, total_tokens: 26 },
      });
    }
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
    const base = { id: 'chatcmpl-fake-ollama', object: 'chat.completion.chunk', model: body.model };
    res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { content: reply.content }, finish_reason: null }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ ...base, choices: [], usage: { prompt_tokens: 20, completion_tokens: 6 } })}\n\n`);
    res.end('data: [DONE]\n\n');
    return;
  }
  res.writeHead(404, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'not found' }));
});

function json(res, value) {
  res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(value));
}
async function readBody(req) {
  let s = '';
  for await (const c of req) s += c;
  return JSON.parse(s || '{}');
}
server.listen(port, '127.0.0.1', () => {
  const addr = server.address();
  console.log(`listening http://127.0.0.1:${addr.port}`);
});
process.on('SIGTERM', () => server.close(() => process.exit(0)));
