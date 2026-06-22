# Model health checks, OpenRouter provider, admin panel redesign

Date: 2026-06-22
Status: approved (design)

## Problem

The bot surfaced `⚠️ Не удалось переработать: Не удалось связаться с GLM: TypeError: fetch failed` on a daily run with `glm / glm-4.7-flash`.

Root cause: the active provider's chat endpoint (`api.z.ai`) was unreachable from the VPS at run time (`fetch failed` = network/DNS/geo, not a missing key — a missing key returns a different message). The endpoint is reachable from a dev machine, so this is VPS-side and intermittent.

Three gaps this exposes:

1. **No way to see which providers/models actually work** before a run dies on one.
2. **Per-provider geo/network flakiness** (z.ai, generativelanguage.googleapis.com) has no single fallback path.
3. The admin "AI-бот" panel only lets the owner *pick* a model; it can't *verify* models, and its provider dropdown lists `Mock (без LLM)` redundantly next to the dedicated mock toggle.

## Goals

1. A `test:models` CLI to diagnose every provider's reachability from the host it runs on (the VPS).
2. An **OpenRouter** provider — one key, one endpoint — as an easy-to-wire unified path that dodges per-provider geo blocks.
3. A **model-health check** in the bot-health surface: an endpoint that pings every admin-controllable model and reports OK/FAIL, exposed in the admin panel as a table.
4. **Redesign** the admin panel: drop `Mock (без LLM)` from the provider dropdown (the toggle already covers it), add the model-health table.
5. Fix the stale Gemini default (`gemini-2.0-flash` is no longer served).

Non-goals: auto-failover between providers (report-only, owner switches manually); removing GLM/DeepSeek; live model-ping in the Telegram `/health` (kept active-only and fast).

## Repos touched

- **`ai-bot-tg`** (bot): registry, control server, health, CLI, tests.
- **`blog-app-mui-backend`**: proxy route for the new health endpoint.
- **`blog-app-mui-frontend`**: admin panel UI.

## Design

### 1. OpenRouter provider (`ai-bot-tg`, additive)

