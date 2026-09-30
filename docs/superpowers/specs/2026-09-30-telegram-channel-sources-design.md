# Telegram channel sources: retell other AI channels in @ai_first_news

Part 1 of 2. Part 2 (a funnel that brings live subscribers, with per-source
measurement) gets its own spec once this one ships.

## Goal

The owner's channel @ai_first_news (the bot's `TELEGRAM_CHANNEL_ID`) today gets
the daily digest and release posts, 1–2 posts a day. It should also carry short
retellings of the best posts from a curated list of public AI channels, written
in our voice (rewrite + humanizer) with credit to the author. These posts go to
the channel only, never to the blog.

## Decisions (owner, 2026-09-30)

| Question | Decision |
|---|---|
| Where retellings go | Separate posts, Telegram channel only |
| Who decides | Automatic behind a master switch; off or unreadable → owner card |
| Where the switch lives | Blog admin, `autoPublishChannels`, next to `autoPublishNews` |
| Channel list | In code next to `defaultFeeds.ts`, env var overrides it wholesale |
| Volume | Hourly sweep 10:00–21:00 MSK, at most 1 per sweep, at most 6 per day |
| Reading method | Public web preview `t.me/s/<channel>`; no user account, no RSSHub |

Rejected: a user-account client (gramjs) — a session key for the owner's
account on the VDS and a ban risk, for private channels nobody asked for;
RSSHub — the public instance is rate-limited and self-hosting it does not fit
the small VDS.

## Source channels

Priority (always considered first): `ai_for_devs`, `sukharev_ii`,
`aostrikov_ai_agents`, `aimastersme`.

Regular: `llm_under_hood`, `abstractDL`, `NeuralProfit`, `devfm`, `pomazkovjs`,
`ituzov_fun`, `defendend_ai_dev`, `shilovtech`.

All 12 checked on 2026-09-30: public, the page returns 17–22 posts, no ad
markers; five channels carry forwarded posts. Three pages failed the first
request and answered in 0.7 s on retry — transient failures are normal and must
only skip the channel for that sweep. Views differ 10–40× between channels
(shilovtech ~0.2–0.7K, abstractDL ~4–19K).

`TG_SOURCE_CHANNELS` (CSV, `@name` or `name`, a leading `!` marks priority)
replaces the whole list when set.

## Flow

1. **Fetch.** `CHANNEL_WATCH_CRON` (unset = off; prod `15 10-21 * * *`,
   `CRON_TZ`) fetches each channel page through `fetchHtml` (timeout, size
   cap). One failing channel is logged and skipped.
2. **Parse** (`src/feeds/parseTelegramChannel.ts`, regex like the other
   scrapers — no new dependency). Per `tgme_widget_message`: post id
   (`data-post`), text (`tgme_widget_message_text`, tags stripped, links kept
   as URLs), time (`<time datetime>`), first photo, views (`1.2K` → 1200),
   forwarded flag. A page that loads but yields 0 posts counts as a parse
   failure (markup changed) and shows up in `/health`.
3. **Filter.** Drop forwarded posts, posts with `#реклама` / `erid`, text under
   200 characters, posts younger than 2 hours or older than 8 hours, and keys
   already seen
   (`tg:<channel>/<id>` in `candidates` / `seen_keys`). Then the existing
   relevance filter (`filterRelevant`). Then drop a post whose outbound article
   link is a `source_url` the bot already published — one story from three
   channels must not become three posts.
4. **Pick one.** Priority channels first: if any priority post survived, pick
   among them only. Within the group, score = post views ÷ median views of that
   channel's page; highest wins. A post with twice its channel's usual reach
   beats an average post from a big channel. Views keep growing for days while
   the median comes from older posts, so a fresh post scores low against it;
   the 2-hour minimum age lets first-hour views settle. The remaining bias
   toward the older of two candidates is accepted: both are recent, and
   priority does most of the choosing.
5. **Limits.** The cron expression is the time window (no clock check in
   code). The sweep is skipped when 6 channel posts were published in the last
   24 hours (rolling, so SQLite's UTC timestamps need no time-zone math).
6. **Insert** as `CandidateKind.Channel = "channel"` (new wire value) with
   `auto_publish=1`, then the same routing as releases: read flags
   (`fetchAutoPublishFlags` gains `channels`, fail-closed), on → automatic
   publish, off → RAW card to the owner.
7. **Retell** (`src/llm/retellChannelPost.ts`, active provider through
   `completeChatJson`): Russian post up to 900 characters so it fits a photo
   caption; no title/SEO fields. Then `humanizeText`, then code appends
   `Источник: @channel` linking to `https://t.me/<channel>/<id>`. Zod schema in
   `src/schemas/`. Stored in `rewrite_json`; state goes to `pending_review`
   like any rewrite.
8. **Gate** (auto path only): retell non-empty, ≤ 1024 characters with the
   source line, the source line present. Failure → preview card with ✅.
9. **Publish** (`src/blog/publishToChannel.ts`): `sendPhoto` with the retell as
   caption when the post had a usable photo, else `sendMessage`; same fallback
   as `crossPostToChannel`, but through a direct Bot API `fetch` like the blog
   publish, so `loadExtraction` needs no bot handle. The channel message id is
   stored as `tg:<message_id>` in `blog_post_id` by the shared `setPublished`
   (no migration; the prefix keeps it from reading as a blog id). A network error
   after the request left → `needs_verification`, exactly like a blog POST.
   Owner card: «✅ В канале: …».

Manual path is unchanged: 🔄 runs the retell, ✅ publishes to the channel
without the gate, ❌ skips.

## Other repos

- **blog-app-mui-backend:** `autoPublishChannels` flag and
  `AUTO_PUBLISH_CHANNELS_ENABLED` default, same pattern as
  `autoPublishTimeline` (`config-global.ts`, `schemas/admin-settings.ts`,
  `services/settings.ts`, tests).
- **blog-app-mui-frontend:** one more toggle in
  `sections/admin/admin-settings-view.tsx` and the key in `actions/settings.ts`.

Deploy order does not matter: until the backend returns the flag the bot reads
it as off (fail-closed) and every retelling arrives as a card.

## Code layout

`src/index.ts` is already 265 lines; the channel sweep (schedule guard, limits,
failure ping once like the release watch) goes into
`src/server/runChannelWatch.ts`, and `index.ts` only schedules it. New modules
stay under the 200-line lint budget.

## Error handling

| Where | Behaviour |
|---|---|
| One channel page fails | skip that channel this sweep |
| All pages fail, or parse finds 0 posts everywhere | sweep fails; owner pinged once until a sweep succeeds |
| Relevance LLM error | keep the post (existing fail-open) |
| Flags unreadable | off → owner card |
| Retell or humanizer fails | retell failure → `rewrite_failed` + RAW card; humanizer keeps original |
| Telegram send fails before the request | `pending_review`, card to owner |
| Telegram send result unknown | `needs_verification` |

## Tests and evals

- Parser on saved pages: normal post, forwarded post, ad post, photo post,
  post without text, views `1.2K` / `12.7K` / `401`.
- Selection: priority wins over a higher-scoring regular post; relative-views
  score; 6-per-day limit; time window; outbound-link repeat.
- Publish path: photo with caption, fallback to text, unknown result →
  `needs_verification`, flag off → card.
- Eval suite `CHANNEL` for the retell prompt: 5–6 real posts from the priority
  channels, checks for length ≤ 900, source line, no new numbers, no links
  except the source.

## Out of scope

Part 2 (funnel), private channels, per-channel posting quotas, reposting media
albums or video.
