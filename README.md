# ai-bot-tg — News bot for the blog

A standalone Telegram bot that collects news from trusted RSS feeds once a day,
rewrites each item into a unique blog post with Claude, DMs the owner with
**Publish / Skip** buttons, and on approval publishes the post to the blog
(`talalaev.su`) authored by the owner.

```
croner (daily) ─► feeds (RSS) ─► dedup (SQLite) ─► Claude rewrite
       └─────────────────────────────────────────────────┘
                                  │
                                  ▼
        Telegram DM: title + summary + [✅ Опубликовать] [❌ Пропустить]
                                  │  (owner taps Publish)
                                  ▼
        POST {BLOG_API_URL}/api/post/new  (Bearer BOT_API_TOKEN)
```

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

## How a run works

1. Fetch every configured RSS feed (per-feed timeout + isolation — one bad feed
   never aborts the run).
2. Dedup by canonical URL (`guid` preferred, tracking params stripped); already
   seen → skipped via a SQLite unique index.
3. Rewrite each fresh item into `{title, description, content, tags, meta…}` via
   Claude with structured output. A failure marks that one `rewrite_failed` and
   continues.
4. DM the owner an approval card with **Publish / Skip**.
5. On **Publish**: POST to the blog (idempotent — guarded by candidate state so a
   double-tap can't double-post), store the blog post id, edit the DM to confirm.

## Verify end-to-end (manual)

1. Start the blog backend locally on `:7272` with `BOT_API_TOKEN` + `OWNER_EMAIL`
   set, and make sure your owner account is `role = 'admin'`.
2. `cp .env.example .env`, fill it in (`BLOG_API_URL=http://localhost:7272`,
   matching `BOT_API_TOKEN`).
3. `npm run dev`, then send `/fetch` to the bot in Telegram.
4. Tap **Опубликовать** on a card → the post appears on the blog, authored by you.

## Tests

```bash
npm test       # vitest unit tests (feeds, dedup, store, publisher, rewriter)
npm run ts     # tsc --noEmit typecheck
```

Tests mock the network (RSS, Claude, blog) — no live keys needed.

## Deploy

Designed to run as a long-lived process (e.g. a systemd unit) on the same VDS as
the blog. `npm run build` emits `dist/`; run `node dist/src/index.js`, or run the
TS directly with `tsx src/index.ts`. Point `BLOG_API_URL` at the public API
(`https://api.talalaev.su:8444`) or, if co-located, `http://localhost:7272`.
