import { it, expect, describe } from "vitest";

import { DEFAULT_COVERS, pickDefaultCover } from "../src/blog/defaultCovers.js";

// A spread of distinct titles so the title-hash lands on several pool slots.
const titles = Array.from({ length: 60 }, (_, i) => `Distinct headline number ${i}`);
const coversFor = (tags: string[]): Set<string> =>
  new Set(titles.map((title) => pickDefaultCover(title, tags)));

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
    expect(DEFAULT_COVERS).toContain(pickDefaultCover("Some title", ["новости", "ai"]));
    expect(DEFAULT_COVERS).toContain(pickDefaultCover("Some title"));
  });

  it("is deterministic for the same title and tags", () => {
    expect(pickDefaultCover("Same", ["новости", "ai"])).toBe(
      pickDefaultCover("Same", ["новости", "ai"]),
    );
  });

  it("varies across titles within a topic (not all identical)", () => {
    expect(coversFor(["ai"]).size).toBeGreaterThan(1);
  });

  it("picks by meaning: AI and security posts draw from disjoint pools", () => {
    const ai = coversFor(["ai"]);
    const security = coversFor(["безопасность"]);
    for (const cover of ai) expect(security.has(cover)).toBe(false);
  });

  it("maps related tags to the AI pool (llm / агенты / нейросети → ai)", () => {
    const ai = coversFor(["ai"]);
    for (const tag of ["llm", "агенты", "нейросети"]) {
      for (const title of titles) expect(ai.has(pickDefaultCover(title, [tag]))).toBe(true);
    }
  });

  it("uses the first topical tag and skips новости", () => {
    // новости has no pool; ai wins over the later безопасность.
    expect(pickDefaultCover("x", ["новости", "ai", "безопасность"])).toBe(
      pickDefaultCover("x", ["ai"]),
    );
  });

  it("falls back to the universal pool for non-topical tags", () => {
    const universal = coversFor(["политика"]);
    // новости-only and no-tags resolve to the same universal pool.
    expect(coversFor(["новости"])).toEqual(universal);
    expect(coversFor([])).toEqual(universal);
    for (const cover of universal) expect(DEFAULT_COVERS).toContain(cover);
  });
});
