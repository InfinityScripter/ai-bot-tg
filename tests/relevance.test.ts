import { it, vi, expect, describe, afterEach } from "vitest";

import { CandidateStore } from "../src/store/index.js";
import { RelevanceMode, RelevanceStage } from "../src/enums.js";
import {
  filterRelevant,
  ON_TOPIC_MARKERS,
  OFF_TOPIC_MARKERS,
  classifyRelevance,
} from "../src/relevance.js";

import type { FeedItem } from "../src/types.js";

function item(overrides: Partial<FeedItem> = {}): FeedItem {
  return {
    dedupKey: "k",
    url: "https://ex/1",
    title: "Title",
    snippet: "snippet",
    feedTitle: "Feed",
    imageUrl: null,
    imageUrls: [],
    publishedAt: null,
    ...overrides,
  };
}

// A throwaway store; every test injects `classify`, so the provider is never
// resolved nor called — no network, no real classifyRelevance.
const STORE = new CandidateStore(":memory:");

afterEach(() => {
  vi.restoreAllMocks();
});

describe("relevance markers", () => {
  it("exposes non-empty, lowercase marker lists", () => {
    expect(OFF_TOPIC_MARKERS.length).toBeGreaterThan(0);
    expect(ON_TOPIC_MARKERS.length).toBeGreaterThan(0);
    expect(OFF_TOPIC_MARKERS).toEqual(OFF_TOPIC_MARKERS.map((m) => m.toLowerCase()));
    expect(ON_TOPIC_MARKERS).toEqual(ON_TOPIC_MARKERS.map((m) => m.toLowerCase()));
  });
});

describe("filterRelevant — stage A blocklist (mode on)", () => {
  it("drops an unambiguously off-topic item without calling classify", async () => {
    const classify = vi.fn();
    const items = [
      item({ url: "https://ex/horo", title: "Гороскоп на неделю" }),
      item({ url: "https://ex/dress", title: "Дуа Липа показала платье", snippet: "шоу-бизнес" }),
    ];
    const { kept, decisions } = await filterRelevant(items, STORE, {
      classify,
      mode: RelevanceMode.On,
    });

    expect(kept).toHaveLength(0);
    expect(classify).not.toHaveBeenCalled();
    expect(decisions.every((d) => d.kept === false && d.stage === RelevanceStage.Blocklist)).toBe(
      true,
    );
  });
});

describe("filterRelevant — stage A fast-accept (mode on)", () => {
  it("keeps an obvious AI item WITHOUT calling classify", async () => {
    const classify = vi.fn();
    const items = [item({ url: "https://ex/llm", title: "Новая LLM от OpenAI" })];
    const { kept, decisions } = await filterRelevant(items, STORE, {
      classify,
      mode: RelevanceMode.On,
    });

    expect(kept).toHaveLength(1);
    expect(classify).not.toHaveBeenCalled();
    expect(decisions[0]!.kept).toBe(true);
    expect(decisions[0]!.stage).toBe(RelevanceStage.Accept);
  });
});

describe("filterRelevant — stage B LLM (mode on)", () => {
  it("keeps when the injected score >= threshold", async () => {
    const classify = vi.fn().mockResolvedValue(3);
    const items = [item({ url: "https://ex/x", title: "Заголовок без явных признаков темы" })];
    const { kept, decisions } = await filterRelevant(items, STORE, {
      classify,
      mode: RelevanceMode.On,
      threshold: 2,
    });

    expect(classify).toHaveBeenCalledTimes(1);
    expect(kept).toHaveLength(1);
    expect(decisions[0]!.stage).toBe(RelevanceStage.Llm);
    expect(decisions[0]!.kept).toBe(true);
    expect(decisions[0]!.score).toBe(3);
  });

  it("drops when the injected score < threshold", async () => {
    const classify = vi.fn().mockResolvedValue(1);
    const items = [item({ url: "https://ex/y", title: "Светская хроника недели" })];
    const { kept, decisions } = await filterRelevant(items, STORE, {
      classify,
      mode: RelevanceMode.On,
      threshold: 2,
    });

    expect(classify).toHaveBeenCalledTimes(1);
    expect(kept).toHaveLength(0);
    expect(decisions[0]!.stage).toBe(RelevanceStage.Llm);
    expect(decisions[0]!.kept).toBe(false);
    expect(decisions[0]!.score).toBe(1);
  });
});

