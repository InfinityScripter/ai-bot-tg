# Daily digest post — one post a day instead of N per-item posts

Date: 2026-08-18. Owner decision: instead of auto-publishing every collected
news item as its own blog post (up to MAX_PER_RUN=15/day), the bot publishes
ONE daily digest post in the editorial format the owner supplied (sections:
Hot / Новости / Полезные материалы / Обсуждения и кейсы, each line linking to
its source). Releases keep their existing changelog path unchanged. Manual
URL/text ingest keeps the existing per-item manual flow.

## Decisions

- **Runtime switch**: `DIGEST_POSTS=on|off` env var, default `off` — deploying
  this code without touching `.env.production` changes nothing (repo
  convention). Prod flips it to `on` explicitly.
- **Queueing**: with the switch on, a collected `news` candidate is moved
  `collected → digest_queued` (new `CandidateState.DigestQueued`,
  wire string `digest_queued`) instead of being rewritten/published per item.
  `auto_publish` is cleared in the same UPDATE so crash-recovery
  (`listRecoveredAutomatic`) never resurrects it into the per-item lane.
  No LLM call and no owner card at queue time.
- **Digest build**: once per day, after the collection run (same cron) or via
  the manual `/digestpost` command. Input: queued candidates ≤48h old, newest
  `DIGEST_MAX_ITEMS` (default 16). Fewer than `DIGEST_MIN_ITEMS` (default 3)
  → no digest today, items stay queued. Queued items older than 48h are
  expired to `skipped` (they'd be stale news).
- **One LLM call** produces strict JSON validated by zod
  (`src/schemas/digestPostSchema.ts`): title, intro, four sections of
  `{url, headline, note?}` entries. Entries whose `url` is not among the
  input items' source URLs are dropped (anti-hallucination allow-list, same
  spirit as `finalizeRewrite`). The Markdown body is rendered
  deterministically in code — the model never emits free-form links.
- **Auto vs manual**: gated by the SAME blog admin master switch
  `autoPublishNews`, read fail-closed at digest time. On → publish
  automatically; off/unreadable → preview card in the owner DM with
  ✅ Опубликовать / 🔄 Пересобрать / ❌ Отмена. Cancel keeps items queued
  (they roll into tomorrow's digest until the 48h expiry).
- **Daily guard**: a settings row `digest_post_last_date` (YYYY-MM-DD in
  CRON_TZ) makes the job idempotent — a second run the same day is a no-op,
  so cron + a manual /fetch can't double-post.
- **Publish**: the digest posts through the existing `publishToBlog`
  (`/api/post/new`) with `Idempotency-Key: digest-<date>`; on success every
  included candidate is marked `published` with the shared blog post id, and
  the digest is cross-posted to the channel (soft-fail, as per-item posts do).
  Failure with `maybePosted` → items go to `needs_verification` (same
  duplicate-safety semantics as per-item publish); a clear 4xx → items return
  to `digest_queued` and the owner is notified.

## Known edges

- Crash mid-digest-publish leaves items in `publishing` → boot recovery moves
  them to `needs_verification`; their per-item cards have no stored extraction,
  so the owner resolves them by checking the blog and skipping. Rare and safe
  (never double-posts).
- The digest quality gate is structural (schema + URL allow-list + min items),
  not the editorial `assertPublishable` (which scores single-article rewrites).
- New feeds added the same day (The Verge/TechCrunch/VentureBeat/Ars/MIT TR/
  MIT News/GitHub Blog/Import AI/Latent Space/Last Week in AI/Interconnects/
  r/LocalLLaMA) widen the digest's raw pool; the relevance filter and
  MAX_PER_RUN still bound what reaches the queue.
