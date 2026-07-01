import { it, vi, expect, describe, afterEach } from "vitest";

// Mock the Anthropic SDK: default export is a class with messages.create.
const create = vi.fn();
vi.mock("@anthropic-ai/sdk", () => ({
  default: class {
    messages = { create };
  },
}));

const { rewriteToPost } = await import("../src/llm/index.js");
import { ProviderName } from "../src/enums.js";
import { CandidateStore } from "../src/store/index.js";

import type { FeedItem } from "../src/types.js";

// An in-memory store with no override → resolveActiveProvider uses the env
// default (anthropic in setup.ts unless a case stubs REWRITE_PROVIDER).
const STORE = new CandidateStore(":memory:");

const ITEM: FeedItem = {
  dedupKey: "k",
  url: "https://example.com/a",
  title: "Source headline",
  snippet: "Source snippet",
  feedTitle: "Feed",
  imageUrl: null,
  imageUrls: [],
  publishedAt: null,
};

const VALID = {
  title: "Rewritten",
  description: "Summary",
  content: "Body",
  tags: ["технологии"],
  metaTitle: "M",
  metaDescription: "MD",
};

// After normalizeTags: 'новости' is force-added first, whitelisted tags kept.
// finalizeRewrite also self-heals the source line onto the LLM-path content, so
// the expected body is "Body" + the canonical `Источник:` line for ITEM.
const VALID_NORMALIZED = {
  ...VALID,
  tags: ["новости", "технологии"],
  content: `Body\n\nИсточник: [${ITEM.feedTitle}](${ITEM.url})`,
};

/** Wraps a string as a Claude message response with one text block. */
function textResponse(text: string, stopReason = "end_turn") {
  return { stop_reason: stopReason, content: [{ type: "text", text }] };
}

afterEach(() => {
  create.mockReset();
});

describe("rewriteToPost", () => {
  it("returns the validated object with normalized tags from clean JSON output", async () => {
    create.mockResolvedValueOnce(textResponse(JSON.stringify(VALID)));
    expect(await rewriteToPost(ITEM, STORE)).toEqual(VALID_NORMALIZED);
  });

  it("extracts JSON even with surrounding prose", async () => {
    create.mockResolvedValueOnce(textResponse(`Вот пост:\n${JSON.stringify(VALID)}\nГотово.`));
    expect(await rewriteToPost(ITEM, STORE)).toEqual(VALID_NORMALIZED);
  });

  it("drops junk tags and always puts новости first", async () => {
    create.mockResolvedValueOnce(
      textResponse(JSON.stringify({ ...VALID, tags: ["junk", "ии", "наука"] })),
    );
    const result = await rewriteToPost(ITEM, STORE);
    // 'junk' dropped, 'ии' → 'ai', 'наука' kept, 'новости' forced first.
    expect(result.tags).toEqual(["новости", "ai", "наука"]);
  });

  it("throws on a refusal stop_reason", async () => {
    create.mockResolvedValueOnce(textResponse("", "refusal"));
    await expect(rewriteToPost(ITEM, STORE)).rejects.toThrow(/refusal/i);
  });

  it("throws when there is no JSON in the output", async () => {
    create.mockResolvedValueOnce(textResponse("no json here"));
    await expect(rewriteToPost(ITEM, STORE)).rejects.toThrow(/не вернул JSON/);
  });

  it("throws when JSON is present but fails schema validation", async () => {
    create.mockResolvedValueOnce(textResponse(JSON.stringify({ title: "only title" })));
    await expect(rewriteToPost(ITEM, STORE)).rejects.toThrow(/валидаци/i);
  });

  it("clamps an over-long Claude title to keep the heading readable", async () => {
    const longTitle = "А".repeat(250);
    create.mockResolvedValueOnce(textResponse(JSON.stringify({ ...VALID, title: longTitle })));
    const result = await rewriteToPost(ITEM, STORE);
    expect(result.title.length).toBeLessThanOrEqual(101); // 100 + ellipsis
  });

  it("keeps only allow-listed body images and strips invented/cover ones", async () => {
    const richItem: FeedItem = {
      ...ITEM,
      imageUrl: "https://cdn/cover.jpg",
      // cover at [0] is NOT allowed in the body; only in1/in2 are
      imageUrls: ["https://cdn/cover.jpg", "https://cdn/in1.png", "https://cdn/in2.png"],
    };
    const body = [
      "Текст.",
      "![](https://cdn/in1.png)", // allowed → kept
      "Ещё текст.",
      "![](https://cdn/cover.jpg)", // cover → stripped (not in allow-list)
      "![](https://evil/fake.png)", // invented → stripped
    ].join("\n\n");
    create.mockResolvedValueOnce(textResponse(JSON.stringify({ ...VALID, content: body })));

    const result = await rewriteToPost(richItem, STORE);
    expect(result.content).toContain("![](https://cdn/in1.png)");
    expect(result.content).not.toContain("cover.jpg");
    expect(result.content).not.toContain("evil/fake.png");
  });
});

