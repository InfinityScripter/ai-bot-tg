import { it, vi, expect, describe, afterEach } from "vitest";

import type { CatalogModel } from "../src/catalog/index.js";

// The import reads CONFIG at call time, so a mutable stub lets one file cover
// both the "no key" branch and a normal run.
const CONFIG = {
  AA_API_KEY: "test-aa-key" as string | undefined,
  BLOG_API_URL: "http://localhost:7272",
  BOT_API_TOKEN: "test-bot-api-token-value",
  CATALOG_IMPORT_DAYS: 3,
};
vi.mock("../src/config.js", () => ({ CONFIG }));

const fetchAutoPublishFlags = vi.fn(async () => ({ releases: true, news: true }));
vi.mock("../src/blog/index.js", () => ({
  fetchAutoPublishFlags: () => fetchAutoPublishFlags(),
}));

const fetchArtificialAnalysis = vi.fn<() => Promise<CatalogModel[]>>();
const fetchOpenRouterContexts = vi.fn(async () => new Map<string, number>());
vi.mock("../src/catalog/fetchCatalog.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/catalog/fetchCatalog.js")>();
  return {
    ...actual,
    fetchArtificialAnalysis: () => fetchArtificialAnalysis(),
    fetchOpenRouterContexts: () => fetchOpenRouterContexts(),
  };
});

const { importCatalog, collapseVariants, toReleasePayload } =
  await import("../src/catalog/index.js");

const NOW = new Date("2026-08-07T12:00:00Z");

function model(overrides: Partial<CatalogModel> = {}): CatalogModel {
  return {
    vendor: "InclusionAI",
    name: "Ling 3.0 Tiny",
    slug: "ling-3-0-tiny",
    releaseDate: "2026-08-06",
    priceIn: null,
    priceOut: null,
    sourceUrl: "https://artificialanalysis.ai/models/ling-3-0-tiny",
    ...overrides,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  CONFIG.AA_API_KEY = "test-aa-key";
  fetchAutoPublishFlags.mockResolvedValue({ releases: true, news: true });
});

describe("collapseVariants", () => {
  it("сводит режимы усилия одной модели в одну запись с коротким именем", () => {
    const collapsed = collapseVariants([
      model({ name: "Claude Opus 5 (Adaptive Reasoning, Xhigh Effort)", vendor: "Anthropic" }),
      model({ name: "Claude Opus 5", vendor: "Anthropic" }),
      model({ name: "Claude Opus 5 (low)", vendor: "Anthropic" }),
    ]);

    expect(collapsed).toHaveLength(1);
    expect(collapsed[0]?.name).toBe("Claude Opus 5");
  });

  it("модели с нелатинскими именами не сливаются в одну", () => {
    const collapsed = collapseVariants([
      model({ name: "文心 5", slug: "wenxin-5" }),
      model({ name: "通义 3", slug: "tongyi-3" }),
    ]);

    expect(collapsed).toHaveLength(2);
  });

  it("разные модели одного вендора не схлопываются", () => {
    const collapsed = collapseVariants([
      model({ name: "Ling 3.0 Tiny" }),
      model({ name: "Ling-3.0-flash", slug: "ling-3-0-flash" }),
    ]);

    expect(collapsed).toHaveLength(2);
  });
});

describe("toReleasePayload", () => {
  it("приводит вендора к написанию курируемого таймлайна", () => {
    expect(toReleasePayload(model(), null).vendor).toBe("Ant Group");
    expect(toReleasePayload(model({ vendor: "Thinking Machines" }), null).vendor).toBe(
      "Thinking Machines Lab",
    );
    expect(toReleasePayload(model({ vendor: "OpenAI" }), null).vendor).toBe("OpenAI");
  });

  it("собирает тело запроса из даты релиза и данных каталога", () => {
    const payload = toReleasePayload(model({ priceIn: 0.21, priceOut: 0.63 }), 262144);

    expect(payload).toMatchObject({
      model: "Ling 3.0 Tiny",
      version: "2026-08-06",
      releasedAt: "2026-08-06T00:00:00Z",
      slug: "ling-3-0-tiny",
      contextTokens: 262144,
      priceIn: 0.21,
      priceOut: 0.63,
      changes: [],
      sourceName: "Artificial Analysis",
    });
  });
});

describe("importCatalog", () => {
  it("без ключа ничего не публикует", async () => {
    CONFIG.AA_API_KEY = undefined;
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    const summary = await importCatalog({ now: NOW });

    expect(summary.skipped).toBe("AA_API_KEY unset");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("при выключенном флаге автопубликации ничего не публикует", async () => {
    fetchAutoPublishFlags.mockResolvedValue({ releases: false, news: false });
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    const summary = await importCatalog({ now: NOW });

    expect(summary.skipped).toBe("autoPublishReleases is off");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("берёт только релизы в окне и считает исходы публикации", async () => {
    fetchArtificialAnalysis.mockResolvedValue([
      model({ name: "Fresh One", slug: "fresh", releaseDate: "2026-08-06" }),
      model({ name: "Already There", slug: "duplicate", releaseDate: "2026-08-05" }),
      model({ name: "Broken One", slug: "broken", releaseDate: "2026-08-05" }),
      model({ name: "Old One", slug: "stale", releaseDate: "2026-07-01" }),
    ]);
    const responses: Record<string, number> = { fresh: 201, duplicate: 409, broken: 500 };
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as { slug: string };
      return new Response("{}", { status: responses[body.slug] });
    });

    const summary = await importCatalog({ days: 3, now: NOW });

    expect(summary).toMatchObject({
      scanned: 4,
      fresh: 3,
      created: 1,
      duplicate: 1,
      failed: 1,
    });
    expect(fetchSpy).toHaveBeenCalledTimes(3);
    const call = fetchSpy.mock.calls[0];
    expect(call?.[0]).toBe("http://localhost:7272/api/changelog/new");
    expect((call?.[1]?.headers as Record<string, string>)?.Authorization).toBe(
      "Bearer test-bot-api-token-value",
    );
  });

  it("недоступный OpenRouter не срывает импорт, контекст остаётся неизвестным", async () => {
    fetchArtificialAnalysis.mockResolvedValue([model()]);
    fetchOpenRouterContexts.mockRejectedValue(new Error("network down"));
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("{}", { status: 201 }));

    const summary = await importCatalog({ now: NOW });

    expect(summary.created).toBe(1);
    const body = JSON.parse(String(fetchSpy.mock.calls[0]?.[1]?.body)) as {
      contextTokens: number | null;
    };
    expect(body.contextTokens).toBeNull();
  });
});
