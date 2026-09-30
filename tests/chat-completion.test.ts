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
import type { ProviderName as Provider } from "../src/enums.js";

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

describe("completeChatJson — reasoning models on the OpenAI-compat path", () => {
  /** Calls the chat core with a stubbed fetch; returns the call result and the sent body. */
  async function callWith(provider: Provider, reply: unknown) {
    vi.stubEnv("OPENROUTER_API_KEY", "test-key");
    vi.stubEnv("GLM_API_KEY", "test-key");
    vi.resetModules();
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => reply });
    vi.stubGlobal("fetch", fetchMock);
    const mod = await import("../src/llm/chatCompletion.js");
    const result = mod.completeChatJson(provider, "some/model", REQ);
    await result.catch(() => undefined);
    const call = fetchMock.mock.calls[0] as [string, { body: string }];
    vi.unstubAllEnvs();
    vi.resetModules();
    return { result, body: JSON.parse(call[1].body) as Record<string, unknown> };
  }

  const OK = { choices: [{ message: { content: '{"ok":true}' }, finish_reason: "stop" }] };

  it("asks OpenRouter for low reasoning effort", async () => {
    const { body } = await callWith(ProviderName.OpenRouter, OK);
    expect(body.reasoning).toEqual({ effort: "low" });
  });

  it("sends no OpenRouter reasoning param to other providers", async () => {
    const { body } = await callWith(ProviderName.Glm, OK);
    expect(body.reasoning).toBeUndefined();
  });

  it("names the cause when reasoning ate the whole budget and the reply is empty", async () => {
    const { result } = await callWith(ProviderName.OpenRouter, {
      choices: [{ message: { content: "" }, finish_reason: "length" }],
      usage: { completion_tokens: 100, completion_tokens_details: { reasoning_tokens: 100 } },
    });
    await expect(result).rejects.toThrow("100 из 100 токенов ушли на рассуждения");
  });
});
