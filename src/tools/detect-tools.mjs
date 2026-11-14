import { findBrowsers } from '../checks/browser.mjs';
import { detectOpenCode } from '../opencode/detect.mjs';
import { detectOllama } from '../engines/api/ollama.mjs';
import { TOOLS, TOOL_CATEGORIES, cmpVersion } from './catalog.mjs';
import { probeCandidates, findExistingPath, readVersionFile } from './probe.mjs';
import fsp from 'node:fs/promises';
import path from 'node:path';

const OVERRIDE_STATUSES = new Set(['installed', 'missing', 'ignored']);

/**
 * Detect the recommended tools on this machine (read-only; nothing is installed).
 *
 * Every result carries the attempts that were made, so the UI can explain a failure instead of
 * just saying "not found". `overrides` lets the user settle a case the detector cannot:
 * mark a tool installed (optionally with a path), mark it missing, or ignore it.
 */
export async function detectTools(adapter, { overrides = {}, ollamaBase = null } = {}) {
  const out = new Array(TOOLS.length);
  let next = 0;
  // Probe a few tools at once: the screen used to wait for every missing executable in sequence.
  const worker = async () => {
    while (next < TOOLS.length) {
      const index = next++;
      const t = TOOLS[index];
      const row = baseRow(t);
      const override = overrides?.[t.id] && OVERRIDE_STATUSES.has(overrides[t.id].status) ? overrides[t.id] : null;
      try {
        if (override) await applyOverride(row, t, override);
        else await autoDetect(row, t, adapter, ollamaBase);
        if (row.status === 'unknown' && t.optional) row.status = 'optional-missing';
        if (!row.detail) row.detail = row.status === 'missing' || row.status === 'optional-missing' ? 'Not found in PATH or the common install locations.' : null;
      } catch (err) {
        row.status = 'unknown';
        row.detail = `Detection failed: ${err.message}`;
        row.error = err.message;
      }
      applyVersionRule(row);
      out[index] = row;
    }
  };
  await Promise.all(Array.from({ length: Math.min(10, TOOLS.length) }, worker));
  return { categories: TOOL_CATEGORIES, tools: out, checkedAt: Date.now(), platform: process.platform, home: process.env.USERPROFILE || process.env.HOME || null };
}

function baseRow(t) {
  return {
    id: t.id,
    name: t.name,
    category: t.category,
    why: t.why,
    home: t.home,
    download: t.download,
    install: t.install || null,
    optional: !!t.optional,
    status: 'unknown',
    version: null,
    detail: null,
    path: null,
    source: 'auto',
    manual: false,
    overridden: false,
    attempts: [],
    ollama: null,
  };
}

