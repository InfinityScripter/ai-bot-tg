# Editorial rewrite quality

**Date:** 2026-07-15

## Problem

The rewrite pipeline optimized for a correct neutral summary. Its prompt called
the output a retelling, required neutral journalistic tone, and encouraged the
same headings/lists on every article. The deterministic eval checked JSON and
Markdown shape, while the semantic judge awarded a top score for a neutral
retelling. Formulaic outputs therefore passed 4/4 with zero warnings.

## Goal

Turn source material into a trustworthy article people want to open and finish:

- one clear editorial angle and reader stake;
- specific, honest headline and hook;
- practical implication or trade-off instead of reordered facts;
- recognizable engineer-practitioner voice;
- first-person preservation for author drafts, without inventing first-hand
  experience for external news;
- no unsupported numbers, quotes, or links.

## Design

### Generation

`REWRITE_SYSTEM_PROMPT` describes Mikhail Talalaev's positioning and audience.
The model internally separates facts from PR, chooses one thesis, drafts five
headlines, writes around the thesis, then performs an anti-AI self-edit. Source
material is delimited as untrusted data, and embedded instructions are ignored.

External sources keep the canonical attribution line. Manual author drafts have
no fake empty source link and preserve first person. The JSON/publish contract is
unchanged.

### Production safety net

`finalizeRewrite` first applies the canonical attribution and then parses the
complete Markdown into an AST. Raw HTML is removed. Inline/reference links, GFM
autolinks, bare URLs, and images survive only when their normalized http(s)
target came from the input; unsafe schemes and hostile RSS metadata cannot add a
post-sanitization link.

The blog frontend serializes post, FAQ, release-detail, and release-list JSON-LD
with `<` escaped as `\\u003c`. LLM/backend text therefore cannot terminate the
surrounding `<script type="application/ld+json">` tag.

### Deterministic quality gate

Recorded replies run through the production parser/finalizer. Checks cover:

- generic announcement headlines;
- generic heading plus forced three-item list;
- description copied into the lead;
- lost first-person voice in manual drafts;
- new numeric facts and long direct quotes absent from the source;
- model-invented links.

The corpus contains six cases: RU and EN news, rich and thin sources, images and
no images, a first-person author draft, and a counterintuitive cost result.

### Semantic judge

The optional live judge uses a 100-point rubric:

- headline 20;
- hook 15;
- reader value 20;
- brand voice 15;
- humanizer 15;
- trust 15.

Default pass floor is 80. Any fabricated number, quote, or personal experience
caps trust at 3. Source and post are encoded as separate untrusted JSON blocks;
malformed verdicts and invalid floor configuration fail closed.

## Verification

- the old four recordings passed 4/4 under the old checks; the tightened checks
  rejected those same outputs 0/4 before the fixtures were rewritten;
- security regression tests demonstrated 9 failures before the AST sanitizer,
  URL validation, and encoded prompt boundaries were implemented;
- full Vitest, TypeScript, ESLint, deterministic eval, and changed-file Prettier
  must pass;
- final deterministic eval must pass all six rewrite and four relevance cases;
- frontend JSON-LD regressions must pass for post title/description, FAQ inline
  code, release detail, and release-list fields;
- live generation plus judge was attempted but the configured Anthropic account
  rejected requests because its credit balance was too low;
- independent code/content and security reviewers inspect the final diff.

## Known limitation

Deterministic checks catch objective and high-signal failures, not subjective
reader delight or production CTR. Real conversion still needs impressions,
headline clicks, read depth, and subscription/Telegram conversion tracked over
time. Those measurements are a separate product analytics feature.
