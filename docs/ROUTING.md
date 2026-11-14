# Multi-harness routing, model profiles and quota fallback

Version 2.4.0 adds an optional delegation layer on top of the existing `AgentEngine` contract.
A run still has one project engine, but each role/task turn can be routed to a different registered
engine with its own model profile and reasoning effort.

The layer is deliberately not a second engine registry: `EngineManager` remains the owner of the
adapters. `RunController` receives that manager and reuses the same `createSession`, `runTurn`,
`turnMessages`, `interrupt` and permission methods.

## Project settings

These live in `project.settings` (defaults in `src/store/store.mjs`):

```js
{
  harnessRouting: {
    enabled: true,
    roles: {
      manager:   ['claude'],
      developer: ['dsh'],
      reviewer:  ['api'],
      closing:   ['api'],
      preflight: ['claude']
    },
    // Optional per-task-type additions/overrides for the developer route.
    taskTypes: {
      coding:   ['dsh'],
      analysis: ['claude']
    },
    fallbackChain: ['claude', 'dsh', 'api', 'opencode'],
    fallbackOnErrors: true,
    maxSwitches: 8,
    claudeWindowHours: 5,
    workingWindowHours: 10,
    quotaCooldownMin: { claude: 300, api: 30, codex: 30, dsh: 30, opencode: 30, cli: 30 }
  },
  modelProfiles: {
    claude: {
      default: { model: 'sonnet', effort: 'high' },
      max:     { model: 'opus',   effort: 'max' }
    },
    api: {
      'deepseek-high': { model: { providerID: 'deepseek', id: 'deepseek-chat' }, effort: 'high' }
    },
    dsh: { default: { model: null, effort: null } }
  },
  rolePins: {
    manager:   { harness: 'claude', modelProfile: 'default' },
    developer: { harness: 'dsh',    modelProfile: 'default' },
    reviewer:  { harness: 'api',    modelProfile: 'deepseek-high' }
  }
}
```

`harnessRouting.enabled: false` (the default) preserves the old single-engine behavior. A role pin
still applies when routing is disabled, but there are no automatic fallbacks until the chain is
configured. Empty/invalid profiles are rejected at save/start, not silently ignored.

## Resolution order

`src/orchestrator/routing.mjs` -> `resolveRoutes()` returns an ordered list. The first entry is
preferred; the rest are fallbacks.

1. `rolePins[role].harness`
2. `harnessRouting.roles[role]`
3. `harnessRouting.taskTypes[task.type]` for the developer role
4. `harnessRouting.fallbackChain`
5. the project engine

Duplicates are removed. `modelProfile` comes from the role pin when it names the same harness;
otherwise the harness's `default` profile is used. `modelForHarness()` translates the stored
provider/model/string into what the adapter expects.

Read-only roles (manager, reviewer, closing, preflight) are filtered to adapters that can enforce
read-only sessions at the adapter level: `opencode`, `claude`, `codex` and `api`. DSH and the generic
Command harness reject `readOnly: true` with a configuration error rather than relying on a prompt.

## Effort vocabulary

`EFFORT_LEVELS` in `src/orchestrator/routing.mjs` is checked before a session is created.

| Harness | Supported effort values | Transport |
| --- | --- | --- |
| `api` | `off`, `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`, `ultra` | `reasoning_effort` (OpenAI-compatible); `thinking.budget_tokens` (Anthropic) |
| `claude` | `low`, `medium`, `high`, `xhigh`, `max` | `--effort <value>` |
| `codex` | `minimal`, `low`, `medium`, `high` | `-c model_reasoning_effort="<value>"` |
| `dsh` | none | no CLI flag; an effort request is an error |
| `opencode` | none | no effort flag in this integration; an effort request is an error |
| `cli` | none | no effort flag; an effort request is an error |

