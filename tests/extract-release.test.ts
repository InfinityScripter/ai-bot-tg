import { it, vi, expect, describe, afterEach } from "vitest";

// Mock the Anthropic SDK: default export is a class with messages.create.
const create = vi.fn();
vi.mock("@anthropic-ai/sdk", () => ({
  default: class {
    messages = { create };
  },
}));

const { extractRelease } = await import("../src/llm/index.js");
import { ProviderName } from "../src/enums.js";
import { CandidateStore } from "../src/store/index.js";

import type { FeedItem } from "../src/types.js";

// An in-memory store with no override → resolveActiveProvider uses the env
// default (anthropic in setup.ts unless a case stubs REWRITE_PROVIDER).
const STORE = new CandidateStore(":memory:");

const ITEM: FeedItem = {
  dedupKey: "k",
  url: "https://example.com/release",
  title: "OpenAI launches GPT-5",
  snippet: "OpenAI announced GPT-5 today.",
  feedTitle: "TechCrunch",
  imageUrl: null,
  imageUrls: [],
  publishedAt: null,
};

// A fully-specified release the model might return.
const FULL = {
  vendor: "OpenAI",
  model: "GPT",
  version: "5",
  releasedAt: "2026-06-01",
  sourceUrl: "https://model-said-this-url.example/ignored",
  contextTokens: 400000,
  priceIn: 1.25,
  priceOut: 10,
  changes: ["Longer context", "Cheaper output"],
  sourceName: "TechCrunch",
};

// A release where the source stated no price/context/date detail — the prompt
// requires those to be null (never guessed). This is the anti-hallucination case.
const NULLY = {
  vendor: "Anthropic",
  model: "Claude",
  version: "5 Sonnet",
  releasedAt: "2026-05-20",
  sourceUrl: "https://whatever.example/x",
  contextTokens: null,
  priceIn: null,
  priceOut: null,
  changes: [],
  sourceName: null,
};

/** Wraps a string as a Claude message response with one text block. */
function textResponse(text: string, stopReason = "end_turn") {
  return { stop_reason: stopReason, content: [{ type: "text", text }] };
}

afterEach(() => {
  create.mockReset();
});

describe("extractRelease (Anthropic path)", () => {
  it("parses a full release and forces the source URL to the feed item's url", async () => {
    create.mockResolvedValueOnce(textResponse(JSON.stringify(FULL)));
    const result = await extractRelease(ITEM, STORE);
    expect(result).toEqual({ ...FULL, sourceUrl: ITEM.url });
    // The model-provided sourceUrl must be overridden with the canonical one.
    expect(result.sourceUrl).toBe("https://example.com/release");
  });

  it("keeps null prices/context/date as null (anti-hallucination)", async () => {
    create.mockResolvedValueOnce(textResponse(JSON.stringify(NULLY)));
    const result = await extractRelease(ITEM, STORE);
    expect(result.priceIn).toBeNull();
    expect(result.priceOut).toBeNull();
    expect(result.contextTokens).toBeNull();
    expect(result.sourceName).toBeNull();
    expect(result.changes).toEqual([]);
  });

  it("defaults changes to [] when the field is absent from the output", async () => {
    const { changes: _changes, ...noChanges } = NULLY;
    create.mockResolvedValueOnce(textResponse(JSON.stringify(noChanges)));
    const result = await extractRelease(ITEM, STORE);
    expect(result.changes).toEqual([]);
  });

  it("extracts JSON even with surrounding prose", async () => {
    create.mockResolvedValueOnce(textResponse(`Here it is:\n${JSON.stringify(NULLY)}\nDone.`));
    const result = await extractRelease(ITEM, STORE);
    expect(result.vendor).toBe("Anthropic");
  });

  it("throws on a refusal stop_reason", async () => {
    create.mockResolvedValueOnce(textResponse("", "refusal"));
    await expect(extractRelease(ITEM, STORE)).rejects.toThrow(/refusal/i);
  });

  it("throws when there is no JSON in the output", async () => {
    create.mockResolvedValueOnce(textResponse("no json here"));
    await expect(extractRelease(ITEM, STORE)).rejects.toThrow(/не вернул JSON/);
  });

  it("throws when JSON fails schema validation (missing required vendor)", async () => {
    create.mockResolvedValueOnce(textResponse(JSON.stringify({ model: "GPT", version: "5" })));
    await expect(extractRelease(ITEM, STORE)).rejects.toThrow(/валидаци/i);
  });
});

// The OpenAI-compatible path shares one code seam; assert a fake fetch is used
// and the null-price contract holds there too.
describe("extractRelease (OpenAI-compatible path)", () => {
  it("calls the endpoint and validates output, preserving null fields", async () => {
    vi.stubEnv("REWRITE_PROVIDER", ProviderName.DeepSeek);
    vi.stubEnv("DEEPSEEK_API_KEY", "test-key");
    vi.resetModules();

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: JSON.stringify(NULLY) } }] }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const mod = await import("../src/llm/index.js");
    const result = await mod.extractRelease(ITEM, STORE);

    expect(result).toEqual({ ...NULLY, sourceUrl: ITEM.url });
    const call = fetchMock.mock.calls[0] as [string, { headers: Record<string, string> }];
    expect(call[0]).toContain("api.deepseek.com");
    expect(call[1].headers.Authorization).toBe("Bearer test-key");

    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("throws a readable, labeled error on a non-OK response", async () => {
    vi.stubEnv("REWRITE_PROVIDER", ProviderName.DeepSeek);
    vi.stubEnv("DEEPSEEK_API_KEY", "test-key");
    vi.resetModules();

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 429, text: async () => "rate limited" }),
    );

    const mod = await import("../src/llm/index.js");
    await expect(mod.extractRelease(ITEM, STORE)).rejects.toThrow(/DeepSeek ответил 429/);

    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.resetModules();
  });
});

describe("extractRelease (mock provider)", () => {
  it("builds a release with all-null prices from the feed item, no LLM call", async () => {
    vi.stubEnv("REWRITE_MOCK", "1");
    vi.resetModules();
    const mod = await import("../src/llm/index.js");
    const result = await mod.extractRelease(ITEM, STORE);

    expect(create).not.toHaveBeenCalled();
    expect(result.priceIn).toBeNull();
    expect(result.priceOut).toBeNull();
    expect(result.contextTokens).toBeNull();
    expect(result.sourceUrl).toBe(ITEM.url);

    vi.unstubAllEnvs();
    vi.resetModules();
  });
});
