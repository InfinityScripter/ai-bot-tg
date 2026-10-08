import { it, vi, expect, describe, afterEach } from "vitest";

const runCodex = vi.fn();
vi.mock("../src/llm/runCodex.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/llm/runCodex.js")>()),
  runCodex: (...a: unknown[]) => runCodex(...a),
}));

const { CONFIG } = await import("../src/config.js");
const { ProviderKind, ProviderName } = await import("../src/enums.js");
const { PROVIDERS } = await import("../src/llm/providers.js");
const { listModels, pingModel } = await import("../src/llm/modelRegistry.js");
const { completeChatJson } = await import("../src/llm/chatCompletion.js");

afterEach(() => {
  runCodex.mockReset();
  vi.unstubAllGlobals();
});

describe("Codex provider in /model", () => {
  it("is a CLI provider on the group responder's model, never marked 🔑", () => {
    const spec = PROVIDERS[ProviderName.Codex];
    expect(spec.kind).toBe(ProviderKind.CodexCli);
    expect(spec.defaultModel).toBe(CONFIG.CHAT_REPLY_MODEL);
    expect(spec.fallbackModels).toEqual([CONFIG.CHAT_REPLY_MODEL]);
    expect(spec.apiKey()).toBeTruthy();
  });

  it("completeChatJson sends system + user through codex on the chosen model", async () => {
    runCodex.mockResolvedValueOnce('Готово: {"title":"T"}');
    const json = await completeChatJson(ProviderName.Codex, "gpt-6-luna", {
      system: "SYS",
      user: "USR",
      maxTokens: 10,
      refusalLabel: "x",
    });
    expect(json).toBe('{"title":"T"}');
    expect(runCodex).toHaveBeenCalledWith("SYS\n\nUSR", { model: "gpt-6-luna" });
  });

  it("ping passes when codex answers and carries its error otherwise", async () => {
    runCodex.mockResolvedValueOnce("ok");
    await expect(pingModel(ProviderName.Codex, "m")).resolves.toEqual({ ok: true });
    expect(runCodex).toHaveBeenCalledWith(expect.any(String), { model: "m" });
    runCodex.mockRejectedValueOnce(new Error("codex exited 1: 401 Unauthorized"));
    await expect(pingModel(ProviderName.Codex, "m")).resolves.toEqual({
      ok: false,
      error: "codex exited 1: 401 Unauthorized",
    });
  });

  it("lists the static model list without any HTTP call", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    await expect(listModels(ProviderName.Codex)).resolves.toEqual([CONFIG.CHAT_REPLY_MODEL]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
