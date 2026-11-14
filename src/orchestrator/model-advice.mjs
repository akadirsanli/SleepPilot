/**
 * Suggested model per role, chosen from the models the installed OpenCode actually offers.
 * Default policy is "cheap": a long unattended run makes hundreds of turns, so every role uses
 * a fast, low-cost model. opencode-go/deepseek-v4.1-flash is the main model (verified end to end
 * with SleepPilot); the other names are cheap alternatives, checked by the start-of-run model
 * test (preflight), which falls back to the Developer model when a Manager/Reviewer model fails.
 */
const MAIN = 'opencode-go/deepseek-v4.1-flash';
const PREFERENCES = {
  // Most turns and most tokens.
  developer: [MAIN, 'opencode-go/glm-5.3-flash', 'opencode-go/qwen3.8-flash', 'opencode-go/minimax-m3.1-flash'],
  // Plans and decides; the same cheap main model keeps plans consistent with the developer.
  manager: [MAIN, 'opencode-go/glm-5.3-flash', 'opencode-go/qwen3.8-flash'],
  // A different cheap model family gives a more independent review; falls back to the main model.
  reviewer: ['opencode-go/glm-5.3-flash', 'opencode-go/qwen3.8-flash', 'opencode-go/minimax-m3.1-flash', MAIN],
};

export const ROLE_ADVICE = {
  manager: 'Writes the plan and decides after every iteration. Default: the main cheap model (deepseek-v4.1-flash).',
  developer: 'Writes the code; most turns and tokens are spent here. Main model: deepseek-v4.1-flash (cheap, verified with SleepPilot).',
  reviewer: 'Reads the change and flags out-of-scope work and gaps. Default: a cheap flash model from another family; otherwise the main model.',
};

export function recommendModels(models = []) {
  const have = new Set(models.map((m) => `${m.providerID}/${m.id}`));
  const pick = (role) => {
    const k = PREFERENCES[role].find((x) => have.has(x));
    if (!k) return null;
    const i = k.indexOf('/');
    return { providerID: k.slice(0, i), id: k.slice(i + 1) };
  };
  return { developer: pick('developer'), manager: pick('manager'), reviewer: pick('reviewer') };
}

/** Fill only the roles that have no model yet (null = OpenCode default, which may be a model the account cannot use). */
export function withRecommendedModels(current = {}, models = []) {
  const rec = recommendModels(models);
  return { manager: current.manager || rec.manager, developer: current.developer || rec.developer, reviewer: current.reviewer || rec.reviewer };
}
