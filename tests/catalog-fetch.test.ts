import { it, vi, expect, describe, afterEach } from "vitest";

import { fetchArtificialAnalysis } from "../src/catalog/fetchCatalog.js";

const model = (slug: string) => ({
  name: slug,
  slug,
  release_date: "2026-10-29",
  model_creator: { name: "Z AI" },
  pricing: { price_1m_input_tokens: 0.6, price_1m_output_tokens: 1.8 },
});

afterEach(() => vi.restoreAllMocks());

describe("fetchArtificialAnalysis", () => {
  it("walks every page of the V2 free route", async () => {
    const pages = [
      { data: [model("a")], pagination: { page: 1, has_more: true } },
      { data: [model("b")], pagination: { page: 2, has_more: false } },
    ];
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () => Response.json(pages.shift()));

    const models = await fetchArtificialAnalysis("key");

    expect(models.map((m) => m.slug)).toEqual(["a", "b"]);
    expect(fetchSpy.mock.calls.map((c) => String(c[0]))).toEqual([
      "https://artificialanalysis.ai/api/v2/language/models/free?page=1",
      "https://artificialanalysis.ai/api/v2/language/models/free?page=2",
    ]);
  });
});
