import { it, expect, describe } from "vitest";

import { coverSeed, DEFAULT_COVERS, pickDefaultCover } from "../src/blog/defaultCovers.js";

// Covers returned for a topic across seq 0..n-1 (one cover per candidate id).
const coversForSeqRange = (tags: string[], n: number): Set<string> =>
  new Set(Array.from({ length: n }, (_, seq) => pickDefaultCover(tags, seq)));

describe("DEFAULT_COVERS", () => {
  it("is a large pool (well beyond the old 5)", () => {
    expect(DEFAULT_COVERS.length).toBeGreaterThan(20);
  });

  it("has no duplicate URLs", () => {
    expect(new Set(DEFAULT_COVERS).size).toBe(DEFAULT_COVERS.length);
  });

  it("contains only absolute https Unsplash image URLs", () => {
    for (const url of DEFAULT_COVERS) {
      expect(url).toMatch(/^https:\/\/images\.unsplash\.com\/photo-/);
    }
  });
});

describe("pickDefaultCover", () => {
  it("always returns a known cover from the pool", () => {
    expect(DEFAULT_COVERS).toContain(pickDefaultCover(["новости", "ai"], 1));
    expect(DEFAULT_COVERS).toContain(pickDefaultCover([], 1));
  });

  it("is deterministic for the same tags and seq", () => {
    expect(pickDefaultCover(["ai"], 7)).toBe(pickDefaultCover(["ai"], 7));
  });

  it("gives consecutive posts different covers (no adjacent repeat)", () => {
    for (let seq = 0; seq < 20; seq += 1) {
      expect(pickDefaultCover(["ai"], seq)).not.toBe(pickDefaultCover(["ai"], seq + 1));
    }
  });

  it("rotates through the whole topic pool before any repeat (unique covers)", () => {
    const first = pickDefaultCover(["ai"], 0);
    const seen = [first];
    let period = -1;
    for (let seq = 1; seq < 500; seq += 1) {
      const cover = pickDefaultCover(["ai"], seq);
      if (cover === first) {
        period = seq;
        break;
      }
      seen.push(cover);
    }
    // The pool cycles back to the first cover only after a full rotation, and
    // every cover within that rotation is unique — no early repeats.
    expect(period).toBeGreaterThan(10);
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen.length).toBe(period);
  });

  it("picks by meaning: AI and security posts draw from disjoint pools", () => {
    const ai = coversForSeqRange(["ai"], 80);
    const security = coversForSeqRange(["безопасность"], 80);
    for (const cover of ai) expect(security.has(cover)).toBe(false);
  });

  it("maps related tags to the AI pool (llm / агенты / нейросети → ai)", () => {
    for (const tag of ["llm", "агенты", "нейросети"]) {
      for (let seq = 0; seq < 40; seq += 1) {
        expect(pickDefaultCover([tag], seq)).toBe(pickDefaultCover(["ai"], seq));
      }
    }
  });

  it("uses the first topical tag and skips новости", () => {
    expect(pickDefaultCover(["новости", "ai", "безопасность"], 3)).toBe(
      pickDefaultCover(["ai"], 3),
    );
  });

  it("falls back to the universal pool for non-topical tags", () => {
    const universal = coversForSeqRange(["политика"], 40);
    // новости-only and no-tags resolve to the same universal pool.
    expect(coversForSeqRange(["новости"], 40)).toEqual(universal);
    expect(coversForSeqRange([], 40)).toEqual(universal);
    for (const cover of universal) expect(DEFAULT_COVERS).toContain(cover);
  });

  it("uses a LARGE universal pool so bare новости posts do not repeat", () => {
    // Untagged/новости items are the majority of the feed; a small universal
    // pool made them cycle a handful of covers (the live-blog duplication:
    // 7–11 posts sharing one image). Keep the fallback pool big.
    const universal = coversForSeqRange(["политика"], 400);
    expect(universal.size).toBeGreaterThan(40);
  });

  it("tolerates negative, fractional and NaN seq", () => {
    for (const seq of [-1, -100, 3.7, Number.NaN]) {
      expect(DEFAULT_COVERS).toContain(pickDefaultCover(["ai"], seq));
    }
  });
});

describe("coverSeed", () => {
  it("is deterministic and non-negative", () => {
    expect(coverSeed("Some title")).toBe(coverSeed("Some title"));
    expect(coverSeed("Some title")).toBeGreaterThanOrEqual(0);
  });
});
