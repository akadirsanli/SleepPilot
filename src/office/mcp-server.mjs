import readline from 'node:readline';
import { TOOLS, toolContext, runTool } from './tools.mjs';

/**
 * A minimal MCP server (JSON-RPC 2.0 over stdio, one message per line) that gives coding agents
 * — Claude Code, Codex, OpenCode — the office tools while they build an app. Settings → MCP →
 * "SleepPilot office tools" adds it. Read-only roles start it with --read-only: the tools that
 * write files are then not offered.
 */
const VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];

export function toolSchema(tool) {
  const properties = {};
  const required = [];
  for (const [key, desc] of Object.entries(tool.input)) {
    const d = String(desc);
    const type = /^object \| object\[\]/.test(d) ? undefined : /^string\[\]/.test(d) ? 'array' : /^number/.test(d) ? 'number' : /^object/.test(d) ? 'object' : 'string';
    properties[key] = { ...(type ? { type } : {}), ...(type === 'array' ? { items: { type: 'string' } } : {}), description: d };
    if (!/\?/.test(d.split('—')[0])) required.push(key);
  }
  return { name: tool.name, description: tool.description, inputSchema: { type: 'object', properties, required } };
}

export function createMcpHandler({ root = process.cwd(), readOnly = false, version = '1' } = {}) {
  const ctx = toolContext(root, { readOnly });
  const tools = TOOLS.filter((t) => !readOnly || !t.write);
  return async function handle(msg) {
    const { id, method, params } = msg || {};
    const reply = (result) => (id === undefined || id === null ? null : { jsonrpc: '2.0', id, result });
    const fail = (code, message) => (id === undefined || id === null ? null : { jsonrpc: '2.0', id, error: { code, message } });
    if (method === 'initialize') {
      const asked = params?.protocolVersion;
      return reply({ protocolVersion: VERSIONS.includes(asked) ? asked : VERSIONS[0], capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'sleeppilot-office', version }, instructions: 'Office file tools: inspect/read/verify Excel, CSV, Word, PowerPoint, PDF and images; create reports and charts; generate synthetic test data with planted anomalies.' });
    }
    if (method === 'ping') return reply({});
    if (method === 'tools/list') return reply({ tools: tools.map(toolSchema) });
    if (method === 'tools/call') {
      const name = params?.name;
      if (!tools.some((t) => t.name === name)) return reply({ content: [{ type: 'text', text: `Unknown or unavailable tool: ${name}` }], isError: true });
      try {
        const text = await runTool(name, params?.arguments || {}, ctx);
        return reply({ content: [{ type: 'text', text: String(text) }], isError: false });
      } catch (err) {
        return reply({ content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true });
      }
    }
    if (typeof method === 'string' && method.startsWith('notifications/')) return null;
    if (method === 'resources/list') return reply({ resources: [] });
    if (method === 'prompts/list') return reply({ prompts: [] });
    return fail(-32601, `Method not found: ${method}`);
  };
}

export async function serveMcp(opts = {}) {
  const handle = createMcpHandler(opts);
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  const write = (obj) => obj && process.stdout.write(`${JSON.stringify(obj)}\n`);
  // Library warnings must never reach stdout: it carries the protocol.
  console.log = console.info = console.warn = (...a) => process.stderr.write(`${a.join(' ')}\n`);
  for await (const line of rl) {
    if (!line.trim()) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
      continue;
    }
    // Requests run one after another; a batch (array) is answered as an array.
    if (Array.isArray(msg)) {
      const out = (await Promise.all(msg.map(handle))).filter(Boolean);
      if (out.length) write(out);
    } else write(await handle(msg));
  }
}
