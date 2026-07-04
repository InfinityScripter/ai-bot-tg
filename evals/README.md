# Prompt evals

Scores the two post-generation prompts — `REWRITE_SYSTEM_PROMPT` (turn a feed
item into a blog post) and `RELEVANCE_SYSTEM_PROMPT` (0–4 topic score) — against
a fixed set of fixtures.

## Run

```bash
npm run eval                          # mock mode: recorded replies + deterministic checks (no credits)
npm run eval -- --only ru-rich-images # a single case
npm run eval -- --mode live           # call the real provider from .env (spends credits)
npm run eval -- --mode live --judge   # live + LLM-as-judge on the produced posts
npm run eval -- --mode live --record  # live + overwrite the recordings from this run
```

Exit code is non-zero when any case has an `error`-severity finding, so it works
as a gate. Warnings are printed but do not fail.

## How it works

Two layers:

1. **Deterministic checks** (`checks/`) — zero cost. Each fixture's raw model
   reply is pushed through the EXACT production path (`extractJson` →
   `finalizeRewrite`) and then asserted against the output contract: valid schema,
   title within the 100-char clamp (warn over the 80 target), one canonical
   `Источник:` line at the item URL, no leading heading, only allow-listed body
   images, tags ⊆ whitelist with `новости` first, clean markdown (no escaped md,
   no HTML, well-formed links). Relevance replies are checked for a parseable
   in-range score that lands in the fixture's expected band. These graders are
   themselves unit-tested in `tests/eval-checks.test.ts`.

2. **LLM-as-judge** (`judge/`, opt-in `--judge`, live only) — a separate model
   scores each produced post 1–5 on a RU quality rubric (originality, structure,
   factual restraint, tone, formatting) and lists issues. Advisory: fails a case
   only when the score is below `EVAL_JUDGE_FLOOR` (default 3).

## Modes

- **mock** (default): reads `fixtures/recorded/<id>.json` — a frozen realistic
  reply per case. Deterministic, CI-safe. Proves the harness and locks the
  output contract; it does not judge model quality.
- **live**: resolves the real provider from env (via the same
  `resolveActiveProvider` the bot uses) and actually calls the prompts. Needs a
  funded provider key in `.env`. Use for manual QA and to regenerate recordings
  (`--record`). Never run by CI.

Env knobs for live: `EVAL_JUDGE_PROVIDER`, `EVAL_JUDGE_MODEL` (default: the
rewrite provider/model), `EVAL_JUDGE_FLOOR` (default 3).

## Fixtures

- `fixtures/rewriteCases.ts` — RU + EN sources, thin/rich snippets, with/without
  images.
- `fixtures/relevanceCases.ts` — BORDERLINE items only (obvious on/off-topic are
  decided by stage-A markers before any LLM call), each tagged with the expected
  band. Titles deliberately dodge the stage-A marker substrings so live mode
  actually reaches the classifier.
- `fixtures/recorded/**` — one raw reply per case for mock mode.
