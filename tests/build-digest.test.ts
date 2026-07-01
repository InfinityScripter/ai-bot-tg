import { it, vi, expect, describe, afterEach } from "vitest";

// Mock the Anthropic SDK: default export is a class with messages.create.
const create = vi.fn();
vi.mock("@anthropic-ai/sdk", () => ({
  default: class {
    messages = { create };
  },
}));

const { buildDigest } = await import("../src/llm/index.js");
import { ProviderName } from "../src/enums.js";
import { CandidateStore } from "../src/store/index.js";

import type { RecentPost } from "../src/blog/fetchRecentPosts.js";

// An in-memory store with no override → resolveActiveProvider uses the env
// default (anthropic in setup.ts unless a case stubs REWRITE_PROVIDER).
const STORE = new CandidateStore(":memory:");

const POSTS: RecentPost[] = [
  { id: "1", title: "GPT-5 вышла", description: "Крупный релиз OpenAI.", createdAt: "2026-06-30" },
  { id: "2", title: "Claude обновлён", description: "Новая версия Anthropic.", createdAt: "2026-06-29" },
];

const DIGEST = {
  subject: "AI-дайджест недели",
  html: "<h2>Привет</h2><ul><li>GPT-5</li></ul><p>{{ВЕРДИКТ}}</p>",
};

/** Wraps a string as a Claude message response with one text block. */
function textResponse(text: string, stopReason = "end_turn") {
  return { stop_reason: stopReason, content: [{ type: "text", text }] };
}

afterEach(() => {
  create.mockReset();
});

describe("buildDigest (Anthropic path)", () => {
  it("returns { subject, html } parsed from the model JSON", async () => {
    create.mockResolvedValueOnce(textResponse(JSON.stringify(DIGEST)));
    const result = await buildDigest(POSTS, STORE);
    expect(result).toEqual(DIGEST);
    expect(result.html).toContain("{{ВЕРДИКТ}}");
  });

  it("extracts JSON even with surrounding prose", async () => {
    create.mockResolvedValueOnce(textResponse(`Готово:\n${JSON.stringify(DIGEST)}\nВсё.`));
    const result = await buildDigest(POSTS, STORE);
    expect(result.subject).toBe("AI-дайджест недели");
  });

  it("throws on a refusal stop_reason", async () => {
    create.mockResolvedValueOnce(textResponse("", "refusal"));
    await expect(buildDigest(POSTS, STORE)).rejects.toThrow(/refusal/i);
  });

  it("throws when there is no JSON in the output", async () => {
    create.mockResolvedValueOnce(textResponse("no json here"));
    await expect(buildDigest(POSTS, STORE)).rejects.toThrow(/не вернул JSON/);
  });

  it("throws when the JSON is missing subject or html", async () => {
    create.mockResolvedValueOnce(textResponse(JSON.stringify({ subject: "only subject" })));
    await expect(buildDigest(POSTS, STORE)).rejects.toThrow(/валидаци/i);
  });
});

describe("buildDigest (mock provider)", () => {
  it("builds a digest from the posts with no LLM call, keeping the {{ВЕРДИКТ}} slot", async () => {
    vi.stubEnv("REWRITE_MOCK", "1");
    vi.resetModules();
    const mod = await import("../src/llm/index.js");
    const result = await mod.buildDigest(POSTS, STORE);

    expect(create).not.toHaveBeenCalled();
    expect(result.subject).toContain("2");
    expect(result.html).toContain("{{ВЕРДИКТ}}");
    expect(result.html).toContain("GPT-5 вышла");

    vi.unstubAllEnvs();
    vi.resetModules();
  });
});

describe("buildDigest (OpenAI-compatible path)", () => {
  it("calls the endpoint and returns the parsed digest", async () => {
    vi.stubEnv("REWRITE_PROVIDER", ProviderName.DeepSeek);
    vi.stubEnv("DEEPSEEK_API_KEY", "test-key");
    vi.resetModules();

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: JSON.stringify(DIGEST) } }] }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const mod = await import("../src/llm/index.js");
    const result = await mod.buildDigest(POSTS, STORE);

    expect(result).toEqual(DIGEST);
    const call = fetchMock.mock.calls[0] as [string, { headers: Record<string, string> }];
    expect(call[0]).toContain("api.deepseek.com");
    expect(call[1].headers.Authorization).toBe("Bearer test-key");

    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.resetModules();
  });
});
