import { it, vi, expect, describe, afterEach } from "vitest";

const runCodex = vi.fn();
vi.mock("../src/llm/runCodex.js", () => ({
  runCodex: (...a: unknown[]) => runCodex(...a),
}));
const completeChatJson = vi.fn();
vi.mock("../src/llm/chatCompletion.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/llm/chatCompletion.js")>();
  return { ...actual, completeChatJson: (...a: unknown[]) => completeChatJson(...a) };
});

const { generateReply } = await import("../src/chatReply/generateReply.js");
const { CandidateStore } = await import("../src/store/index.js");

const allow = () => true;

afterEach(() => {
  runCodex.mockReset();
  completeChatJson.mockReset();
  vi.restoreAllMocks();
});

describe("generateReply", () => {
  it("edits a Codex draft once without touching the paid provider", async () => {
    runCodex
      .mockResolvedValueOnce('{"action":"reply","text":"Стоит отметить: проверила 3 теста."}')
      .mockResolvedValueOnce('{"action":"reply","text":"Проверила 3 теста."}');
    const reply = await generateReply(new CandidateStore(":memory:"), "sys", "user", allow);
    expect(reply).toEqual({ action: "reply", text: "Проверила 3 теста." });
    expect(runCodex).toHaveBeenCalledTimes(2);
    expect(completeChatJson).not.toHaveBeenCalled();
  });

  it("falls back to the active provider when Codex fails (quota, logout, timeout)", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    runCodex
      .mockRejectedValueOnce(new Error("codex exited 1: usage limit reached"))
      .mockResolvedValueOnce('{"action":"reply","text":"Проверила 3 теста."}');
    completeChatJson.mockResolvedValue(
      '{"action":"reply","text":"Стоит отметить: проверила 3 теста."}',
    );
    const take = vi.fn(() => true);
    const reply = await generateReply(new CandidateStore(":memory:"), "sys", "user", take);
    expect(reply).toEqual({ action: "reply", text: "Проверила 3 теста." });
    expect(runCodex).toHaveBeenCalledTimes(2);
    expect(completeChatJson).toHaveBeenCalledOnce();
    expect(take).toHaveBeenCalledOnce();
    const prompt = runCodex.mock.calls[1]?.[0] as string;
    expect(JSON.parse(prompt.slice(prompt.lastIndexOf("\n") + 1))).toEqual({
      text: "Стоит отметить: проверила 3 теста.",
    });
  });

  it("stays silent without spending a paid slot when the editor fails after a valid draft", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    runCodex
      .mockResolvedValueOnce('{"action":"reply","text":"Проверила 3 теста."}')
      .mockRejectedValueOnce(new Error("editor unavailable"));
    const take = vi.fn(() => true);
    const reply = await generateReply(new CandidateStore(":memory:"), "sys", "user", take);
    expect(reply).toBeNull();
    expect(runCodex).toHaveBeenCalledTimes(2);
    expect(take).not.toHaveBeenCalled();
    expect(completeChatJson).not.toHaveBeenCalled();
  });

  it("does not use the paid fallback when an editor result breaks the contract", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    runCodex
      .mockResolvedValueOnce('{"action":"reply","text":"Проверила 3 теста."}')
      .mockResolvedValueOnce('{"action":"silent","text":""}');
    const take = vi.fn(() => true);
    expect(await generateReply(new CandidateStore(":memory:"), "sys", "user", take)).toBeNull();
    expect(runCodex).toHaveBeenCalledTimes(2);
    expect(take).not.toHaveBeenCalled();
    expect(completeChatJson).not.toHaveBeenCalled();
  });

  it("does not retry the paid provider after its valid draft fails editing", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    runCodex
      .mockRejectedValueOnce(new Error("generation unavailable"))
      .mockRejectedValueOnce(new Error("editor unavailable"));
    completeChatJson.mockResolvedValue('{"action":"reply","text":"Проверила 3 теста."}');
    const take = vi.fn(() => true);
    expect(await generateReply(new CandidateStore(":memory:"), "sys", "user", take)).toBeNull();
    expect(runCodex).toHaveBeenCalledTimes(2);
    expect(take).toHaveBeenCalledOnce();
    expect(completeChatJson).toHaveBeenCalledOnce();
  });

  it("falls back when Codex replies with something that is not the contract", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    runCodex.mockResolvedValue("просто текст без JSON");
    completeChatJson.mockResolvedValue('{"action":"silent","text":""}');
    const reply = await generateReply(new CandidateStore(":memory:"), "sys", "user", allow);
    expect(reply).toEqual({ action: "silent", text: "" });
    expect(runCodex).toHaveBeenCalledOnce();
    expect(completeChatJson).toHaveBeenCalledOnce();
  });

  it.each([
    ["null", null, null],
    ["empty text", '{"action":"reply","text":""}', { action: "reply", text: "" }],
    ["invalid JSON", "not JSON", null],
  ])(
    "does not edit a paid draft that has no valid nonempty reply: %s",
    async (_label, output, expected) => {
      vi.spyOn(console, "warn").mockImplementation(() => {});
      runCodex.mockRejectedValueOnce(new Error("generation unavailable"));
      completeChatJson.mockResolvedValueOnce(output);
      expect(await generateReply(new CandidateStore(":memory:"), "sys", "user", allow)).toEqual(
        expected,
      );
      expect(runCodex).toHaveBeenCalledOnce();
      expect(completeChatJson).toHaveBeenCalledOnce();
    },
  );

  it("returns null when both fail, so nothing is posted into the chat", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    runCodex.mockRejectedValue(new Error("boom"));
    completeChatJson.mockRejectedValue(new Error("boom too"));
    expect(await generateReply(new CandidateStore(":memory:"), "sys", "user", allow)).toBeNull();
  });

  it("skips the paid fallback once its hourly cap is spent and stays silent", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    runCodex.mockRejectedValue(new Error("codex exited 1: usage limit reached"));
    const reply = await generateReply(new CandidateStore(":memory:"), "sys", "user", () => false);
    expect(reply).toBeNull();
    expect(completeChatJson).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("cap"));
  });

  it("does not spend a paid slot when Codex answers", async () => {
    runCodex.mockResolvedValue('{"action":"reply","text":"привет"}');
    const take = vi.fn(() => true);
    await generateReply(new CandidateStore(":memory:"), "sys", "user", take);
    expect(take).not.toHaveBeenCalled();
  });
});
