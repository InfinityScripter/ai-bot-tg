# Topic relevance filter — design

## Problem
The blog is AI/tech-focused, but RSS feeds (and legacy data) bring off-topic
items — fashion, celebrity, sport, general world news. The existing keyword
`FILTER_INCLUDE`/`FILTER_EXCLUDE` is unused and too blunt (keyword-only filters
wrongly drop AI-policy / AI-business stories that *look* like "politics"/
"business"). We want to drop genuinely off-topic items while erring toward
keeping borderline AI-adjacent ones, and keep the owner in control.

Scale: ~15 items/day → LLM cost is a non-issue; optimize for correctness, not
cost.

## Approach (2-stage, conservative, shadow-first)

A new `src/relevance.ts` with a single entry point used by the collector:

```
filterRelevant(items, store, classify?) -> { kept: FeedItem[], decisions: Decision[] }
```

### Stage A — keyword fast-paths (free, no LLM)
- **Hard blocklist** (`OFF_TOPIC_MARKERS`): a tight list of unambiguously
  off-topic terms (гороскоп, футбол, матч, погода, шоу-бизнес, знаменитост,
  свадьб, развод, диета, рецепт, сериал, …). A title+snippet hit → DROP at
  stage A (these never have an AI angle). Kept deliberately SMALL to avoid false
  drops.
- **On-topic fast-accept** (`ON_TOPIC_MARKERS`): ии, нейросет, llm, gpt, claude,
  openai, anthropic, машинное обучение, чип, процессор, разработка, opensource,
  алгоритм, … A hit → ACCEPT immediately, skip stage B (saves the LLM call on
  obvious tech).
- Everything else (no marker either way) → goes to stage B.

### Stage B — single cheap LLM classify call
- `classifyRelevance(item, store): Promise<number | null>` returns a 0–4 score
  (null on any failure). Reuses the provider plumbing: `resolveActiveProvider`
  + the same `chatUrl`/anthropic dispatch shape as the rewriter, with a tiny
  dedicated system prompt asking for `{"score":0-4,"topic":"…","reason":"…"}`.
- **Keep if score >= 2** (RELEVANCE_THRESHOLD, default 2). Drop only 0–1.
- The prompt carries the explicit carve-out: AI policy / AI business / AI labor
  count as ON-topic even though they surface as politics/business.
- **Fail OPEN**: any error, timeout, unparsable response, or provider=mock →
  treat as KEEP (score null). The filter must never silently swallow the queue.

### Stage C — owner control + mode
- `RELEVANCE_MODE` env: `off` | `shadow` | `on` (default `shadow`).
  - `off` — no filtering (current behavior).
  - `shadow` — run the filter, LOG every decision (kept/would-drop + score +
    reason), but DON'T actually drop. The 2-week calibration window.
  - `on` — actually drop stage-A-blocked and stage-B `<2` items.
- Dropped items are simply not inserted/DM'd this run; nothing is hard-deleted.
  Decisions are logged (`[relevance] DROP … score=… reason=…`) for audit.

## Wiring
In `collector.ts runCollection`, after `curateForQueue(...)` and before the
dedup/insert loop: `const { kept, decisions } = await filterRelevant(curated,
store)`. Log a one-line summary (`afterRelevance=…`). Extend `RunSummary` with
`afterRelevance` + `droppedRelevance`. In `shadow`/`off` mode `kept === curated`.

## Config (config.ts)
- `RELEVANCE_MODE`: enum off|shadow|on, default 'shadow'.
- `RELEVANCE_THRESHOLD`: int 0–4, default 2.
- `RELEVANCE_MODEL`: optional — model for the classify call; default = the
  active rewrite model (cheap enough).

## Feeds
Trim the off-topic-prone defaults and lean AI/tech. Keep Habr AI/ML hubs,
opennet, 3dnews, ixbt; the AI hubs are high-signal. (Feed edits are low-risk and
independent; the relevance filter is the real fix.)

## Tests (vitest)
- `relevance.test.ts`:
  - stage-A blocklist drops "Гороскоп на неделю", "Дуа Липа показала платье".
  - stage-A fast-accept keeps "Новая LLM от OpenAI" WITHOUT calling classify.
  - stage-B keep when score>=2, drop when <2 (classify injected/mocked).
  - fail-open: classify throws → item kept.
  - shadow mode: kept === input regardless of scores; decisions still recorded.
  - mock provider → classify skipped, all kept.
- `collector.test.ts`: extend — relevance runs between curate and insert; in
  shadow/off the inserted set is unchanged.

## Non-goals
No embeddings, no per-feed category schema, no DB table for decisions (logs are
enough at this volume). Owner approval flow is untouched.
