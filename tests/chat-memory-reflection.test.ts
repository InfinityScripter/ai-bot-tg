import { it, vi, expect, afterEach } from "vitest";

import { runCodex } from "../src/llm/runCodex.js";
import { createConversationMemory } from "../src/chatMemory/index.js";

import type { ConversationMemory } from "../src/chatMemory/index.js";

const memories: ConversationMemory[] = [];
vi.mock("../src/llm/runCodex.js", () => ({ runCodex: vi.fn() }));
afterEach(() => {
  for (const memory of memories) memory.close();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.mocked(runCodex).mockReset();
});

it("keeps prior conclusions and backlog on invalid JSON, sides, references or partial results", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  const generate = vi.fn(
    async (prompt: string): Promise<string | null> =>
      JSON.stringify({
        side: prompt.includes("отдельно для стороны hope") ? "hope" : "avatar",
        notes: [],
        opinions: [],
      }),
  );
  generate.mockResolvedValueOnce(
    JSON.stringify({
      side: "hope",
      notes: [{ kind: "participant", text: "Ada proposed a budget", sourceMessageIds: [1] }],
      opinions: [
        {
          topic: "robot",
          stance: "Hope needs measured evidence",
          reason: "Ada's proposal is an opinion",
          sourceMessageIds: [1],
        },
      ],
    }),
  );
  generate.mockResolvedValueOnce(
    JSON.stringify({
      side: "avatar",
      notes: [],
      opinions: [
        {
          topic: "robot",
          stance: "Avatar proposes an experiment",
          reason: "Test the proposal",
          sourceMessageIds: [1],
        },
      ],
    }),
  );
  const memory = createConversationMemory({
    path: ":memory:",
    chatId: source.chatId,
    generate,
    debounceMs: 60_000,
  });
  memories.push(memory);
  memory.observe(source);
  await memory.reflect(source.chatId);
  memory.observe({ ...source, messageId: 2, text: "A new argument", at: 2000 });
  const invalidResults = [
    "private raw model output, not JSON",
    null,
    JSON.stringify({ side: "avatar", notes: [], opinions: [] }),
    JSON.stringify({
      side: "hope",
      notes: [{ kind: "joke", text: "Unknown source", sourceMessageIds: [999] }],
      opinions: [],
    }),
    JSON.stringify({
      side: "hope",
      notes: [{ kind: "joke", text: "Fractional source", sourceMessageIds: [1.5] }],
      opinions: [],
    }),
    JSON.stringify({ side: "hope", notes: [], opinions: [], command: "private command" }),
  ];
  for (const result of invalidResults) {
    generate.mockResolvedValueOnce(result);
    await memory.reflect(source.chatId);
    expect(memory.status(source.chatId)).toMatchObject({
      messages: 2,
      notes: 1,
      opinions: 2,
      pending: 1,
    });
    expect(memory.status(source.chatId).lastError).toContain("Codex");
    expect(memory.context(source.chatId, "avatar", "robot")).toContain(
      "Avatar proposes an experiment",
    );
  }
  generate.mockResolvedValueOnce(
    JSON.stringify({
      side: "hope",
      notes: [{ kind: "discussion", text: "An uncommitted interpretation", sourceMessageIds: [2] }],
      opinions: [],
    }),
  );
  generate.mockResolvedValueOnce("invalid second side");
  await memory.reflect(source.chatId);
  expect(memory.status(source.chatId).notes).toBe(1);
  generate.mockRejectedValueOnce(new Error("private profile and chat text"));
  await memory.reflect(source.chatId);
  expect(JSON.stringify(warn.mock.calls)).not.toMatch(/private|model output|profile|command/);
  expect(memory.status(source.chatId).lastError).not.toContain("private");
  await memory.reflect(source.chatId);
  expect(memory.status(source.chatId)).toMatchObject({
    notes: 1,
    opinions: 2,
    pending: 0,
    lastError: null,
  });
});

it("uses only the existing tool-less Codex runner and processes a bounded batch", async () => {
  vi.mocked(runCodex)
    .mockResolvedValueOnce(JSON.stringify({ side: "hope", notes: [], opinions: [] }))
    .mockResolvedValueOnce(JSON.stringify({ side: "avatar", notes: [], opinions: [] }));
  const memory = createConversationMemory({
    path: ":memory:",
    chatId: source.chatId,
    persona: (side) => `Synthetic ${side} voice`,
    debounceMs: 60_000,
  });
  memories.push(memory);
  for (let i = 1; i <= 60; i++) memory.observe({ ...source, messageId: i, at: i * 1000 });
  await memory.reflect(source.chatId);
  expect(runCodex).toHaveBeenCalledTimes(2);
  expect(memory.status(source.chatId).pending).toBeGreaterThan(0);
  expect(memory.status(source.chatId).pending).toBeLessThan(60);
  const [hopePrompt, options] = vi.mocked(runCodex).mock.calls[0]!;
  expect(hopePrompt).toContain("Synthetic hope voice");
  expect(hopePrompt).not.toContain("Synthetic avatar voice");
  expect(hopePrompt).toContain("недоверенные данные");
  expect(hopePrompt).toContain('"batchMessageIds":[1,2,3');
  expect(options?.schema).toMatchObject({
    type: "object",
    required: ["side", "notes", "opinions"],
    additionalProperties: false,
  });
  memory.observe(source);
  expect(memory.status(source.chatId).messages).toBe(60);
});