describe("filterRelevant — fail-open (mode on)", () => {
  it("keeps the item when classify throws", async () => {
    const classify = vi.fn().mockRejectedValue(new Error("boom"));
    const items = [item({ url: "https://ex/z", title: "Непонятная общая новость" })];
    const { kept, decisions } = await filterRelevant(items, STORE, {
      classify,
      mode: RelevanceMode.On,
    });

    expect(kept).toHaveLength(1);
    expect(decisions[0]!.kept).toBe(true);
    expect(decisions[0]!.stage).toBe(RelevanceStage.FailOpen);
    expect(decisions[0]!.score).toBeNull();
  });

  it("keeps the item when classify returns null (mock provider path)", async () => {
    const classify = vi.fn().mockResolvedValue(null);
    const items = [item({ url: "https://ex/m", title: "Совсем неопределённая новость" })];
    const { kept, decisions } = await filterRelevant(items, STORE, {
      classify,
      mode: RelevanceMode.On,
    });

    expect(kept).toHaveLength(1);
    expect(decisions[0]!.kept).toBe(true);
    expect(decisions[0]!.stage).toBe(RelevanceStage.FailOpen);
    expect(decisions[0]!.score).toBeNull();
  });
});

describe("filterRelevant — shadow mode", () => {
  it("returns ALL input items even with low scores, but records would-drop decisions", async () => {
    const classify = vi.fn().mockResolvedValue(0);
    const items = [
      item({ url: "https://ex/horo", title: "Гороскоп на месяц" }), // blocklist would-drop
      item({ url: "https://ex/amb", title: "Расплывчатая новость" }), // llm score 0 would-drop
      item({ url: "https://ex/ai", title: "Anthropic выпустила модель" }), // fast-accept keep
    ];
    const { kept, decisions } = await filterRelevant(items, STORE, {
      classify,
      mode: RelevanceMode.Shadow,
    });

    // Shadow never actually drops: kept === all input.
    expect(kept).toHaveLength(items.length);
    expect(kept.map((i) => i.url)).toEqual(items.map((i) => i.url));
    // But the decision booleans still reflect what WOULD happen.
    const byUrl = new Map(decisions.map((d) => [d.url, d]));
    expect(byUrl.get("https://ex/horo")!.kept).toBe(false);
    expect(byUrl.get("https://ex/horo")!.stage).toBe(RelevanceStage.Blocklist);
    expect(byUrl.get("https://ex/amb")!.kept).toBe(false);
    expect(byUrl.get("https://ex/amb")!.stage).toBe(RelevanceStage.Llm);
    expect(byUrl.get("https://ex/ai")!.kept).toBe(true);
    expect(byUrl.get("https://ex/ai")!.stage).toBe(RelevanceStage.Accept);
  });
});

describe("filterRelevant — off mode", () => {
  it("returns input untouched and does no work (no decisions, no classify)", async () => {
    const classify = vi.fn();
    const items = [item({ url: "https://ex/horo", title: "Гороскоп на год" })];
    const { kept, decisions } = await filterRelevant(items, STORE, {
      classify,
      mode: RelevanceMode.Off,
    });

    expect(kept).toBe(items); // same reference — no work
    expect(decisions).toEqual([]);
    expect(classify).not.toHaveBeenCalled();
  });
});

describe("classifyRelevance — mock provider", () => {
  it("returns null (skip = keep) when the active provider is mock", async () => {
    const store = new CandidateStore(":memory:");
    store.setMockOverride(true); // resolveActiveProvider → mock
    const score = await classifyRelevance(item(), store);
    expect(score).toBeNull();
    store.close();
  });
});