async function autoDetect(row, t, adapter, ollamaBase) {
  if (t.detectFromAdapter) {
    let d = adapter?.detection;
    if (!d?.found) d = await detectOpenCode({}).catch(() => null);
    if (d?.found) {
      const sup = d.support?.status;
      row.status = sup === 'supported' ? 'ok' : sup === 'test' ? 'warn' : 'bad';
      row.version = adapter?.serverInfo?.version || d.version?.raw || null;
      row.path = d.path || null;
      row.detail = `${d.path || ''}${sup && sup !== 'supported' ? ` — ${d.support?.message || sup}` : ''}`.trim();
      row.attempts = [{ file: d.path, ok: true, label: d.source || 'OpenCode detection' }];
    } else {
      row.status = 'missing';
      row.detail = d?.support?.message || 'OpenCode not found in PATH or the known install locations.';
      row.attempts = (d?.tried || []).map((file) => ({ file, ok: false }));
    }
    return;
  }
  if (t.detectBrowser) {
    const browsers = findBrowsers();
    row.status = browsers.length ? 'ok' : 'missing';
    row.path = browsers[0] || null;
    row.detail = browsers.length ? browsers[0] : 'Edge or Chrome not found.';
    row.attempts = browsers.map((file) => ({ file, ok: true }));
    return;
  }
  if (t.detectOllama) {
    const o = await detectOllama({ baseUrl: ollamaBase });
    row.ollama = o;
    row.path = o.binary || null;
    row.version = o.version || null;
    row.attempts = o.attempts || [];
    if (o.running && o.models.length) {
      row.status = 'ok';
      row.detail = `${o.baseUrl} · ${o.models.length} model(s)${o.version ? ` · v${o.version}` : ''}`;
    } else if (o.running) {
      row.status = 'warn';
      row.detail = `${o.baseUrl} · running, but no models are pulled. Try: ollama pull qwen2.5-coder:7b`;
    } else if (o.installed) {
      row.status = 'warn';
      row.detail = `Installed${o.binary ? ` at ${o.binary}` : ''}, but the service is not running. Start Ollama or set the host in Settings → Local AI.`;
    } else {
      row.status = 'missing';
      row.detail = o.error || 'Ollama is not installed. Download it from ollama.com and start the service.';
    }
    return;
  }
  if (t.dirProbe) {
    const hit = await findExistingPath(t.dirProbe.candidates);
    row.attempts = hit.attempts;
    if (hit.found) {
      row.status = 'ok';
      row.path = hit.path;
      row.detail = hit.path;
      if (t.dirProbe.versionFile) {
        const v = await readVersionFile(path.join(hit.path, t.dirProbe.versionFile));
        if (v) row.version = v;
      }
      if (!row.version) row.detail += ' · version unknown (manual detection)';
    } else {
      row.status = t.optional ? 'optional-missing' : 'missing';
      row.detail = 'Not found in the common install locations; set the path manually if it is installed elsewhere.';
    }
    return;
  }
  if (t.probe) {
    const hit = await probeCandidates(t.probe.candidates, { args: t.probe.args, re: t.probe.re, timeoutMs: 4_000 });
    row.attempts = hit.attempts;
    if (hit.found) {
      row.status = 'ok';
      row.version = hit.version;
      row.path = hit.file;
      row.detail = `${hit.file}${hit.args?.length ? ` ${hit.args.join(' ')}` : ''}`;
    } else {
      row.status = t.optional ? 'optional-missing' : 'missing';
      row.detail = 'Not found in PATH or the common install locations.';
    }
    return;
  }
  row.status = t.optional ? 'optional-missing' : 'unknown';
  row.detail = 'Manual tool: no automatic probe is defined.';
}

async function applyOverride(row, t, override) {
  row.overridden = true;
  row.source = 'manual';
  row.manual = true;
  const status = override.status;
  if (status === 'ignored') {
    row.status = 'ignored';
    row.detail = override.note || 'Ignored by the user; detection is skipped.';
    return;
  }
  if (status === 'missing') {
    row.status = 'missing';
    row.detail = override.note || 'Marked as missing by the user.';
    return;
  }
  // installed: optionally test the user-provided path/command.
  row.status = 'manual';
  row.version = override.version || null;
  row.path = override.path || null;
  row.detail = override.path ? `${override.path}${override.version ? ` · ${override.version}` : ''} (manual)` : `Marked installed by the user${override.version ? ` · ${override.version}` : ''}${override.note ? ` — ${override.note}` : ''}`;
  if (t.probe && override.path) {
    const hit = await probeCandidates([override.path], { args: t.probe.args, re: t.probe.re, timeoutMs: 12_000 });
    row.attempts = hit.attempts;
    if (hit.found) {
      row.status = 'ok';
      row.version = hit.version || row.version;
      row.path = hit.file;
      row.detail = `${hit.file} (manual path, verified)`;
    } else {
      row.status = 'bad';
      row.detail = `Manual path did not answer the version probe: ${override.path}`;
    }
  } else if (!t.probe && override.path) {
    // GUI tools have no version command; at least prove the path exists.
    const st = await fsp.stat(override.path).catch(() => null);
    row.attempts = [{ file: override.path, ok: !!st, kind: st?.isDirectory() ? 'directory' : st ? 'file' : 'missing' }];
    if (st) {
      row.status = 'manual';
      row.path = override.path;
      row.detail = `${override.path} (manual, path exists)`;
    } else {
      row.status = 'bad';
      row.detail = `Manual path does not exist: ${override.path}`;
    }
  }
}

function applyVersionRule(row) {
  if (row.status === 'ok' && row.version && isBelowMinimum(row)) row.status = 'warn';
}

function isBelowMinimum(row) {
  const tool = TOOLS.find((t) => t.id === row.id);
  if (!tool?.minVersion || !row.version) return false;
  return cmpVersion(row.version, tool.minVersion) < 0;
}