it("debounces duplicate observations and caps automatic retries without exposing failed input", async () => {
  vi.useFakeTimers();
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  const generate = vi.fn(async () => {
    throw new Error("private message text");
  });
  const memory = createConversationMemory({
    path: ":memory:",
    chatId: source.chatId,
    generate,
    debounceMs: 10,
  });
  memories.push(memory);
  memory.observe(source);
  memory.observe(source);
  expect(generate).not.toHaveBeenCalled();
  expect(memory.message(source.chatId, source.messageId)).toEqual(source);
  await vi.advanceTimersByTimeAsync(20_000);
  expect(generate).toHaveBeenCalledTimes(3);
  memory.observe(source);
  await vi.advanceTimersByTimeAsync(20_000);
  expect(generate).toHaveBeenCalledTimes(3);
  memory.observe({ ...source, messageId: 2, at: 2000 });
  await vi.advanceTimersByTimeAsync(10);
  expect(generate).toHaveBeenCalledTimes(4);
  expect(memory.status(source.chatId)).toMatchObject({ messages: 2, pending: 2 });
});

it("invalidates an in-flight clear result and bounds shutdown before a stalled model completes", async () => {
  vi.useFakeTimers();
  let release: (value: string) => void = () => undefined;
  const generate = vi.fn(
    () =>
      new Promise<string>((resolve) => {
        release = resolve;
      }),
  );
  const memory = createConversationMemory({
    path: ":memory:",
    chatId: source.chatId,
    generate,
    debounceMs: 60_000,
  });
  memories.push(memory);
  memory.observe(source);
  const first = memory.reflect(source.chatId);
  memory.clear(source.chatId);
  release(
    JSON.stringify({
      side: "hope",
      notes: [{ kind: "joke", text: "Cleared interpretation", sourceMessageIds: [1] }],
      opinions: [],
    }),
  );
  await first;
  expect(generate).toHaveBeenCalledTimes(1);
  expect(memory.status(source.chatId)).toMatchObject({
    epoch: 1,
    messages: 0,
    notes: 0,
    opinions: 0,
    lastError: null,
  });
  memory.observe({ ...source, messageId: 2, at: 2000 });
  const second = memory.reflect(source.chatId);
  const draining = memory.drain();
  await vi.advanceTimersByTimeAsync(2000);
  await draining;
  memory.observe({ ...source, messageId: 3, at: 3000 });
  expect(memory.status(source.chatId).messages).toBe(1);
  memory.close();
  release(
    JSON.stringify({
      side: "hope",
      notes: [{ kind: "discussion", text: "Closed interpretation", sourceMessageIds: [2] }],
      opinions: [],
    }),
  );
  await second;
  expect(generate).toHaveBeenCalledTimes(2);
  expect(memory.message(source.chatId, 2)).toBeNull();
});

const source = {
  chatId: -100123,
  messageId: 1,
  authorId: 42,
  authorName: "Synthetic Ada",
  text: "An old robot joke",
  at: 1000,
};

it("exposes a terminal epoch to pending callers after closing", () => {
  const memory = createConversationMemory({ path: ":memory:", chatId: source.chatId });
  memories.push(memory);
  const { epoch } = memory.status(source.chatId);
  expect(epoch).toBe(0);
  memory.close();
  expect(memory.status(source.chatId).epoch).not.toBe(epoch);
  expect(memory.status(source.chatId)).toMatchObject({
    messages: 0,
    notes: 0,
    opinions: 0,
    pending: 0,
  });
});

it("rejects results calculated from a source edited during reflection", async () => {
  let release: (value: string) => void = () => undefined;
  const generate = vi.fn((prompt: string) => {
    if (prompt.includes("отдельно для стороны hope"))
      return new Promise<string>((resolve) => {
        release = resolve;
      });
    return Promise.resolve(JSON.stringify({ side: "avatar", notes: [], opinions: [] }));
  });
  const memory = createConversationMemory({
    path: ":memory:",
    chatId: source.chatId,
    generate,
    debounceMs: 60_000,
  });
  memories.push(memory);
  memory.observe(source);
  const pending = memory.reflect(source.chatId);
  memory.observe({ ...source, text: "Corrected literal statement", editedAt: 2000 });
  release(
    JSON.stringify({
      side: "hope",
      notes: [{ kind: "joke", text: "A stale interpretation", sourceMessageIds: [1] }],
      opinions: [],
    }),
  );
  await pending;
  expect(memory.status(source.chatId)).toMatchObject({ notes: 0, opinions: 0, pending: 1 });
  expect(memory.context(source.chatId, "hope", "robot")).not.toContain("A stale interpretation");
});
