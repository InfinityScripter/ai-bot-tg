# Channel digest: two rich articles a day instead of hourly retellings

## Goal

@ai_first_news stops posting one retelling per hour. Twice a day it publishes
one Telegram rich article (Bot API 10.1 `sendRichMessage`) with the best 5–7
posts of the source channels, in the layout the owner picked from live
trials in his DM on 2026-10-01 (variant «F4»).

## Decisions (owner, 2026-10-01)

| Question | Decision |
|---|---|
| Digest vs retellings | Digest only; hourly retellings are retired |
| Frequency | Two issues a day: 11:00 and 19:00 Europe/Moscow |
| Item layout | Heading + 2–4 sentences + photos (carousel when several) |
| Styling | «F4»: `h3` issue title, `h5` «В выпуске» + contents, each item a `blockquote` with an `h5` heading (emoji + title), paragraph, `cite` line with the rubric hashtag only; photos under the card |
| Source channel | Not shown: the `cite` line is `#rubric` only (owner, 2026-10-01, for testing) |
| Buttons | None: no «Коротко», no «Оригинал», no «Поделиться» |
| From the branding work (`2026-10-01-channel-post-branding-design.md`) | Branded cover image at the top of the article; rubric hashtag on each item. No «Зачем тебе это» line |
| Pipeline shape | Queue all day, assemble at issue time (not scrape-at-issue, not one-call article) |
| Sources | `aostrikov_ai_agents` removed (posts contests and personal stories). New channels: owner picks from the checked list below |

## Article layout

Exact markup, validated live (trial messages 2212–2222 in the owner DM,
script `.superpowers/sdd/trial-styles.ts`, variant F4):

```html
<img src="tg://photo?id=cover"/>
<h3>AI за утро · 1 октября</h3>
<h5>В выпуске</h5>
<ol><li><a href="#n1">🔥 Anthropic сделали GLM отличную рекламу</a></li>…</ol>
<a name="n1"></a>
<blockquote>
  <h5>🔥 Anthropic сделали GLM отличную рекламу</h5>
  <p>…2–4 sentences, inline tags and source links only…</p>
  <cite>#модель</cite>
</blockquote>
<tg-slideshow><img src="tg://photo?id=p0"/><img src="tg://photo?id=p1"/></tg-slideshow>
…next item…
```

- Title: «AI за утро · D месяца» at 11:00, «AI за вечер · D месяца» at 19:00.
- Photos: more than one → `<tg-slideshow>` (at most 4 per item); one → a bare
  `<img>`; none → nothing. Rich messages allow 50 media in total, so the
  budget is 1 cover + 7 × 4 photos = 29.
- The `cite` line: `#<rubric>` only. The source channel is not shown (owner,
  2026-10-01) and there is no link to the original post (owner's choice).
- Cover: `renderCover` from the branding work with rubric `дайджест`, the
  issue title and date, and as fact line the item count («6 новостей»).
  No cover when rendering fails; the article goes out without it.
- Media are uploaded as files (`InputRichMessageMedia` with
  `attach://`), downloaded on the server through `downloadImage`: Telegram
  does not fetch `cdn*.telesco.pe` URLs itself.
- Font: the Bot API has no font control. `h1`/`h2` render in a serif face
  the owner rejected; `h3`/`h5` were accepted on screen.

## Flow

```
CHANNEL_WATCH_CRON (15 8-22 * * *) ─► t.me/s pages ─► fresh originals ─► relevance
   ─► every kept post → candidate kind=channel, state digest_queued (no publish)
   ─► posts already queued: refresh views
CHANNEL_DIGEST_CRON (0 11,19 * * *) ─► claim queue ─► pick 5–7 ─► one LLM call per item
   ─► checks ─► ≥ 3 items? ─► build article ─► autoPublishChannels?
        on  → sendRichMessage to the channel
        off → the same article to the owner DM + «✅ Опубликовать / ❌ Пропустить»
```

### Collection (hourly)

- Same sweep as today (`runChannelWatch`), minus picking and publishing: all
  eligible, relevant posts are inserted as `kind=channel`,
  `state=digest_queued`, with `source_html`, photos and views.
- A post already in the queue gets its views updated on every sweep, so the
  issue ranks on views gathered over hours, not in the first one.
- Forwarded posts stay excluded (existing rule).
- `CHANNEL_DAILY_LIMIT` and the one-post-per-sweep logic go away.

### Issue (twice a day)

- Candidates: `digest_queued` channel posts younger than 24 h; older ones →
  `skipped`.
- Order: priority channels first, then views ÷ the channel's median (the
  existing `pickChannelPost` ranking), at most 2 items per channel.
