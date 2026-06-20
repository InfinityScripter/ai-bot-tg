# Rewrite-on-publish — preview flow

**Date:** 2026-06-21
**Repo:** ai-bot-tg
**Status:** approved design, ready for implementation plan
**Builds on:** the `/model` runtime switch (providers.ts / resolveActiveProvider)

## Problem

Today the LLM rewrite runs at **collection** time: `/fetch` (or the daily cron)
fetches feeds, rewrites every fresh item immediately, and DMs a ready-to-publish
card. The owner only chooses publish/skip. Consequences:

- The rewrite happens before the owner picks a model via `/model`, and re-running
  with a different model means a whole new `/fetch`.
- Every collected item is rewritten even if the owner skips it — wasted tokens.

The owner wants to rewrite **on demand, with the model active at that moment**,
see the result, optionally regenerate with another model, then publish.

## Desired flow

```
/fetch or cron → fetch feeds → store RAW item → DM a "raw" card:
    [🔄 Переработать] [❌ Пропустить]

🔄 Переработать → rewrite with the active provider/model → DM/edit a "preview":
    <rewritten title + description + which model>
    [🔄 Заново] [✅ Опубликовать] [❌ Пропустить]

🔄 Заново → (owner may /model-switch first) → rewrite again → new preview
✅ Опубликовать → publish the saved preview → "✅ Опубликовано"
❌ Пропустить → mark skipped
```

No rewrite happens at collection time. Tokens are spent only when the owner taps
🔄, with the model they chose.

## Key change: persist the raw item

The rewrite now runs **later** (on a button tap, possibly after a restart), so
the raw `FeedItem` must be persisted — today `snippet` and `imageUrls` are NOT
stored (the collector held the `FeedItem` in memory and rewrote inline). Add two
columns and a migration:

```sql
ALTER TABLE candidates ADD COLUMN snippet     TEXT;     -- raw article text
ALTER TABLE candidates ADD COLUMN image_urls  TEXT;     -- JSON string[] (cover first)
```

`insertCollected` writes `snippet` and `image_urls` (JSON). A new
`store.getFeedItem(candidate)` reconstructs a `FeedItem` from the row so the
rewriter can run from stored data alone.

## State model

Existing states stay; their flow changes. `pending_review` keeps its meaning:
"a rewrite is saved and awaiting publish". A new terminal-ish display state is
not needed — we reuse what exists:

```
collected        raw, awaiting the owner's first action  (NEW: card shows raw)
  → 🔄 → rewriting → pending_review   (rewrite saved = preview shown)
  → 🔄 заново → rewriting → pending_review (overwrites the saved rewrite)
  → ✅ → publishing → published | publish_failed
  → ❌ → skipped
  rewrite error → rewrite_failed (card keeps a retry button)
```

## Components

### 1. store.ts
- Schema: add `snippet`, `image_urls` columns + migration (additive, ignore-if-exists, matching the existing `image_url` migration pattern).
- `insertCollected(item)`: also persist `snippet`, `image_urls` (JSON.stringify).
- `getFeedItem(candidate): FeedItem` — rebuild a FeedItem from the row (snippet, imageUrls parsed; imageUrl, url, title, feedTitle from existing columns). Returns a best-effort item even if image_urls is null/corrupt (→ []).
- `mapRow` exposes the new fields on `Candidate` (snippet, imageUrls).

### 2. collector.ts
- **Stop rewriting at collection.** `runCollection` now: fetch → insertCollected → DM a *raw* card. No `rewriteToPost`, no `rewrite_failed` here, no model-override auto-clear here (that moves to the rewrite handler).
- `RunSummary` drops `rewritten`; keeps `fetched/fresh/sent/failed` (failed = DM send failures).
- `sendRawCard(candidate)` callback replaces `sendApproval(candidate, rewrite)`.

### 3. bot.ts — new callbacks + cards
- **Raw card** (`renderRaw`): source title + snippet + `[🔄 Переработать][❌ Пропустить]`. Callback prefixes `rewrite_<id>`, `skip_<id>` (skip already exists).
- **`rewrite_<id>`**: load the candidate, `getFeedItem`, set `rewriting`, call `rewriteToPost(item, store)` with the active model, on success `attachRewrite` + edit to the **preview card**; on failure mark `rewrite_failed`, edit to an error + keep a `🔄 Переработать` button. Move the `isModelNotFound` → `clearModelOverride` logic here.
- **Preview card** (`renderPreview`): rewritten title + description + the model used + `[🔄 Заново][✅ Опубликовать][❌ Пропустить]`. 🔄 Заново reuses the `rewrite_<id>` handler (overwrites the saved rewrite).
- **`approve_<id>`** (exists): publishes the saved rewrite — unchanged, but now only reachable from the preview card.
- Long rewrites can exceed Telegram's ~15s callback window: answer the callback immediately ("Перерабатываю…"), then edit when done. answerCallbackQuery stays wrapped in `ackSilently` (already fixed).

### 4. rewriter.ts / providers.ts
- No change. `rewriteToPost(item, store)` already resolves the active model.

## Data flow

```
cron/fetch → runCollection → insertCollected(raw) → sendRawCard
owner 🔄    → rewrite_<id> handler → getFeedItem → rewriteToPost(item, store)
                                   → attachRewrite → preview card
owner ✅    → approve_<id> handler → publishToBlog(saved rewrite) → published
```

## Error handling

| Case | Behavior |
|---|---|
| rewrite fails (4xx/429/network) | state `rewrite_failed`, card shows the error + a 🔄 retry button; batch/other cards unaffected |
| rewrite fails with model-not-found + active override | clear the override (moved from collector), tell the owner to re-pick via /model |
| 🔄 tapped on an already-published/skipped card | answerCallbackQuery note, no-op |
| publish tapped with no saved rewrite (shouldn't happen) | existing guard: publish_failed + message |
| rewrite slow (>15s) | ack immediately, edit on completion; ackSilently swallows a stale-query 400 |
| getFeedItem on a row missing snippet (old pre-migration row) | snippet '' , imageUrls [] — rewrite still runs on title alone |

## Testing

- store: `insertCollected` persists snippet+image_urls; `getFeedItem` round-trips; corrupt/missing image_urls → []; old row (no snippet) → ''.
- collector: `runCollection` does NOT call rewriteToPost; inserts collected; calls sendRawCard once per fresh item; failed = DM failures only.
- bot: `rewrite_<id>` calls rewriteToPost and saves; preview reachable; `rewrite_<id>` again overwrites; rewrite error → rewrite_failed + retry button; model-not-found clears override; approve publishes saved rewrite; all callbacks owner-locked and crash-safe (bot.catch).

## Out of scope
- Web admin (phase 2, blog-app) — untouched.
- Editing the rewrite text by hand in Telegram — not in this iteration.

## Migration / back-compat
- Additive columns; existing rows (pre-migration, already `pending_review` with a saved rewrite) still publish fine — they have `rewrite_json`. Their raw `snippet` is null, but they don't need a re-rewrite.
- The daily cron behavior changes: cards arrive un-rewritten. Document in README/DEPLOY.
