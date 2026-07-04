import { it, expect, describe } from "vitest";

import { NEWS_TAG, TAG_WHITELIST } from "../src/blog/normalizeTags.js";
import { MODEL_TAGS, MODEL_TAG_LIST } from "../src/llm/tagVocabulary.js";
import { REWRITE_SYSTEM_PROMPT, RELEVANCE_SYSTEM_PROMPT } from "../src/llm/prompts.js";

/**
 * These are pure string-invariant tests — no LLM. They guard the prompt-rework
 * decisions so they can't silently regress:
 *  - the rewrite prompt's tag vocabulary is DERIVED from TAG_WHITELIST (R1), so
 *    the two can never drift again;
 *  - the highest-stakes rules (language, anti-hallucination) are present;
 *  - the relevance prompt calibrates every rung of the 0–4 scale (V1).
 */

describe("tag vocabulary is a single source of truth", () => {
  it("MODEL_TAGS is exactly the whitelist minus новости, in order", () => {
    expect(MODEL_TAGS).toEqual(TAG_WHITELIST.filter((t) => t !== NEWS_TAG));
  });

  it("does not include the force-added новости tag", () => {
    expect(MODEL_TAGS).not.toContain(NEWS_TAG);
    expect(MODEL_TAG_LIST).not.toContain(NEWS_TAG);
  });

  it("the rewrite prompt embeds the derived tag list verbatim", () => {
    expect(REWRITE_SYSTEM_PROMPT).toContain(MODEL_TAG_LIST);
    // Every whitelisted topical tag actually appears in the prompt.
    for (const tag of MODEL_TAGS) {
      expect(REWRITE_SYSTEM_PROMPT).toContain(tag);
    }
  });
});

describe("REWRITE prompt high-stakes rules", () => {
  it("states the hard Russian-output rule (EN→RU)", () => {
    expect(REWRITE_SYSTEM_PROMPT).toMatch(/ВСЕГДА на русском/);
    expect(REWRITE_SYSTEM_PROMPT).toMatch(/даже если источник на английском/);
  });

  it("has a dedicated anti-hallucination block", () => {
    expect(REWRITE_SYSTEM_PROMPT).toMatch(/АНТИ-ГАЛЛЮЦИНАЦИ/);
    expect(REWRITE_SYSTEM_PROMPT).toMatch(/НЕ выдумывай/);
  });

  it("frames the title length as a target (≤80), not a hard rule", () => {
    // The prompt asks for ≤80; the code hard-clamps at 100 (finalizeRewrite).
    expect(REWRITE_SYSTEM_PROMPT).toMatch(/80 символов/);
  });

  it("still requires the canonical Источник: last line matching ensureSourceLine", () => {
    // The literal format the SOURCE_LINE_RE expects.
    expect(REWRITE_SYSTEM_PROMPT).toMatch(/Источник: \[название\]\(URL\)/);
  });
});

describe("RELEVANCE prompt calibration", () => {
  it("defines every rung of the 0–4 scale", () => {
    for (const rung of ["0 —", "1 —", "2 —", "3 —", "4 —"]) {
      expect(RELEVANCE_SYSTEM_PROMPT).toContain(rung);
    }
  });

  it("frames items as borderline (stage-A carve-out)", () => {
    expect(RELEVANCE_SYSTEM_PROMPT).toMatch(/ПОГРАНИЧНЫЕ/);
  });

  it("keeps the AI-politics/business carve-out", () => {
    expect(RELEVANCE_SYSTEM_PROMPT).toMatch(/ON-topic/);
    expect(RELEVANCE_SYSTEM_PROMPT).toMatch(/политика вокруг ИИ/);
  });

  it("bounds the topic/reason fields", () => {
    expect(RELEVANCE_SYSTEM_PROMPT).toMatch(/2-4 слова/);
    expect(RELEVANCE_SYSTEM_PROMPT).toMatch(/до 12 слов/);
  });
});
