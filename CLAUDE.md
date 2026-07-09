# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A Telegram news bot for the blog `aifirst.us.com`. Once a day (croner) it collects
items from curated RSS feeds, dedups them in SQLite, and DMs the owner **raw**
cards. Rewriting into a unique post happens **on demand** — only when the owner
presses 🔄 — using the active LLM provider (GLM / DeepSeek / OpenRouter / Claude /
Gemini, switchable at runtime via `/model`). After ✅ the post is published to the
blog over its HTTP API, and optionally cross-posted to a Telegram channel. Release
announcements are detected by markers and go through a separate structured
extraction into the blog changelog. There is also a weekly email digest flow and
manual ingest (owner sends a URL or text).

The README.md (Russian) is the primary project doc — it has the full per-file map
of `src/`, the bot command table, filter semantics, and the control-server API.
Keep it updated when behavior changes. **User-facing strings (Telegram messages,
labels, error texts) are in Russian**; code, comments, and commit messages are in
English.

## Commands

```bash
npm run dev           # bot with auto-restart (tsx watch); needs a filled .env
npm start             # bot without restart
npm run fetch         # one-shot collection cycle from the shell, then exit
npm run test:models   # probe which LLM providers are reachable from this host
npm run backfill:channel -- --dry-run   # announce back-catalogue in the channel

npm test              # vitest run — full suite; network mocked, no API keys needed
npm run test:watch    # vitest watch mode
npx vitest run tests/store.test.ts       # single test file
npx vitest run -t "claimForPublishing"   # tests matching a name

npm run ts            # tsc --noEmit (type check; there is no build step in practice)
npm run lint          # eslint (airbnb-base + perfectionist; max-lines is an error)
npm run lint:fix
npm run fm:check      # prettier check
npm run fm:fix

npm run eval                    # prompt evals, mock mode (recorded replies, free, CI-safe)
npm run eval -- --only <id>     # single case
npm run eval -- --mode live     # calls the real provider from .env (spends credits)
npm run eval -- --mode live --judge    # + LLM-as-judge rubric scoring
npm run eval -- --mode live --record   # overwrite recorded fixtures
```

Tests need no `.env`: `tests/setup.ts` populates required env vars (and forces
`REWRITE_MOCK=0`) **before** any module import, because importing `src/config.ts`
with invalid env calls `process.exit(1)`. SQLite runs on `:memory:`. Any new test
entrypoint / CLI must go through `src/config.ts` the same way.

