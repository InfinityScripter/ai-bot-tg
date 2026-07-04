import { it, vi, expect, describe, afterEach } from "vitest";

// Mock the Anthropic SDK: capture BOTH args of messages.create so we can assert
// the per-request options (timeout + maxRetries) the fix must pass.
const create = vi.fn();
vi.mock("@anthropic-ai/sdk", () => ({
  default: class {
    messages = { create };
  },
}));

const { CONFIG } = await import("../src/config.js");
const { ProviderName } = await import("../src/enums.js");
const { completeChatJson } = await import("../src/llm/chatCompletion.js");

import type { ChatJsonRequest } from "../src/llm/types.js";

/** A minimal chat request. */
const REQ: ChatJsonRequest = {
  system: "sys",
  user: "usr",
  maxTokens: 100,
  temperature: 0,
  refusalLabel: "test",
};

/** Wraps a string as a Claude message response with one text block. */
function textResponse(text: string) {
  return { stop_reason: "end_turn", content: [{ type: "text", text }] };
}

afterEach(() => {
  create.mockReset();
  vi.unstubAllGlobals();
});

describe("completeChatJson — Anthropic path timeout guard", () => {
  it("passes the configured timeout and maxRetries as request options", async () => {
    create.mockResolvedValueOnce(textResponse('{"ok":true}'));

    await completeChatJson(ProviderName.Anthropic, "claude-haiku-4-5", REQ);

    // messages.create is called as create(body, options). The fix must supply
    // the second options arg with the hard timeout + retry cap from CONFIG.
    const call = create.mock.calls[0] as [unknown, { timeout?: number; maxRetries?: number }];
    expect(call[1]).toBeDefined();
    expect(call[1].timeout).toBe(CONFIG.LLM_TIMEOUT_MS);
    expect(call[1].maxRetries).toBe(CONFIG.LLM_MAX_RETRIES);
  });
});

describe("completeChatJson — OpenAI-compat path timeout guard", () => {
  it("attaches an AbortSignal to the fetch so a stalled request can't hang forever", async () => {
    vi.stubEnv("GLM_API_KEY", "test-key");
    vi.resetModules();

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: '{"ok":true}' } }] }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const mod = await import("../src/llm/chatCompletion.js");
    await mod.completeChatJson(ProviderName.Glm, "glm-4.7-flash", REQ);

    const call = fetchMock.mock.calls[0] as [string, { signal?: AbortSignal }];
    expect(call[1].signal).toBeInstanceOf(AbortSignal);

    vi.unstubAllEnvs();
    vi.resetModules();
  });
});
