# Auto-publish master switches and quality gates

Builds on `2026-07-22-auto-publish-source-covers-design.md` (which turned the
daily run fully automatic). That left two things the owner asked for but the code
never had: a runtime **off switch** and **quality brakes**. This adds both.

## Decision

Two independent master switches, `autoPublishReleases` and `autoPublishNews`, gate
the automatic path per candidate kind. They live in the **blog backend** admin
settings (single source of truth, one web UI), not in the bot — the bot reads
them over HTTP each run. Off by default: a fresh deploy never auto-publishes until
the owner explicitly turns a switch on.

Per candidate, the collector now decides:

- switch **on** → auto-publish through the existing atomic lifecycle (unchanged);
- switch **off** → **divert to manual**: clear the row's `auto_publish` flag and
  DM the owner the RAW approval card (the pre-2026-07-22 flow). Nothing is lost.

On the auto path, a **quality gate** (`assertPublishable`) runs after extraction
and before the publish claim. A gate failure is not swallowed — it throws, and the
existing automatic-failure handler turns the candidate into a manual card. So a
borderline item is escalated to the owner, never silently auto-posted or dropped.

## Where each piece lives

- **Backend** (`blog-app-mui-backend`): `autoPublishReleases` / `autoPublishNews`
  added to the existing `settingsService` flag machinery (env-seeded via
  `AUTO_PUBLISH_*_ENABLED`, `app_settings` table, 10s cache). Toggled by
  `POST /api/admin/settings/auto-publish` (`requireAuth(requireAdmin)`), read by
  the bot via the existing `GET /api/admin/settings`.
- **Bot** (`ai-bot-tg`):
  - `src/blog/fetchAutoPublishFlags.ts` — reads the two flags, **fail-closed**.
  - `src/server/createProcessCandidate.ts` — the deciding per-candidate callback
    (auto vs divert), built in each entrypoint over `autoPublishCandidate` +
    `sendRawCard`.
  - `src/llm/qualityGate.ts` — `assertPublishable` + `GateFailure`.
  - `src/store/candidateMutations.ts` — `clearAutoPublish(db, id)`.

## Flags read once per run

`createProcessCandidate` reads the flags a single time and the whole run uses that
snapshot. The daily cron runs once and `/fetch` is manual, so a mid-run flip is
neither expected nor wanted; the backend's own 10s flag cache is irrelevant at
this cadence. Reading before the callback is returned also means crash-recovery
obeys the same snapshot: `runCollection` resumes recovered automatic rows through
this callback before it touches feeds, so a recovered row is diverted too when its
switch is off.

## Fail-closed

`fetchAutoPublishFlags` returns `{releases:false, news:false}` on any failure —
network error, timeout, non-2xx, or an unexpected/mis-nested body. A blog outage
therefore diverts everything to manual rather than auto-publishing against an
intended "off". Nothing is lost: the owner still gets every item as a manual card,
and the manual cards ARE the signal (the owner is not separately alerted that
automation is off). The flags are read strictly — only an explicit boolean `true`
enables; the backend envelope is `{ success, data: { flags } }`, so the flags are
parsed from `data.data.flags`, never the top level.

## Quality gate

`assertPublishable(candidate, extraction)` — auto path only; manual ✅ deliberately
bypasses it. Two checks beyond the zod schemas' `.min(1)`:

1. **Substance** — news needs a rewritten body ≥ 400 chars (a headline-only stub
   is not a post); a release needs ≥ 1 extracted change (an empty `changes[]`
   means the extractor found nothing to announce). A release's own body is not
   length-gated.
2. **Source** — the article host is not on a small junk **blocklist** (link
   shorteners, social/aggregator permalinks, parking). A blocklist, not an
   allowlist: most sources are fine and Hacker News legitimately links out to
   arbitrary domains, so allow-listing feed hosts would wrongly divert good
   HN-surfaced articles. Matched on exact host or subdomain (not substring, so a
   lookalike like `notbit.lyx.com` is not blocked). Fails **open** on an
   unparseable URL — the substance check and the manual fallback are the real
   backstops.

Insertion point: `processClaimedCandidateAutomatically`, between
`runClaimedExtraction` (which stored the extraction, state now `pending_review`)
and `claimForPublishing`. A thrown `GateFailure` propagates to
`runAutomaticPublish`'s catch → `showFailure`, which leaves the candidate on its
preview card (✅ to publish manually).

## The changelog draft-job stays

The scheduled `ai-changelog-watcher` job is unchanged and NOT a duplicate of the
bot's release path. The bot writes **facts** (`ModelRelease`: vendor/model/
version/prices/context/source) to `model_releases`; the job drafts **editorial**
records (`LlmModel`: `highlight`, `funFact`, description) for the static
`models-2026.ts`. The `/changelog` page merges them (`buildUnifiedLlmCatalog`),
so bot facts enrich the job's editorial text into one card. Removing the job would
make cards plain.

## Pre-existing behavior noted, not changed here

Channel cross-post fires only on the auto path; manual ✅ does not cross-post. As
diversion pushes more items through manual approval, "no channel post after a
manual publish" becomes more visible. That is existing behavior — to be addressed
separately, not in this change.