**Install gotcha**: `package-lock.json` resolves every package from
`npm.yandex-team.ru` (the owner's mirror). Where that mirror is unreachable,
`npm ci` fails with ECONNRESET / "Exit handler never called!", and
`--replace-registry-host` does not help (the URLs carry a `?rbtorrent=` query
that breaks rewriting). Workaround: temporarily move `package-lock.json` aside,
`npm install --registry=https://registry.npmjs.org`, then restore the original
lock file — do not commit a re-resolved lock.

## Architecture

### Pipeline (the one flow everything serves)

```
cron / manual URL-or-text ─► feeds ─► keyword filter (FILTER_*) ─► relevance filter
  ─► dedup (SQLite) ─► RAW card in owner DM ─► 🔄 rewrite (active LLM) ─► PREVIEW card
  ─► ✅ publish:  news → POST {BLOG_API_URL}/api/post/new
                  release → POST {BLOG_API_URL}/api/changelog/new
  ─► optional cross-post to TELEGRAM_CHANNEL_ID (soft-fail: never breaks publish)
```

The bot talks to the blog **only** over HTTP (Bearer `BOT_API_TOKEN`) and owns
exactly one piece of state: a single SQLite file (dedup ledger + candidate
lifecycle + runtime settings).

### Candidate lifecycle (src/enums.ts `CandidateState`)

`collected → rewriting → pending_review → publishing → published`, with
`rewrite_failed` / `publish_failed` / `skipped` branches and one special state:
`needs_verification` — a crash landed mid-publish and the POST may have reached
the blog, so the owner must check before re-publishing (duplicate protection).
Double button presses are cut off by **atomic UPDATE claims**
(`claimForRewriting` / `claimForPublishing` in `src/store/candidateMutations.ts`)
— never bypass these with plain state writes.

### LLM layer (src/llm/)

- `providers.ts` — the single registry (URLs, key accessors, default/fallback
  models). Adding a provider touches this file plus, at most, `chatCompletion.ts`.
- `chatCompletion.ts` — the ONE provider-agnostic call core: an Anthropic SDK path
  and an OpenAI-compatible `fetch` path (Gemini/GLM/DeepSeek/OpenRouter, no SDKs).
  Every call carries a hard timeout + retry cap (`LLM_TIMEOUT_MS`,
  `LLM_MAX_RETRIES`) — without them one stalled call freezes `/fetch`, since
  collection classifies serially. Keep any new LLM feature on this core.
- `resolveActiveProvider(store)` — DB override (set via `/model` or the control
  server) beats env; the DB mock toggle is strictly authoritative over
  `REWRITE_MOCK`. Resolved on every rewrite, so switches apply without restart.
- Prompts live in `prompts.ts`; structured LLM output is validated with zod
  schemas from `src/schemas/`. Rewrite has a mock mode (no LLM, publishes a copy).

### Relevance filter (src/llm/classifyRelevance.ts, filterRelevant.ts)

Staged to minimize LLM spend: blocklist markers → instant drop; on-topic markers
→ instant keep; only borderline items get one cheap LLM call (0–4 score vs
`RELEVANCE_THRESHOLD`). Modes via `RELEVANCE_MODE`: `off` / `shadow` (default —
log only) / `on`. **Any classifier error = keep (fail-open)** — preserve this
invariant. Decisions are mirrored to the backend audit log (`src/auditEmit.ts`).

### Config and store

- `src/config.ts` validates env through the zod `EnvSchema` at import and exports
  a frozen `CONFIG`. Add every new env var to `src/schemas/envSchema.ts` **and**
  `.env.example` (which documents all vars).
- `src/store/CandidateStore.ts` is the facade; DDL + migrations live in
  `candidateSchema.ts`. Dedup keys are preserved even when old candidates are
  pruned.

### Optional admin control server (src/server/controlServer.ts)

Localhost-only HTTP API (default `127.0.0.1:8455`) for the co-located blog admin
panel to switch models without Telegram. Starts only when `BOT_CONTROL_TOKEN` is
set; auth is constant-time Bearer comparison. `CONTROL_PROVIDERS` deliberately
narrows which providers the panel may pick (Telegram `/model` sees all of them).

## Conventions (enforced or load-bearing)

- **Module size budget**: ESLint `max-lines: 200` (blank/comment lines excluded)
  at `error` severity — a new oversized file fails CI. `tests/` and `evals/` are
  exempt. Split modules rather than suppressing.
- **Enums are wire strings**: every member value in `src/enums.ts` is the exact
  string stored in SQLite / read from env / sent as JSON. Never change existing
  values; never reintroduce scattered string-literal unions for domain values.
- **File layout**: one module per file, camelCase filenames; each module's shared
  types in its `types.ts`; pure data (markers, prices, feed lists) in dedicated
  files; zod schemas in `src/schemas/`.
- **ESM with `.js` extensions**: relative imports must end in `.js`
  (`import { CONFIG } from "../config.js"`), TS runs directly via `tsx` — no
  build artifact anywhere, including production.
- **Lint specifics**: imports are sorted by perfectionist (line length, grouped —
  autofixable, so run `npm run lint:fix`); `@ts-ignore`/`@ts-nocheck` are banned,
  `@ts-expect-error` needs a written justification; `import/no-cycle` is an error;
  unused imports/vars are errors (`_`-prefix to mark intentional).
- **Logging**: `console.log/warn/error` with a `[module]` prefix is the house
  style (output goes to the systemd journal); `no-console` is off by design.
- **Comment style**: modules and non-obvious blocks carry dense "why" comments
  explaining constraints and past failure modes. Match that density when editing.
- **Fail-soft boundaries**: feed fetch failures are isolated per feed; classifier
  errors keep the item; cross-posting failures never fail a publish; a missing
  control token just disables the panel. Preserve these when touching the
  pipeline.

## Evals (evals/)

A prompt-quality gate for the rewrite and relevance prompts, separate from unit
tests. Mock mode replays `evals/fixtures/recorded/*.json` through the **exact
production path** (`extractJson` → `finalizeRewrite`) and asserts the output
contract deterministically; the graders themselves are unit-tested in
`tests/eval-checks.test.ts`. Live/judge modes spend real credits and are never
run in CI. If you change `prompts.ts` or the rewrite/relevance output contract,
run `npm run eval` and update fixtures/checks accordingly.

## Deployment

Push to `main` auto-deploys via GitHub Actions (`.github/workflows/bot-cicd.yml`):
SSH to the VDS, `git reset --hard origin/main`, `npm ci --omit=dev`, restart the
`blog-newsbot` systemd unit. It is a **git-pull deploy on purpose** — the
production `.env.production` and the SQLite ledger live inside the deploy dir and
must never be wiped; and the VDS installs **runtime deps only** (the full dev
toolchain OOMs the small box). Lint/tests run on the GitHub runner, not the VDS.
Details and rollback: `deploy/RUNBOOK.md` and `deploy/DEPLOY.md`.

## Design docs

`docs/plans/` and `docs/superpowers/{plans,specs}/` hold dated design documents
for shipped features — the decision record. Add a dated spec there for any
substantial feature, matching the existing naming (`YYYY-MM-DD-<topic>.md`).
