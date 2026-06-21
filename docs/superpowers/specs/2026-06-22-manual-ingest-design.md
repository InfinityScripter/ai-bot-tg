# Manual ingest: turn an owner-sent text or URL into a news post

**Date:** 2026-06-22
**Status:** approved (owner granted blanket authority to design + implement)

## Goal

Let the owner DM the bot a **plain text** or a **URL** and have it processed
into a blog post through the *existing* rewrite → preview → publish pipeline —
the same flow a daily-collected RSS item goes through after the owner taps
"🔄 Переработать".

Today the only way an item enters the pipeline is the RSS collector (daily cron
or `/fetch`). This feature adds a second entry point: an owner message.

## Non-goals

- No new candidate states, keyboards, or publish path — manual items reuse the
  `FeedItem` → `insertCollected` → `sendRawCard` → rewrite → publish flow 1:1.
- No full readability/boilerplate-removal engine. The LLM rewrite tolerates a
  noisy body; a lightweight `fetch` + regex extraction (the same spirit as the
  existing `fetchOgImage`) is enough. No new npm dependency.
- No multi-item batching. Manual ingest is one message → one candidate,
  intentional, so `MAX_PER_RUN` does not apply.
- No support for media uploads (photos/documents) — text and URLs only.

## Why reuse `FeedItem`

`FeedItem` (src/types.ts) is the contract for the entire downstream pipeline:
`store.insertCollected(item)` persists it, `sendRawCard` DMs the raw card, the
🔄 handler reconstructs it via `store.getFeedItem` and calls `rewriteToPost`,
then publish derives the blog body. If manual input produces a well-formed
`FeedItem`, **everything downstream is unchanged** — zero risk to the existing
flow, maximum reuse.

## Architecture

```
owner DMs the bot a message (not a /command)
        │  bot.on('message:text')  [owner-lock middleware already applied]
        ▼
classifyInput(text)
   ├── 'url'   → fetchArticle(url)      → FeedItem   (title/body/images scraped)
   ├── 'text'  → feedItemFromText(text) → FeedItem   (first line = title, rest = body)
   └── 'empty' → reply "пришлите текст или ссылку"
        ▼
store.insertCollected(item)
   ├── null (dedup: already seen)  → reply "уже было"
   └── id                          → sendRawCard(candidate)  ──► existing flow
                                       (🔄 Переработать / ❌ Пропустить → preview → publish)
```

### New module: `src/ingest.ts`

Pure-ish builders, no Telegram knowledge, fully unit-testable.

```ts
type ClassifiedInput =
  | { kind: 'url'; url: string }
  | { kind: 'text'; text: string }
  | { kind: 'empty' };

/** Decides whether the owner's message is a URL, free text, or empty. */
function classifyInput(raw: string): ClassifiedInput;

/** Scrapes an article page into a FeedItem (title/snippet/images). Throws on failure. */
async function fetchArticle(url: string): Promise<FeedItem>;

/** Builds a FeedItem from pasted free text (first line = title, rest = body). */
function feedItemFromText(raw: string): FeedItem;
```

**`classifyInput`:**
- Trim. Empty → `{kind:'empty'}`.
- If the first whitespace-delimited token is an `http(s)://` URL → `{kind:'url', url: <that token>}`. (A URL plus a trailing note → URL mode; the article is the source of truth.)
- Otherwise → `{kind:'text', text: <trimmed>}`.

**`fetchArticle(url)`:**
- Reuses `canonicalizeUrl` for the dedupKey (so a manually-submitted URL dedups
  against an RSS-collected one and vice-versa) and the og:image regexes already
  in `feeds.ts` (extracted to a shared spot or duplicated minimally).
- Single GET, 8s timeout, `User-Agent: blog-newsbot/1.0`, read first ~256KB.
- Title: `og:title` → `twitter:title` → `<title>` (strip a trailing " — site").
- Body: strip `<script>`/`<style>`/`<nav>`/`<header>`/`<footer>`, then
  `stripHtml`, collapse whitespace, `truncate(…, 4000)` (same cap as feeds).
- Images: og:image/twitter:image cover first, then body `<img src>` (absolute
  http(s) only), de-duplicated — the same shape `imageUrls` has from feeds.
- Throws a readable Error on network failure / non-HTML / no title found, so the
  handler can DM the error.

**`feedItemFromText(raw)`:**
- Title = the first non-empty line, clamped to ~120 chars (if the whole thing is
  one line longer than that, the title is a truncate and the body is the full
  text).
- Body/snippet = the full text (so the rewriter sees everything),
  `truncate(…, 4000)`.
- `dedupKey = 'manual:' + sha1(normalizedText)` — synthetic, stable, collision-
  safe; re-pasting the identical text dedups (acceptable). Uses node:crypto.
- `url = ''`, `feedTitle = 'Прислано вручную'`, `imageUrl = null`,
  `imageUrls = []`, `publishedAt = null`.

### Bot wiring: `src/bot.ts`

Add a `bot.on('message:text')` handler (registered after the commands; grammy
routes `/command` text to `bot.command`, so this only fires for non-command
text). It:

1. Ignores text that *is* a slash command defensively (`startsWith('/')` →
   return, in case of an unknown command).
2. `classifyInput(ctx.message.text)`.
3. `empty` → reply with usage hint.
4. `url`/`text` → reply a progress line, build the `FeedItem`
   (`fetchArticle`/`feedItemFromText`, wrapped in try/catch for the URL fetch),
   `store.insertCollected`, then:
   - `null` → reply "Уже было в очереди или опубликовано."
   - id → `store.get(id)` → `sendRawCard(candidate)`.
5. The card then drives the existing rewrite/publish flow with no changes.

`createBot` already closes over `store` and `sendRawCard`; the handler is added
inside `createBot` next to the command handlers. No new constructor args.

### `feedTitle` display

The raw card (`renderRaw`) shows `Источник: <feedTitle>`. URL items get the
real page title's host or site name where available, falling back to the URL
host; text items get "Прислано вручную". Good enough — no new render code.

## Error handling

- URL fetch throws → handler DMs `⚠️ Не удалось получить статью: <msg>`; no card,
  no row inserted.
- `insertCollected` returns null (dedup) → friendly "уже было" reply.
- Everything else (rewrite, publish) is the existing, already-hardened flow.
- The owner-lock middleware blocks all non-owner messages before this handler.

## Testing

New `tests/ingest.test.ts`:
- `classifyInput`: url / url+trailing-text / plain text / empty / whitespace.
- `feedItemFromText`: title = first line, body = full text, dedupKey stable for
  identical text and different for different text, dedupKey has `manual:` prefix.
- `fetchArticle`: mocked `fetch` →
  - happy path: og:title + og:image + body imgs + body text extracted;
  - `<title>`-only page (no og tags);
  - non-HTML / non-ok response → throws;
  - network error → throws.

Extend `tests/bot.test.ts` (or a focused new test) for the handler:
- text message → `insertCollected` + `sendRawCard` called with a built item;
- a URL message (mocked `fetchArticle`) → same;
- `insertCollected` → null → "уже было" reply, `sendRawCard` NOT called;
- empty message → usage hint, no insert.

`npm run ts` clean, `npm test` green.

## Docs

- README: add a "Send a link or text" section under the Telegram commands,
  noting the owner can DM a URL or text to inject a one-off post that flows
  through the same review/publish path.

## File-size / structure

`ingest.ts` stays well under the project's informal module size norm. The shared
og:image regexes / image-collection helper, if duplicated, are small; preferred
is to export the existing helpers from `feeds.ts` and import them in `ingest.ts`
to avoid drift.
