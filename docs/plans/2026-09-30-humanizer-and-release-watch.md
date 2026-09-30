# Humanizer pass and immediate release posts

Date: 2026-09-30. Owner request: run published text through the /humanizer
skill before it goes out, and publish a news post as soon as a new AI model is
released instead of waiting for the next daily digest.

## Decisions (owner-confirmed)

- **Humanizer = the skill's Hemmingway step, in code.** `src/llm/humanize.ts`
  sends the finished text to `hemmingway-27b` with the skill's own system
  prompt (`scripts/hemmingway.sh`). Applied to the post body after the rewrite
  (auto and manual paths share `rewriteToPost`) and to the daily digest intro
  and notes (one call, paragraphs mapped back by count). Title, description and
  Telegram cards are not touched. Digest lines go one call per line: mapping a
  joined reply back by paragraph count could attach a note to the wrong
  headline. The short form of the skill's rules is also
  in the rewrite and digest prompts («ЧИСТЫЙ ТЕКСТ»), so the model writes
  cleaner text before the pass.
- **Releases: full post + changelog card + channel.** A release candidate now
  stores `{post, release}`: the post is the normal news rewrite and publishes
  first; the changelog card follows and soft-fails (warning on the owner card).
  The channel announcement links to the post. The daily Artificial Analysis
  catalog import still fills the changelog independently.
- **Gate: the existing `autoPublishReleases` switch** from the blog admin, read
  fail-closed per run. Off or unreadable means a RAW card to the owner.
- **Release watch every 30 minutes** (`RELEASE_WATCH_CRON`, first proposed at
  4 times a day; the owner chose 30 minutes because the sweep itself is free).

## Why a model check on top of the markers

In September 2026 the release markers matched mostly arXiv papers and forum
threads that mention a vendor next to "release"/"introduces" (35 release
candidates, 32 failed extraction). On 2026-09-30 the markers hit 67 items
published in the last 24 hours, nearly all arXiv. `confirmRelease` asks the
active model a yes/no question; "no" or "could not tell" keeps the item as
news, so a failed check costs urgency, never the item.

## Economics (prices on 2026-09-30)

| Step | Frequency | Cost |
|---|---|---|
| Feed sweep | every 30 min | $0 (23 RSS fetches) |
| Release confirm (gpt-6-luna, ~400 input tokens) | once per fresh marker hit; rejections cached | ~$0.0001 each, ~$0.1/month |
| Release post + card + Hemmingway | 3–5 per month | ~$0.01 each |
| Hemmingway on the daily digest | once a day | ~$0.002 |

Hemmingway: $0.24 / $0.90 per 1M input/output tokens; `reasoning_effort: low`
cut a short rewrite from ~1200 to ~250 output tokens and from 9 s to 2 s with
the same quality (default effort is "xhigh"). Measured on recorded posts:
4–6 s per post, dashes removed, headings, links and the source line kept.

## Guards

- Humanizer is fail-soft: no key, HTTP error, timeout (90 s), empty reply, a
  reply cut at the token limit, or a length change outside 0.67–1.5 × keeps
  the original. The humanized post body goes through `finalizeContent` again
  (link/image allow-list + source line). A digest line that comes back with a
  link, HTML or over the 500-char schema limit keeps the model's own line.
- `/health` has a «Humanizer» row: a free key check (`GET /v1/models`) plus
  the outcome of the latest pass, so a revoked key or a pass that keeps
  falling back is visible without reading the journal.
- Watch sweep: only items with a publish date within 24 h, unseen, marker hit;
  at most 30 confirmations per sweep; stops after 3 "could not tell" answers
  in a row and on shutdown. A sweep where all checks failed (dead key, hung
  provider) throws, and the owner is pinged once until a sweep succeeds.
  A collection waits for a running sweep, so the two never pick up the same
  fresh release row.
- Legacy release rows (bare changelog card, no post) read as "no saved data":
  the owner presses 🔄 and gets the new format.

## Rollout

Add to `.env.production`: `HEMMINGWAY_API_KEY=…` and
`RELEASE_WATCH_CRON=*/30 * * * *`. Both unset = the bot behaves as before,
except the release confirm in the daily run and the new release post format.

## Follow-up the same day: duplicate release posts

The first live sweeps published three posts about one launch (GPT-6.1 Sol):
TechCrunch's launch article, plus The Verge's and Habr's DevDay roundups, which
the first confirm prompt accepted as releases. The two roundup posts were
deleted from the blog.

- **Confirm prompt:** the whole item must be about one launch; event coverage,
  "everything announced" pieces and titles listing several products are news.
  Checked live on the six real marker hits of the day, three runs each: 18/18
  correct (the old prompt got the Verge roundup wrong and gave no answer on the
  Latent.Space issue). These six items are now the `RELEASE` eval suite.
- **No repeat of a published model:** before an automatic publish, the card's
  identity (vendor + model + version, punctuation dropped: "GPT" + "6.1 Sol"
  and "GPT-6.1" + "Sol" match) is compared with releases the bot published in
  the last 14 days. A repeat is not a failure: the row becomes news in the
  daily digest queue (skipped when the digest is off), and the owner card says
  so. A release without an extracted card cannot be matched and publishes.
- **No model named, no release post:** the week before, seven items the
  confirm check accepted (AINews issues, papers, a tax article) failed card
  extraction with `Expected string, received null`; after the soft-fail card
  change each would have gone out as a standalone post. Extraction now throws
  `NoModelInSourceError` when the model answers without a `model` or
  `version` (the prompt asks for null there when the source is not one
  launch), the bundle stores `noModel`, and the automatic runner sends the row
  to the digest like a repeat. A timeout or broken JSON still publishes the
  post alone: only an answer that names no model says the item is not a
  launch.
- **Changelog dates:** a date-only `releasedAt` is sent as midnight UTC; the
  changelog API rejected the GPT-6.1 Sol card for it. That card was sent by
  hand once the fix was verified.