`off` and `none` are accepted for API profiles but no reasoning parameter is sent. Every other
unsupported value throws `RoutingConfigError` naming the engine, profile, requested value and the
actual supported list. No code path downgrades effort.

## Engine contract additions

The only contract that had to be extended is `AgentEngine` (`src/engines/base.mjs`):

```js
createSession({ directory, title, model, permissions, effort, readOnly })
  -> { id, model, effort, readOnly, directory }

runTurn(...) -> { status, finalText, allText, tools, errors, usage, transcript,
                  quota: { exhausted, resetsAt, window, message, source } | null }
```

- Claude/Codex/API/OpenCode honor `readOnly` in their own permission/sandbox layer.
- DSH/CLI throw when `readOnly` or an unsupported `effort` is requested.
- `quota` is optional; when present, `QuotaTracker` records the harness window.

## Quota tracking and fallback

`src/orchestrator/quota-tracker.mjs` maintains per-harness `blockedUntil` windows. It exposes
`canUse(harness)`, `nextAvailable()`, `observe(harness, result)` and `clear()`.

Claude Code has a 5-hour usage window. The adapter detects it from real stream-json/result messages
or stderr (`usage limit`, `5-hour`, `resets at`, ISO reset times) and returns `quota`. The tracker
uses the reset hint when present, otherwise `claudeWindowHours` (default 5). Generic API/OpenCode
quota errors are recorded without a fixed 5-hour block; a provider pause remains the user's signal.

When a routed turn fails with a provider error (quota, auth, config, rate limit, transient) or the
selected harness is already blocked:

1. The failed turn is persisted with its `harness`, `modelProfile` and `fallbackStep`.
2. `RunController.nextRoute()` chooses the next route that is not attempted, not blocked, and can
   enforce the role.
3. A new session is created on that harness and the **same task prompt** is sent. The failed harness
   is never resubmitted to. (A new harness must receive the prompt because no successful result
   exists.)
4. `run.routingSwitches` gets a durable entry (`from`, `to`, profiles, reason, iteration).
5. The loop continues the same task/iteration; it only pauses when every route is blocked, with a
   quota pause explaining when the next harness is available.

The configured `workingWindowHours` is the intended continuous routing window (10 h by default);
the run's own time limit still decides when the run ends. A 5-hour Claude reset therefore does not
end a 10-hour run: the controller switches to the next harness and keeps the remaining window.

If the user resumes a quota pause explicitly, the recorded quota window is cleared so the harness
can be tried again; normal sleep-mode auto-resume keeps the window.

## Run/CLI surface

Run records now include:

```js
{
  activeHarness: 'dsh',
  sessionRoutes: { manager: { harness, modelProfile, effort, sessionID }, ... },
  routingSwitches: [{ at, role, from, to, reason, iteration }],
  routingConfig: { routing, modelProfiles, rolePins },
  quota: { windows, history }
}
```

Every turn record includes `harness`, `modelProfile` and `fallbackStep`.

Headless commands:

```bat
sleeppilot route --project C:\work\app --task coding --dry-run --json
sleeppilot ask --project C:\work\app --engine claude --model-profile high --prompt "Fix the test"
sleeppilot run --project C:\work\app --create --model-profile high --objective @goal.txt
```

`route` never connects or executes. Exit codes for runs remain `0 completed`, `2 paused`,
`3 stopped`, `4 failed`; a routing/config error exits `1` with a JSON error when `--json` is used.

## Tests

- `test/unit/routing.test.mjs` — resolution order, exact effort vocabularies, reset hints, quota
  `canUse`, adapter flags and DSH's loud refusal.
- `test/integration/routing-fallback.test.mjs` — real `RunController` with fake Claude/DSH/API
  adapters; Claude quota on the first developer turn, switch to DSH, same task completes, manager
  continues on API, and every turn carries the routing fields.
- `test/integration/cli-route.test.mjs` — `sleeppilot route --dry-run --json` and an unsupported
  effort failure.
