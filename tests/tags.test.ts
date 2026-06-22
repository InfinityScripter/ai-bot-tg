import { it, expect, describe } from "vitest";

import {
  NEWS_TAG,
  normalizeTags,
  TAG_WHITELIST,
  DEFAULT_COVERS,
  pickDefaultCover,
} from "../src/blog/normalizeTags.js";

describe("normalizeTags", () => {
  it("always returns новости first, even from an empty list", () => {
    expect(normalizeTags([])).toEqual([NEWS_TAG]);
  });

  it("keeps only whitelisted tags and drops junk", () => {
    expect(normalizeTags(["технологии", "random-junk", "наука"])).toEqual([
      NEWS_TAG,
      "технологии",
      "наука",
    ]);
  });

  it("lowercases and trims before matching", () => {
    expect(normalizeTags(["  Технологии  ", "НАУКА"])).toEqual([NEWS_TAG, "технологии", "наука"]);
  });

  it("maps synonyms (ии/искусственный интеллект → ai, tech → технологии, science → наука)", () => {
    expect(normalizeTags(["ии"])).toEqual([NEWS_TAG, "ai"]);
    expect(normalizeTags(["искусственный интеллект"])).toEqual([NEWS_TAG, "ai"]);
    expect(normalizeTags(["tech"])).toEqual([NEWS_TAG, "технологии"]);
    expect(normalizeTags(["science"])).toEqual([NEWS_TAG, "наука"]);
  });

  it("dedupes (including новости and synonym collisions)", () => {
    expect(normalizeTags([NEWS_TAG, "ai", "ии", "ai"])).toEqual([NEWS_TAG, "ai"]);
  });

  it("caps the total at 4 tags", () => {
    const result = normalizeTags(["технологии", "наука", "политика", "культура", "бизнес"]);
    expect(result).toHaveLength(4);
    expect(result[0]).toBe(NEWS_TAG);
  });

  it("only ever emits whitelisted tags", () => {
    const result = normalizeTags(["gadgets", "security", "dev", "totally-made-up"]);
    for (const tag of result) {
      expect(TAG_WHITELIST).toContain(tag);
    }
  });
});

describe("pickDefaultCover", () => {
  it("returns a stable cover from the default set", () => {
    const cover = pickDefaultCover("Some news title");
    expect(DEFAULT_COVERS).toContain(cover);
  });

  it("is deterministic for the same title", () => {
    expect(pickDefaultCover("Same title")).toBe(pickDefaultCover("Same title"));
  });

  it("varies across different titles (not all identical)", () => {
    const covers = new Set(
      Array.from({ length: 25 }, (_, i) => pickDefaultCover(`Distinct title number ${i}`)),
    );
    expect(covers.size).toBeGreaterThan(1);
  });
});
