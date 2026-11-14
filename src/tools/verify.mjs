import { extractJson } from '../orchestrator/json-extract.mjs';
import { TOOLS } from './catalog.mjs';

/** Read-only ruleset that may look things up on the web but cannot touch files or run shell. */
function lookupRuleset() {
  const rule = (action, resource, effect) => ({ action, resource, effect });
  return [rule('*', '*', 'deny'), rule('read', '*', 'allow'), rule('webfetch', '*', 'allow'), rule('websearch', '*', 'allow')];
}

/**
 * Ask a chosen OpenCode model to confirm a tool's latest stable version and that the official
 * download URL we show is still correct. Read-only and web-only; SleepPilot shows the answer and
 * labels it as the model's finding (verify before downloading). Nothing is downloaded or run.
 */
export async function verifyTool(adapter, { toolId, model, directory } = {}) {
  const tool = TOOLS.find((t) => t.id === toolId);
  if (!tool) throw new Error('Tool not found.');
  if (!adapter?.connected) throw new Error(`${adapter?.label || 'The engine'} is not connected.`);
  const s = await adapter.createSession({
    directory,
    title: `SleepPilot · Tool check · ${tool.name}`,
    model: model || undefined,
    permissions: lookupRuleset(),
  });
  const prompt = `You are checking a software tool's download information for a desktop development app. Do NOT download or install anything; only look up public information (use web search/fetch if available, otherwise answer from your knowledge and say so).

TOOL: ${tool.name}
OFFICIAL PAGE WE LINK TO: ${tool.download}
HOMEPAGE: ${tool.home}

Find:
1) the latest stable version of this tool (for Windows if platform-specific),
2) whether the OFFICIAL PAGE above is the correct, official download source (not a mirror/third-party),
3) the canonical official download URL if different.

Reply with ONLY a JSON object in a \`\`\`json fenced block:
\`\`\`json
{"latestVersion": "x.y.z or null", "officialUrlOk": true, "officialDownloadUrl": "https://…", "fromWeb": true, "note": "one short sentence, in English", "sources": ["url", "…"]}
\`\`\``;
  const turn = await adapter.runTurn({ sessionID: s.id, text: prompt, metadata: { role: 'tool-verify', tool: toolId } });
  const j = extractJson(turn.finalText || turn.allText) || {};
  return {
    toolId,
    status: turn.status,
    latestVersion: j.latestVersion ?? null,
    officialUrlOk: j.officialUrlOk ?? null,
    officialDownloadUrl: j.officialDownloadUrl || tool.download,
    fromWeb: !!j.fromWeb,
    note: String(j.note || '').slice(0, 300),
    sources: Array.isArray(j.sources) ? j.sources.slice(0, 5).map(String) : [],
    model: (turn.usage?.models || [])[0] || (model ? `${model.providerID}/${model.id}` : null),
    at: Date.now(),
  };
}
