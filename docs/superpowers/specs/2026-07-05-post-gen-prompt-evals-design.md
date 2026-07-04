# Post-generation prompt rework + eval harness

**Date:** 2026-07-05
**Branch:** `claude/improve-post-gen-prompts`
**Scope:** `REWRITE_SYSTEM_PROMPT` + `RELEVANCE_SYSTEM_PROMPT` (the two prompts that
decide whether a feed item becomes a post and how it's rewritten), plus a new
prompt-eval harness that scores them.

## Goal

1. Deep-rework both prompts, fixing concrete defects found in the audit below.
2. Ship an eval harness: deterministic contract checks on real rewrite output +
   an optional LLM-as-judge quality pass. Runs on mock/recorded output in CI (no
   credits); a small live-run mode exists behind an env flag for manual QA.

## Audit — defects the rework fixes

### REWRITE_SYSTEM_PROMPT (`src/llm/prompts.ts`)

| # | Defect | Fix |
|---|--------|-----|
| R1 | **Tag whitelist drift.** Prompt lists 12 tags; code `TAG_WHITELIST` has 14 (adds `новости`, `наука и техника`). Two sources of truth diverge. | Generate the tag list in the prompt FROM `TAG_WHITELIST` at module load, so it can never drift. Exclude `новости` (force-added by `normalizeTags`) from the model-facing list with a note. |
| R2 | **Title-length contradiction.** Prompt says "до 80 символов"; `finalizeRewrite` clamps at 100. | Align on one number. Prompt asks for ≤ 80 (headline-quality target); code keeps the 100 hard clamp as the safety net. Document the split in the prompt via a single "target ≤ 80" line. |
| R3 | **No hard language rule.** Sources include English feeds; prompt says "на русском" but never states EN→RU is mandatory. | Add explicit rule: output is ALWAYS Russian even when the source is English; keep proper nouns / product names / code identifiers verbatim. |
| R4 | **Weak anti-hallucination.** One trailing line. Critical for a news blog. | Promote to a dedicated, emphatic block: never invent numbers, dates, quotes, benchmarks, or names absent from the input; when the source is thin, write shorter, not made-up. |
| R5 | **Formatting rules are a long unstructured list.** Hard for the model to weight. | Reorganize into labeled sections (ROLE / LANGUAGE / STRUCTURE / LINKS+IMAGES / ANTI-HALLUCINATION / OUTPUT) without losing any existing rule. |

### RELEVANCE_SYSTEM_PROMPT (`src/llm/prompts.ts`)

| # | Defect | Fix |
|---|--------|-----|
| V1 | **Uncalibrated 0–4 scale.** Only 0 and 4 defined; default `threshold=2` sits on the border. Scores 1/2/3 are guesswork. | Define every rung 0–4 with a one-line rubric and an example, so the border (2) is meaningful. |
| V2 | **No mention of the stage-A carve-out.** The LLM is only ever called for the *gray zone* (obvious AI/off-topic are caught by markers before the call). | Tell the model it sees borderline items and to reason about the AI/tech *angle* rather than surface keywords. |
| V3 | **Unbounded `topic`/`reason`.** Free-form → wasted tokens. | Cap: `topic` 2–4 words, `reason` ≤ 12 words. |

Everything the pipeline already repairs deterministically — source line
(`ensureSourceLine`), image allow-list (`sanitizeImages`), tag normalization
(`normalizeTags`), title clamp — stays as the safety net. The prompt rework
reduces how often those nets have to fire; it does not replace them.

## Prompt structure (after rework)

Both prompts keep their existing public API (`REWRITE_SYSTEM_PROMPT`,
`RELEVANCE_SYSTEM_PROMPT`, `buildRewriteUserContent`, `buildRelevanceUserContent`
— same names, same signatures) so no consumer changes. Internals:

- A new **`src/llm/tagVocabulary.ts`** exports `MODEL_TAG_LIST` — the whitelist
  minus `новости`, joined for prompt interpolation. `prompts.ts` imports it, so
  the prompt tag list is derived, not hand-copied. (Single source of truth for R1.)
- `REWRITE_SYSTEM_PROMPT` becomes a template literal composed of labeled sections.
- `RELEVANCE_SYSTEM_PROMPT` gains the 0–4 rubric.

## Eval harness

New directory **`evals/`** (kept out of `src/`, run via a dedicated script, not
part of the unit `vitest run`, so live runs never fire in CI by accident).

```
evals/
  fixtures/
    rewrite-cases.ts      # FeedItem inputs + per-case expectations
    relevance-cases.ts    # borderline FeedItem inputs + expected score band
  checks/
    rewriteChecks.ts      # deterministic contract assertions on a RewriteResult
    relevanceChecks.ts    # score-band assertions
  judge/
    judgePrompt.ts        # LLM-as-judge system prompt (RU quality rubric)
    runJudge.ts           # calls the judge model, parses a 1–5 score
  runEval.ts              # CLI entrypoint: --mode mock|live, --judge, --only
  report.ts               # pretty console table + pass/fail summary + JSON out
```

### Deterministic checks (rewrite) — zero credits

For each fixture, run the real `finalizeRewrite` path on a **recorded** raw model
reply (or a live one in live mode) and assert:

- JSON parses and passes `RewriteSchema`.
- `title` non-empty, ≤ 100 chars (hard), and flag a soft warning if > 80.
- `title` does not start with `#` and is not a duplicate of the source title verbatim.
- `content` ends with exactly one canonical `Источник: [..](..)` line pointing at
  the item URL.
- `content` has no leading H1/`##` on the first line (no heading duplicate).
- Every markdown image URL in `content` is in the item's allow-list (`imageUrls[1:]`).
- `tags` ⊆ `TAG_WHITELIST`, `новости` present and first, length 1–4.
- No raw HTML tags, no backslash-escaped markdown (`\#`, `\-`, `\*`).
- Links are well-formed `[text](url)` — no `текст (http...)`, no dangling `[text]`.
- `metaDescription` ≤ ~160 chars (soft warn over 155).

Each check yields `{id, ok, severity: 'error'|'warn', detail}`. A fixture passes
if it has zero `error`s. Warnings are reported but don't fail.

### Deterministic checks (relevance)

Each relevance fixture declares an `expectBand: 'off'|'gray'|'on'` and an allowed
score set (e.g. `on → {3,4}`). The check parses the model's score and asserts it
lands in the band. Also asserts the reply is valid JSON with `score` in 0–4 and a
non-empty `topic`.

### LLM-as-judge (opt-in, `--judge`)

A separate judge model (default the active provider, overridable) scores each
generated post 1–5 on a RU rubric: originality (not a copy of the source),
structure, factual restraint, tone, formatting cleanliness. The judge returns
`{score, issues[]}`. Judge is advisory — it prints, and fails a case only if
score < a configurable floor (default 3). Judge runs only when `--judge` is set,
so the default eval is deterministic and free.

### Modes

- `--mode mock` (default): use recorded raw replies committed under
  `evals/fixtures/recorded/`. Deterministic, no network, safe for CI. This is how
  we prove the *harness + checks* work and lock the post-processing contract.
- `--mode live`: resolve the real provider from env and actually call the rewrite
  + relevance prompts on the fixtures. Prints results; used for manual QA and to
  regenerate recordings. Never invoked by CI.

### Recordings

`evals/fixtures/recorded/<case-id>.json` holds a raw model reply string per
rewrite case, captured once from a live run. The mock mode feeds these through
the exact production `finalizeRewrite`, so the checks exercise real
post-processing on realistic (if frozen) model output. Recordings are
regenerated by `runEval.ts --mode live --record`.

## Unit tests (vitest, in CI)

To keep the rework honest without spending credits, add focused unit tests under
`tests/`:

- `tests/prompts.test.ts` — asserts the rework's *invariants* on the prompt
  strings themselves: the rewrite prompt's tag list equals `TAG_WHITELIST` minus
  `новости` (guards R1 forever); the relevance prompt defines all of scores 0–4;
  language/anti-hallucination rules are present. Pure string assertions, no LLM.
- `tests/eval-checks.test.ts` — unit-tests the deterministic *check functions*
  themselves against hand-crafted good/bad `RewriteResult`s (a check that never
  fails on bad input is worthless), so the harness's graders are trustworthy.

## package.json

Add: `"eval": "tsx evals/runEval.ts"` (default mock+deterministic) and document
`npm run eval -- --mode live --judge` for the paid path.

## Non-goals

- No change to digest / release-extractor prompts (out of scope).
- No change to the deterministic post-processing modules — they stay as the
  safety net; the prompt just leans on them less.
- No CI wiring of live/judged evals (credits).

## Risks

- **Prompt regression.** Deep rework can shift model behavior. Mitigated by: the
  prompt-invariant unit tests (catch drift), the deterministic eval contract
  (catches broken output shape), and a live judged run before merge.
- **Recording staleness.** Recorded replies freeze one model's output. Acceptable
  — they exist to test the *harness/contract*, not model quality; quality is the
  live judged run's job.
