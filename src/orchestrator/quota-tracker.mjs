/**
 * Durable per-harness usage-window tracker.
 *
 * Claude Code has a 5-hour rolling usage window. The CLI does not expose a stable quota API, so
 * SleepPilot records exhaustion when the CLI stream/result reports it and uses the reset hint when
 * present. Other harnesses get a shorter cooldown after quota/error events. The tracker never
 * assumes a fixed timer is the only source of truth: `observe()` is fed by actual turn results.
 */
export class QuotaTracker {
  constructor({ routing = {}, state = null, now = Date.now() } = {}) {
    this.routing = routing || {};
    this.now = now;
    this.windows = state?.windows ? structuredClone(state.windows) : {};
    this.history = state?.history ? structuredClone(state.history).slice(-200) : [];
  }

  snapshot() {
    return { windows: structuredClone(this.windows), history: structuredClone(this.history.slice(-200)), at: Date.now() };
  }

  rehydrate(state) {
    if (!state) return;
    this.windows = structuredClone(state.windows || {});
    this.history = structuredClone(state.history || []).slice(-200);
  }

  /** Returns { ok, until, reason } without changing state. */
  canUse(harness, at = Date.now()) {
    const w = this.windows[harness];
    if (!w) return { ok: true, until: null, reason: null };
    if (w.blockedUntil && w.blockedUntil > at) {
      return { ok: false, until: w.blockedUntil, reason: w.reason || 'quota/cooldown active' };
    }
    return { ok: true, until: null, reason: null };
  }

  nextAvailable(at = Date.now()) {
    const blocked = Object.entries(this.windows)
      .map(([harness, w]) => ({ harness, until: w.blockedUntil || 0, reason: w.reason }))
      .filter((x) => x.until > at)
      .sort((a, b) => a.until - b.until);
    return blocked[0] || null;
  }

  /**
   * Observe one turn result / error.
   * `quota` is the adapter-provided exhaustion object; `classification` is classifyError().
   */
  observe(harness, { result = null, classification = null, quota = null, error = null, at = Date.now() } = {}) {
    const q = quota || result?.quota || null;
    const isQuota = !!q?.exhausted || classification?.category === 'quota';
    if (isQuota) {
      const hours = harness === 'claude' ? (this.routing.claudeWindowHours || 5) : null;
      const until = Number(q?.resetsAt) || (hours ? at + hours * 3_600_000 : at + (this.routing.quotaCooldownMin?.[harness] || 30) * 60_000);
      this._block(harness, {
        until,
        reason: q?.message || classification?.message || 'usage quota exhausted',
        source: q?.source || 'adapter',
        windowHours: hours,
        at,
      });
      return this.windows[harness];
    }
    if (error) {
      // Errors are handled by the controller's fallback/backoff path. Do not mark the harness
      // unavailable for a fixed window: a 429 may clear in seconds, and the same adapter is
      // allowed to retry after the normal bounded backoff. Only real quota exhaustion blocks.
      this.history.push({ harness, at, reason: classification?.message || error, source: 'error', windowHours: null, blocked: false });
      if (this.history.length > 200) this.history = this.history.slice(-200);
    }
    return null;
  }

  _block(harness, { until, reason, source, windowHours, at }) {
    const prev = this.windows[harness] || {};
    this.windows[harness] = {
      harness,
      blockedUntil: until,
      reason,
      source,
      windowHours,
      windowStart: windowHours ? at : prev.windowStart || null,
      windowEnd: windowHours ? at + windowHours * 3_600_000 : prev.windowEnd || null,
      exhaustedAt: isFinite(until) ? at : prev.exhaustedAt || null,
    };
    this.history.push({ harness, at, until, reason, source, windowHours });
    if (this.history.length > 200) this.history = this.history.slice(-200);
  }

  /** Clear an expired block so a recovered harness can be used again. */
  clearExpired(at = Date.now()) {
    for (const [harness, w] of Object.entries(this.windows)) {
      if (w.blockedUntil && w.blockedUntil <= at) delete this.windows[harness];
    }
  }

  /** Explicit user resume after a quota pause: let the controller try the harness again. */
  clear(harness = null) {
    if (harness) delete this.windows[harness];
    else this.windows = {};
  }
}

/**
 * Parse a reset hint from a Claude Code quota message. Examples seen in CLI output:
 *   "You've reached your 5-hour limit. Resets at 5:00 PM."
 *   "usage limit reached; try again at 2026-11-10T23:00:00Z"
 */
export function parseResetHint(text, now = new Date()) {
  const s = String(text || '');
  const iso = s.match(/\b(20\d\d-\d\d-\d\dT\d\d:\d\d(?::\d\d)?(?:\.\d+)?Z)\b/);
  if (iso) {
    const t = Date.parse(iso[1]);
    if (Number.isFinite(t) && t > now.getTime()) return t;
  }
  const clock = s.match(/\b(?:reset|resets|try again|available)(?:\s+at)?\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i);
  if (clock) {
    let h = Number(clock[1]) % 12;
    if (/pm/i.test(clock[3])) h += 12;
    const d = new Date(now);
    d.setSeconds(0, 0);
    d.setHours(h, Number(clock[2] || 0), 0, 0);
    if (d.getTime() <= now.getTime()) d.setDate(d.getDate() + 1);
    return d.getTime();
  }
  const inTime = s.match(/\b(?:reset|resets|available|try again)\s+in\s+(\d+)\s*(h|hour|hours|m|min|mins|minutes)?/i);
  if (inTime) {
    const n = Number(inTime[1]);
    return now.getTime() + n * (/^h/i.test(inTime[2] || '') ? 3_600_000 : 60_000);
  }
  return null;
}