// All OpenAI-compatible providers share one code path; assert each maps to the
// right base URL + key env, and that a non-OK response surfaces its label.
const OPENAI_COMPAT = [
  {
    provider: ProviderName.Gemini,
    keyEnv: "GEMINI_API_KEY",
    host: "generativelanguage.googleapis.com",
    label: "Gemini",
  },
  { provider: ProviderName.Glm, keyEnv: "GLM_API_KEY", host: "api.z.ai", label: "GLM" },
  {
    provider: ProviderName.DeepSeek,
    keyEnv: "DEEPSEEK_API_KEY",
    host: "api.deepseek.com",
    label: "DeepSeek",
  },
] as const;

describe.each(OPENAI_COMPAT)(
  "rewriteToPost ($provider provider)",
  ({ provider, keyEnv, host, label }) => {
    it("calls the right OpenAI-compatible endpoint and validates output", async () => {
      vi.stubEnv("REWRITE_PROVIDER", provider);
      vi.stubEnv(keyEnv, "test-key");
      vi.resetModules();

      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ choices: [{ message: { content: JSON.stringify(VALID) } }] }),
      });
      vi.stubGlobal("fetch", fetchMock);

      const mod = await import("../src/llm/index.js");
      const result = await mod.rewriteToPost(ITEM, STORE);

      // tags are normalized on the OpenAI-compat path too (finalizeRewrite runs
      // for every provider), so 'новости' is force-added first.
      expect(result).toEqual(VALID_NORMALIZED);
      const call = fetchMock.mock.calls[0] as [string, { headers: Record<string, string> }];
      expect(call[0]).toContain(host);
      expect(call[1].headers.Authorization).toBe("Bearer test-key");

      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
      vi.resetModules();
    });

    it("passes the configured temperature and max_tokens to the provider call", async () => {
      vi.stubEnv("REWRITE_PROVIDER", provider);
      vi.stubEnv(keyEnv, "test-key");
      vi.resetModules();

      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ choices: [{ message: { content: JSON.stringify(VALID) } }] }),
      });
      vi.stubGlobal("fetch", fetchMock);

      const cfgMod = await import("../src/config.js");
      const mod = await import("../src/llm/index.js");
      await mod.rewriteToPost(ITEM, STORE);

      const call = fetchMock.mock.calls[0] as [string, { body: string }];
      const sent = JSON.parse(call[1].body) as { temperature: number; max_tokens: number };
      expect(sent.temperature).toBe(cfgMod.CONFIG.REWRITE_TEMPERATURE);
      expect(sent.max_tokens).toBe(cfgMod.CONFIG.REWRITE_MAX_TOKENS);

      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
      vi.resetModules();
    });

    it("throws a readable, labeled error on a non-OK response", async () => {
      vi.stubEnv("REWRITE_PROVIDER", provider);
      vi.stubEnv(keyEnv, "test-key");
      vi.resetModules();

      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({ ok: false, status: 429, text: async () => "rate limited" }),
      );

      const mod = await import("../src/llm/index.js");
      await expect(mod.rewriteToPost(ITEM, STORE)).rejects.toThrow(
        new RegExp(`${label} ответил 429`),
      );

      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
      vi.resetModules();
    });
  },
);

describe("rewriteToPost (store override)", () => {
  it("a stored override switches the provider at call time", async () => {
    // env default is anthropic (setup.ts), but the override points at glm.
    vi.stubEnv("GLM_API_KEY", "glm-key");
    vi.resetModules();

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: JSON.stringify(VALID) } }] }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const storeMod = await import("../src/store/index.js");
    const store = new storeMod.CandidateStore(":memory:");
    store.setModelOverride(ProviderName.Glm, "glm-4.7-flash");

    const mod = await import("../src/llm/index.js");
    const result = await mod.rewriteToPost(ITEM, store);

    // normalized tags here too (override → glm → openai-compat → finalizeRewrite).
    expect(result).toEqual(VALID_NORMALIZED);
    const call = fetchMock.mock.calls[0] as [string, { body: string }];
    expect(call[0]).toContain("api.z.ai");
    expect(JSON.parse(call[1].body).model).toBe("glm-4.7-flash");

    store.close();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.resetModules();
  });
});

describe("rewriteToPost (REWRITE_MOCK)", () => {
  it("mock body does not start with a markdown heading and clamps the title", async () => {
    vi.stubEnv("REWRITE_MOCK", "1");
    vi.resetModules();
    const mod = await import("../src/llm/index.js");
    const longTitleItem = { ...ITEM, title: "Б".repeat(250), snippet: "Тело новости." };

    const result = await mod.rewriteToPost(longTitleItem, STORE);

    expect(result.content.startsWith("#")).toBe(false); // no "## title" duplicate
    expect(result.content).toContain("Тело новости.");
    expect(result.title.length).toBeLessThanOrEqual(101);

    vi.unstubAllEnvs();
    vi.resetModules();
  });
});