- Cross-channel duplicates: the new sources often cover the same news the
  same day. A post that shares an outbound non-`t.me` link with an item
  already picked is skipped for this issue (it stays queued). Stories told
  without a shared link can still repeat; accepted for v1.
- Up to 7 items go to the writer; items that fail or are skipped drop out. With
  fewer than 3 items left the issue is not published, the claimed posts go
  back to the queue, the owner gets one short note.
- Posts not used stay queued for the next issue (until they age out).

### Item writer (new LLM role)

- One call per item on the active model through `completeChatJson`, input
  = the post's sanitized HTML (as the retell prompt gets it today).
- Output (zod): `{ skip: boolean, emoji: string, rubric: ChannelRubric,
  title: string ≤ 80, html: string }`. `skip` is true for posts that are not
  news: contests, giveaways, ads, course sales, personal stories. The model
  may not pick rubric `дайджест` (code-only, as in the branding work).
- `html`: 2–4 sentences, ≤ 450 visible characters, author's voice in other
  words, inline tags only (`b i u s a code`), links only from the source.
- Checks (reusing the retell ones): links only from the source post
  (`cleanRetellHtml` allow-list), no numbers absent from the source
  (`numbersOf`), visible length ≤ 450 with the one shorten retry already in
  `retellChannelPost`, title non-empty. `emoji` that is not exactly one emoji
  becomes 📌. A failed item is dropped and logged; the issue continues.
- Humanizer pass on `html` with the existing rule (kept only when tags and
  links are unchanged).
- Token budget: the empty-reply fix from the "empty retells" session (model
  spending the whole budget on reasoning for long posts) must be in place;
  otherwise long posts silently fall out of every issue.

### Publishing and failures

- Idempotency: one issue per slot (`YYYY-MM-DD` + morning/evening). The batch
  is claimed atomically (`claimDigestBatch`, filtered by `kind=channel`); a
  published slot is recorded and never sent twice.
- Telegram rejects the rich message (4xx) → fallback `sendMessage` in
  Telegram HTML: bold headings, text, `#rubric`, no photos, cut from
  the end to 4096 characters. Owner notified that the article was rejected.
- Network error or 5xx on send → maybe posted: no resend, candidates →
  `needs_verification`, owner asked to check the channel (existing behaviour).
- 429 / 403 → not posted, batch back to the queue, owner notified.
- `/health` row «Каналы» gains the last issue outcome.

## Sources

- Remove `aostrikov_ai_agents` from `DEFAULT_CHANNELS`.
- Checked candidates (public preview, ≥ 3 posts in 7 days, authored, on
  topic; research 2026-10-01). Recommended: `the_ai_architect`, `nobilix`,
  `neuraldeep`, `evilfreelancer`, `kdoronin_blog`, `oestick`. Weaker:
  `notboring_tech`, `boris_again`, `toBeAnMLspecialist`, `claudedevolper`,
  `gleb_pro_ai`, `vibecoding_tg`. The owner picks; the list is data in
  `defaultChannels.ts`.

## Config

- `CHANNEL_WATCH_CRON` prod value → `15 8-22 * * *`.
- New `CHANNEL_DIGEST_CRON` (unset = off), prod `0 11,19 * * *`; added to
  `envSchema.ts` and `.env.example`.
- `autoPublishChannels` flag keeps its meaning (auto vs owner preview).

## Evals and tests

- New eval suite DIGEST_ITEM: the six recorded channel posts plus
  `aostrikov_ai_agents/205` (a contest) that must come back `skip: true`.
  Checks: title present, ≤ 450 visible, links and numbers only from the
  source, one emoji, rubric in the allowed five.
- Unit tests: article builder (layout above, slideshow vs single photo vs
  none, media ids, 50-media and 32 768-character limits), issue picking
  (priority, views ratio, 2 per channel, shared-link duplicates, age-out),
  fewer-than-3 path, fallback text, idempotent slot, queue refresh of views.
- Live check before enabling: one real issue built by the bot and sent to the
  owner DM, compared by eye with trial F4.

## Retired

Hourly per-post publishing to the channel, `CHANNEL_DAILY_LIMIT`, the
single-post caption path for channel retellings (`publishToChannel` photo /
album / caption logic) once nothing calls it. The retell prompt, checks,
sanitizer, parser and `downloadImage` are reused.

## Sequencing

The branding work (cover renderer, rubrics, `numbersOf`, `linkables`) is
uncommitted in the main checkout at the time of writing and changes the same
retell files. Implementation starts after it is committed, in a separate
worktree, on top of it.
