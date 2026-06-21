# ai-bot-tg — News bot for the blog

A standalone Telegram bot that collects news from trusted RSS feeds once a day,
DMs the owner a **raw** card per item, and — on the owner's 🔄 tap — rewrites
that item into a unique blog post with the model active at that moment (see
`/model`), shows a preview, and on approval publishes the post to the blog
(`talalaev.su`) authored by the owner. The rewrite runs **on demand at
publish-time**, not at collection — tokens are spent only on items the owner
chooses to process.

```
croner (daily) ─► feeds (RSS) ─┐
owner DMs a URL / text ─────────┼─► dedup (SQLite) ─► store RAW item
                                │
                                ▼
   Telegram DM (RAW): source title + snippet + [🔄 Переработать] [❌ Пропустить]
                                  │  (owner taps 🔄 — rewrite with the active /model)
                                  ▼
   Telegram DM (PREVIEW): rewritten title + summary + model
                          [🔄 Заново] [✅ Опубликовать] [❌ Пропустить]
                                  │  (owner taps Publish)
                                  ▼
        POST {BLOG_API_URL}/api/post/new  (Bearer BOT_API_TOKEN)
```

Two entry points feed the same pipeline: the daily RSS collector and an owner
message (a link or text) — see [Send a link or text](#send-a-link-or-text-manual-ingest).

The bot talks to the blog only over the HTTP publish API. It owns its own state
(a single SQLite file); the blog owns posts. See the design doc in the backend
repo: `docs/superpowers/specs/2026-06-20-news-bot-design.md`.

## Stack

- [grammY](https://grammy.dev) — Telegram bot (long polling)
- [rss-parser](https://www.npmjs.com/package/rss-parser) — feed ingest
- [@anthropic-ai/sdk](https://www.npmjs.com/package/@anthropic-ai/sdk) — Claude rewrite (structured output)
- [croner](https://www.npmjs.com/package/croner) — daily schedule, reused by `/fetch`
- [better-sqlite3](https://www.npmjs.com/package/better-sqlite3) — dedup ledger + candidate lifecycle
- [zod](https://zod.dev) — env + rewrite validation
- TypeScript, run with [tsx](https://www.npmjs.com/package/tsx)

## Setup

```bash
npm install
cp .env.example .env   # fill in the values
```

Required env (see `.env.example` for the full list):

| Var | What |
|---|---|
| `TELEGRAM_BOT_TOKEN` | from @BotFather |
| `OWNER_TELEGRAM_ID` | your numeric chat id (only you can drive the bot) |
| `ANTHROPIC_API_KEY` | Claude API key |
| `BLOG_API_URL` | blog API base (`http://localhost:7272` dev, `https://api.talalaev.su:8444` prod) |
| `BOT_API_TOKEN` | shared secret — **must equal** the blog backend's `BOT_API_TOKEN` |

The blog backend must also have `BOT_API_TOKEN` (same value) and `OWNER_EMAIL`
set, so it can authenticate the bot as the owner's admin user.

## Run

```bash
npm run dev      # start the bot (long polling) with reload
npm start        # start the bot (no reload)
npm run fetch    # one-shot collection run from the shell (no polling loop), then exit
```

Telegram commands (owner-only):

- `/start` — health check + help
- `/ping` — `pong`
- `/fetch` — run a collection cycle now (same as the daily cron)
- `/model` — switch the rewrite provider/model at runtime; pings the chosen
  model before saving and persists the choice across restarts (in the SQLite
  ledger). The menu also has a **🧪 Mock** toggle (publish a copy of the source
  without an LLM) — its db value is authoritative over the `REWRITE_MOCK` env.
  Picking a model clears Mock; "↩️ Сбросить на env" clears both overrides.

### Send a link or text (manual ingest)

Besides the daily RSS feed, the owner can inject a one-off post by **DMing the
bot a message** — no command needed:

- **A URL** (`https://…`) — the bot scrapes the page (title, body, og:image +
  body images) and turns it into a candidate.
- **Plain text** — the first line becomes the title, the rest the body. Paste an
  article or write your own.

Either way the bot replies with the usual **raw card** (🔄 Переработать /
❌ Пропустить), so the message flows through the *same* rewrite → preview →
publish path as a collected feed item. A URL already seen (or identical text
re-sent) is deduped with a short "уже была" reply.

## Admin control server (optional)

When `BOT_CONTROL_TOKEN` is set, the bot also starts a **localhost-only**
(`127.0.0.1:CONTROL_PORT`) HTTP control server so a co-located backend / web
admin can read and change the active model + Mock without Telegram. Every
request needs `Authorization: Bearer <BOT_CONTROL_TOKEN>` (constant-time check).
Unset the token → the server isn't started and the bot runs normally; a bind
failure (port taken) only disables the panel, never the news pipeline.

Endpoints: `GET /control/status`, `GET /control/providers`,
`GET /control/models?provider=`, `POST /control/model {provider,model}`,
`POST /control/mock {enabled}`.

## How a run works

1. Fetch every configured RSS feed (per-feed timeout + isolation — one bad feed
   never aborts the run).
2. Dedup by canonical URL (`guid` preferred, tracking params stripped); already
   seen → skipped via a SQLite unique index.
3. Store each fresh item RAW (title + snippet + image URLs) and DM the owner a
   **raw card** with **🔄 Переработать / ❌ Пропустить**. No rewrite happens at
   this stage — cards arrive un-rewritten.
4. On **🔄 Переработать**: rewrite the item into
   `{title, description, content, tags, meta…}` with the provider/model active
   right now (`/model`), structured output. The DM becomes a **preview card**
   with **🔄 Заново / ✅ Опубликовать / ❌ Пропустить**. A failure marks that one
   `rewrite_failed` and offers a retry. 🔄 Заново regenerates (e.g. after a
   `/model` switch).
5. On **✅ Опубликовать**: POST to the blog (idempotent — guarded by candidate
   state so a double-tap can't double-post), store the blog post id, edit the DM
   to confirm.

## Verify end-to-end (manual)

1. Start the blog backend locally on `:7272` with `BOT_API_TOKEN` + `OWNER_EMAIL`
   set, and make sure your owner account is `role = 'admin'`.
2. `cp .env.example .env`, fill it in (`BLOG_API_URL=http://localhost:7272`,
   matching `BOT_API_TOKEN`).
3. `npm run dev`, then send `/fetch` to the bot in Telegram.
4. Tap **🔄 Переработать** on a raw card → wait for the preview → tap
   **✅ Опубликовать** → the post appears on the blog, authored by you.

## Tests

```bash
npm test       # vitest unit tests (feeds, dedup, store, publisher, rewriter)
npm run ts     # tsc --noEmit typecheck
```

Tests mock the network (RSS, Claude, blog) — no live keys needed.

## Deploy

**Live in prod** on the same VDS as the blog (systemd `blog-newsbot`). A push to
`main` auto-deploys via GitHub Actions.

- **[deploy/RUNBOOK.md](deploy/RUNBOOK.md)** — reproducible recipe: deploy style,
  the four CI secrets (and where the SSH key comes from — the step that bit us
  once), first manual deploy, the backend-must-know-the-bot gotcha, verify, and
  rollback. **Read this before setting up CI for a new service or re-running.**
- **[deploy/DEPLOY.md](deploy/DEPLOY.md)** — exact env keys, the systemd unit, and
  the CI / rollback reference.

Runs the TS entrypoint directly with `tsx` (`node --import tsx src/index.ts`) — no
build step. `BLOG_API_URL` points at `http://localhost:7272` (co-located) or the
public API `https://api.talalaev.su:8444`.
