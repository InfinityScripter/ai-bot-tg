# Telegram `/model` — runtime provider & model switch

**Date:** 2026-06-21
**Repo:** ai-bot-tg (the Telegram news bot)
**Status:** approved design, ready for implementation plan

## Problem

The rewrite backend (provider + model) is fixed at boot from `.env`
(`REWRITE_PROVIDER`, `*_MODEL`, `*_API_KEY`). Switching to test a different
model means editing `.env.production` on the VDS and restarting the service.

Goal: let the owner switch provider **and** model at runtime from the Telegram
bot, with the choice surviving a restart/deploy, and a ping-test confirming the
new model actually works before it's saved.

This spec covers **Phase 1 (Telegram only)**. Phase 2 (a web admin page in the
separate blog-app repo) is out of scope and gets its own spec later.

## Approach

A runtime override stored in the bot's existing SQLite DB takes precedence over
the env defaults. The rewriter resolves the active provider/model on **every**
rewrite, so a switch applies immediately — no restart. Env remains the default
when no override is set (and after `/model reset`).

## Components

Four units, each with one purpose and a clear interface.

### 1. Settings store (in `src/store.ts`)

Add a `settings` key-value table to the **existing** `CandidateStore` (same DB
handle — no second connection to the same file, avoids WAL contention).

```sql
CREATE TABLE IF NOT EXISTS settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

Methods:
- `getModelOverride(): { provider: ProviderName; model: string } | null`
  — reads the single `model_override` row, JSON-parsed; null if unset/invalid.
- `setModelOverride(provider, model): void` — upsert.
- `clearModelOverride(): void` — delete the row.

Stored as one JSON row under key `model_override` so the pair is atomic.

### 2. Provider registry (`src/providers.ts`)

Extract the provider table currently inline in `rewriter.ts` into a shared
module so bot, rewriter, and models all read one source of truth.

```ts
type ProviderName = 'anthropic' | 'gemini' | 'glm' | 'deepseek' | 'mock';

interface ProviderSpec {
  label: string;              // human label for buttons/errors
  kind: 'anthropic' | 'openai-compat' | 'mock';
  baseUrl?: string;           // openai-compat only
  apiKey: () => string | undefined;  // reads CONFIG lazily
  defaultModel: string;       // from CONFIG.*_MODEL
  fallbackModels: string[];   // static list when /models API fails
}

export const PROVIDERS: Record<ProviderName, ProviderSpec>;

/** Override (settings) → env default. Returns the provider to use right now. */
export function resolveActiveProvider(
  store: CandidateStore
): { provider: ProviderName; model: string };
```

`resolveActiveProvider`: if a valid override exists in settings, use it;
otherwise `CONFIG.REWRITE_PROVIDER` + that provider's `defaultModel`.
`REWRITE_MOCK=1` still forces `mock` (checked first, as today).

### 3. Models + ping (`src/models.ts`)

- `listModels(provider): Promise<string[]>` — for `openai-compat` providers, GET
  `{baseUrl}/models` (OpenAI shape: `{ data: [{ id }] }`). On non-OK, empty,
  network error, or missing key → return `fallbackModels`. Anthropic/mock →
  return `fallbackModels` directly (no list endpoint used). Always non-empty so
  the bot always has buttons.
- `pingModel(provider, model): Promise<{ ok: true } | { ok: false; error: string }>`
  — a tiny chat request (`"ответь ok"`, small max_tokens). `ok:true` on a 2xx
  with any text; `ok:false` with a readable message otherwise. `mock` → always ok.

### 4. Bot command + callbacks (`src/bot.ts`)

Owner-locked (existing middleware). New command and callback prefixes.

- `/model` → message: current provider+model and its source (`override` or
  `env`), plus an inline keyboard of providers. Each provider button shows a
  `🔑` marker if its key is missing.
- callback `mp_<provider>` → `listModels(provider)` → inline keyboard of models
  (+ a "← Провайдеры" back button).
- callback `mm_<provider>__<model>` (double underscore — model ids contain a
  single `-`/`.` but never `__`, so the split is unambiguous) → `pingModel` →
  - ok: `setModelOverride(provider, model)`, edit message to
    `✅ Переключено: <label> / <model>`.
  - error: edit message to `⚠️ <error>` and keep the model list (do **not**
    save). The broken model never becomes active.
- callback `mreset` → `clearModelOverride()`, message
  `↩️ Сброшено на env (<provider>/<model>)`.

Callback data stays well under Telegram's 64-byte limit (provider names and
model ids are short).

## Data flow

```
/fetch or cron → runCollection → rewriteToPost(item)
  rewriteToPost:
    REWRITE_MOCK?            → mock
    else resolveActiveProvider(store)   [settings override → env]
       → PROVIDERS[provider]            [anthropic | openai-compat]
       → call with the resolved model
```

`rewriteToPost` needs access to the store to read the override. The collector
already holds the store, so it passes it in: `rewriteToPost(item, store)`.

## Error handling

| Case | Behavior |
|---|---|
| `listModels` API fails / empty / no key | fall back to `fallbackModels`, log warn, buttons still shown |
| `pingModel` fails | show error to owner, **do not** save override |
| provider has no key | button marked `🔑`; ping returns explicit "ключ не задан" |
| callback on a stale message | `answerCallbackQuery` with a short note, no-op |
| invalid override row in DB (e.g. provider renamed away) | `resolveActiveProvider` ignores it, falls back to env, logs warn |

Keys are never echoed into Telegram — only a present/absent marker.

## Testing

- `store.test.ts` — settings get/set/clear; override→null default; bad JSON → null.
- `providers.test.ts` — `resolveActiveProvider`: override wins; falls back to env;
  `REWRITE_MOCK` forces mock; invalid override → env.
- `models.test.ts` — `listModels` returns API ids on OK, fallback on non-OK /
  empty / no key (mocked fetch); `pingModel` ok / error.
- `rewriter.test.ts` — a settings override changes which provider/URL is called.
- `bot` — callback-data parsing for `mp_`/`mm_`/`mreset` (pure helper, unit-tested).

## Security

- `/model` and all callbacks are under the existing owner-lock middleware.
- API keys are never displayed; only `🔑` (missing) vs nothing (present).

## Out of scope (Phase 2, separate spec)

Web admin page in blog-app (backend `/api/bot/*` + dashboard UI). The bot and
blog are separate processes; a web UI would write the same override via a small
authenticated bot HTTP endpoint or a shared store. **Not started — blocked on an
in-progress frontend task in blog-app; do not touch blog-app now.**