- `src/enums.ts`: `ProviderName.OpenRouter = "openrouter"`.
- `src/llm/providers.ts`: new `PROVIDERS` entry —
  `kind: OpenAICompat`, `baseUrl: "https://openrouter.ai/api/v1"`,
  `apiKey: () => CONFIG.OPENROUTER_API_KEY`, `defaultModel: CONFIG.OPENROUTER_MODEL`,
  `fallbackModels: ["z-ai/glm-4.7-flash", "deepseek/deepseek-chat", "google/gemini-2.5-flash"]`
  (all verified live on OpenRouter's public `/models`).
- Add to `CONTROL_PROVIDERS` so the admin panel can select it.
- `src/schemas/env-schema.ts`: `OPENROUTER_API_KEY` (optional), `OPENROUTER_MODEL`
  (default `"z-ai/glm-4.7-flash"`), and add to the `REQUIRED_KEY` map.
- `MODEL_PRICES`: tier hints for the three OpenRouter ids.
- Reuses the existing OpenAI-compat rewriter, `pingModel`, `listModels`, `/model` menu,
  control server — they iterate `PROVIDERS`/`CONTROL_PROVIDERS`, so no other change.

### 2. Drop `Mock` from the provider dropdown

- Remove `ProviderName.Mock` from `CONTROL_PROVIDERS` (becomes `[Glm, DeepSeek, OpenRouter]`).
- The mock **toggle** is unaffected: `POST /control/mock` writes `store.setMockOverride`
  directly and never checks `isControlProvider`. Verified.
- Update tests that assert the old list (see Testing).

### 3. Fix Gemini default

- `env-schema.ts` + `providers.ts`: `gemini-2.0-flash` → `gemini-2.5-flash`;
  `fallbackModels: ["gemini-2.5-flash", "gemini-2.5-flash-lite"]`; update `MODEL_PRICES` keys.
- Gemini stays out of `CONTROL_PROVIDERS` (geo-limited from RU) — fix is correctness only.

### 4. `test:models` CLI (`ai-bot-tg`)

- `src/cli/test-models.ts`, wired as `npm run test:models` (`tsx src/cli/test-models.ts`).
- For each non-mock provider: read `apiKey()`.
  - No key → `⚠ SKIP (no <KEY>)`.
  - OpenAI-compat → raw `GET {baseUrl}/models` with key + 8s timeout. Print
    `✅ OK (N models)` + first ~10 ids, or `❌ HTTP <status>: <body snippet>` /
    `❌ fetch failed: <err>` / `❌ timeout`.
  - Anthropic → no OpenAI-shape list endpoint; do a key-presence note + a tiny
    `pingModel` chat probe; print its result.
- Calls fetch directly (not `listModels`, which swallows errors into the fallback list),
  so the CLI shows the **real reason** a provider is dead.
- Exit 0 always — diagnostic, never a CI gate.

### 5. Model-health check + endpoint (`ai-bot-tg`)

- New `src/health/probeModels.ts` (own module, keeps `collectHealth` lean):
  `probeAllModels(deps?): Promise<ModelProbe[]>` where
  `ModelProbe = { provider: string; model: string; ok: boolean; ms: number; error?: string }`.
  For each provider in `CONTROL_PROVIDERS` (skip mock — trivially ok), ping its
  *active/default* model via `pingModel`, timing each. Pings run with bounded
  concurrency; each ping already has its own 8s timeout.
- New control endpoint `GET /control/models/health` →
  `{ checks: ModelProbe[], healthy: boolean }` (`healthy` = every check ok).
- `collectHealth` and the Telegram `/health` are **unchanged** (active-only, fast).

### 6. Proxy route (`blog-app-mui-backend`)

- New `src/pages/api/admin/bot/models-health.ts` (GET), `requireAuth(requireAdmin(...))`,
  proxies to `GET /control/models/health` via `botControlService`. Add
  `getModelsHealth()` to `botControlService`. Response envelope
  `{ success: true, data: { checks, healthy } }`.

### 7. Admin panel redesign (`blog-app-mui-frontend`)

- `bot-types.ts`: add `BotModelProbe` + `BotModelsHealth` types; widen
  `ControlProviderName` to include `"openrouter"` (and drop reliance on `"mock"` in the
  dropdown — mock no longer arrives from `/providers`).
- `src/actions/admin.ts`: add `useGetBotModelsHealth(accessToken)` SWR hook against the new
  proxy path; add the endpoint to `src/utils/axios.ts` `endpoints.admin.bot`.
- New section component `src/sections/admin/bot-models-health.tsx`: a table/list of
  `provider / model → ✅ OK (ms) | ❌ error`, with a manual "Проверить" refresh button
  (the probe is slow — don't auto-poll). Lives as its own file (one component per file).
- Refactor `admin-bot-view.tsx` (currently 190 lines, near the 200 lint cap): extract the
  status pill and the provider/model selector into their own components under
  `src/sections/admin/` so the view stays well under 200 lines after adding the health
  section. Provider dropdown now shows only glm/deepseek/openrouter (mock gone).

## Testing / verification

- **Bot (`ai-bot-tg`)**: `npm run lint`, `npm run ts`, `npm test`. New/updated:
  - `tests/providers.test.ts`: CONTROL_PROVIDERS = `[glm, deepseek, openrouter]`;
    `isControlProvider` accepts openrouter, rejects mock; OpenRouter spec present.
  - `tests/control-server.test.ts`: `/control/providers` returns `[glm, deepseek, openrouter]`;
    drop/replace the mock-provider model + model-override cases; add a
    `/control/models/health` shape test.
  - new `tests/probe-models.test.ts`: `probeAllModels` shape + ok/fail mapping with a stub
    `pingFn`.
  - `tests/models.test.ts`: OpenRouter listModels fallback; Gemini default updated.
  - Smoke: run `npm run test:models` (will SKIP providers with no local key — that's the
    correct, observable behavior).
- **Blog backend**: `npm run ts`, `npm run lint:fix`, `npm test` for the new route
  (proxy + 503 path), following the existing bot-route test pattern if present.
- **Blog frontend**: `npm run lint`, `npm run build`; `wc -l` every touched/new file to
  confirm `max-lines` (≤200) holds.
- **Integration**: start the bot control server with a stub store + a mocked `pingFn`,
  `curl GET /control/models/health` with the Bearer token, assert the JSON shape.

## Risks

- OpenRouter ids are namespaced (`z-ai/...`) — the dropdown/model list must not assume the
  bare `glm-*` form. `listModels` merges fallback + live, so the namespaced ids appear.
- Removing mock from the dropdown must keep the toggle working — verified the toggle path is
  independent.
- Frontend `max-lines` is locked at error — every new/edited file must stay ≤200 lines;
  the refactor is part of the design, not optional.
