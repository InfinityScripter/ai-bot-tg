import { it, vi, expect, describe, afterEach } from "vitest";

const runCodex = vi.fn();
vi.mock("../src/chatReply/runCodex.js", () => ({
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
  it("uses the Codex reply and never touches the paid provider when Codex answers", async () => {
    runCodex.mockResolvedValue('{"action":"reply","text":"привет"}');
    const reply = await generateReply(new CandidateStore(":memory:"), "sys", "user", allow);
    expect(reply).toEqual({ action: "reply", text: "привет" });
    expect(completeChatJson).not.toHaveBeenCalled();
  });

  it("falls back to the active provider when Codex fails (quota, logout, timeout)", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    runCodex.mockRejectedValue(new Error("codex exited 1: usage limit reached"));
    completeChatJson.mockResolvedValue('{"action":"reply","text":"запасной ответ"}');
    const reply = await generateReply(new CandidateStore(":memory:"), "sys", "user", allow);
    expect(reply).toEqual({ action: "reply", text: "запасной ответ" });
    expect(completeChatJson).toHaveBeenCalledOnce();
  });

  it("falls back when Codex replies with something that is not the contract", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    runCodex.mockResolvedValue("просто текст без JSON");
    completeChatJson.mockResolvedValue('{"action":"silent","text":""}');
    const reply = await generateReply(new CandidateStore(":memory:"), "sys", "user", allow);
    expect(reply).toEqual({ action: "silent", text: "" });
  });

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
