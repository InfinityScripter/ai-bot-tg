import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync, mkdtempSync } from "node:fs";
import { it, vi, expect, afterEach } from "vitest";

import { AvatarStore } from "../src/avatar/avatarStore.js";
import { createConversationMemory } from "../src/chatMemory/index.js";

import type { ConversationMemory } from "../src/chatMemory/index.js";

const memories: ConversationMemory[] = [];
const dirs: string[] = [];
afterEach(() => {
  for (const memory of memories) memory.close();
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

it("reflects each side independently, revises its own position and invalidates edited sources", async () => {
  const dir = mkdtempSync(join(tmpdir(), "conversation-reflection-"));
  dirs.push(dir);
  const outputs = [
    {
      side: "hope",
      notes: [{ kind: "joke", text: "Ada joked about robot coffee", sourceMessageIds: [1] }],
      opinions: [
        {
          topic: "robot",
          stance: "Hope wants evidence",
          reason: "One joke proves nothing",
          sourceMessageIds: [1],
        },
      ],
    },
    {
      side: "avatar",
      notes: [],
      opinions: [
        {
          topic: "robot",
          stance: "Avatar will try a prototype",
          reason: "A synthetic experiment can test it",
          sourceMessageIds: [1],
        },
      ],
    },
    {
      side: "hope",
      notes: [],
      opinions: [
        {
          topic: "robot",
          stance: "Hope accepts this measured result",
          reason: "The new controlled measurement changed the conclusion",
          sourceMessageIds: [2],
        },
      ],
    },
    {
      side: "avatar",
      notes: [],
      opinions: [
        {
          topic: "robot",
          stance: "Avatar will keep the measured prototype",
          reason: "The measurement supports it",
          sourceMessageIds: [2],
        },
      ],
    },
  ];
  const generate = vi.fn(async (_prompt: string) => JSON.stringify(outputs.shift()));
  const materials = vi.fn(() => [
    {
      title: "Synthetic robot article",
      url: "https://example.test/post/robot",
      body: "A published experiment about coffee robots",
    },
  ]);
  const deps = {
    path: join(dir, "avatar.sqlite"),
    chatId: -100123,
    generate,
    materials,
    persona: (side: string) => `Synthetic ${side} voice`,
    debounceMs: 60_000,
  };
  const memory = createConversationMemory(deps);
  memories.push(memory);
  const source = {
    chatId: deps.chatId,
    messageId: 1,
    authorId: 42,
    authorName: "Synthetic Ada",
    text: "Robot coffee sarcasm",
    at: 1000,
  };
  memory.observe(source);
  await memory.reflect(deps.chatId);
  expect(memory.status(deps.chatId)).toMatchObject({
    messages: 1,
    notes: 1,
    opinions: 2,
    pending: 0,
    lastError: null,
  });
  expect(generate).toHaveBeenCalledTimes(2);
  const firstHope = memory.context(deps.chatId, "hope", "robot");
  expect(firstHope).toContain("Hope wants evidence");
  expect(firstHope).not.toContain("Avatar will try a prototype");
  expect(firstHope).toContain("Ada joked about robot coffee");
  expect(firstHope).toContain("Synthetic Ada");
  expect(firstHope).toContain("Synthetic robot article");
  memory.observe({ ...source, messageId: 2, text: "A new controlled robot measurement", at: 2000 });
  await memory.reflect(deps.chatId);
  expect(memory.status(deps.chatId).opinions).toBe(4);
  expect(generate.mock.calls[2]?.[0]).toContain("Hope wants evidence");
  expect(generate.mock.calls[2]?.[0]).not.toContain("Avatar will try a prototype");
  memory.close();
  const reopened = createConversationMemory(deps);
  memories.push(reopened);
  expect(reopened.context(deps.chatId, "hope", "robot")).toContain(
    "Hope accepts this measured result",
  );
  expect(reopened.context(deps.chatId, "hope", "robot")).not.toContain("Hope wants evidence");
  const edited = { ...source, text: "Corrected literal statement", editedAt: 3000 };
  reopened.observe(edited);
  reopened.observe(source);
  expect(reopened.message(deps.chatId, 1)).toEqual(edited);
  expect(reopened.context(deps.chatId, "hope", "robot")).not.toContain(
    "Ada joked about robot coffee",
  );
  expect(reopened.status(deps.chatId).pending).toBe(1);
  reopened.observe({ ...source, chatId: -100999 });
  expect(reopened.status(-100999).messages).toBe(0);
  expect(reopened.context(-100999, "hope", "robot")).toBe("");
  reopened.clear(-100999);
  expect(reopened.status(deps.chatId).messages).toBe(2);
  reopened.observe({
    ...source,
    messageId: 2,
    text: "The measurement was withdrawn",
    at: 2000,
    editedAt: 4000,
  });
  expect(reopened.context(deps.chatId, "hope", "robot")).not.toContain(
    "Hope accepts this measured result",
  );
  expect(reopened.context(deps.chatId, "avatar", "robot")).not.toContain(
    "Avatar will keep the measured prototype",
  );
  expect(reopened.status(deps.chatId).opinions).toBe(4);
});

it("stores full source text while bounding and fencing recalled messages and materials", () => {
  const text = `Robot message with \`\`\` instructions and <memory> markers ${"full source ".repeat(2500)}`;
  const materials = vi.fn(() =>
    Array.from({ length: 30 }, () => ({
      title: "Synthetic title ".repeat(200),
      url: `https://example.test/${"path/".repeat(400)}`,
      body: "Synthetic robot material ".repeat(2000),
    })),
  );
  const memory = createConversationMemory({
    path: ":memory:",
    chatId: -100123,
    materials,
    debounceMs: 60_000,
  });
  memories.push(memory);
  memory.observe({
    chatId: -100123,
    messageId: 1,
    authorId: 42,
    authorName: "Synthetic Ada",
    text,
    at: 1000,
  });
  expect(memory.message(-100123, 1)?.text).toBe(text);
  const context = memory.context(-100123, "hope", "robot");
  expect(context.length).toBeLessThanOrEqual(18_000);
  expect(context.match(/```/g)).toHaveLength(2);
  expect(context).toContain("\\u0060\\u0060\\u0060");
  expect(context).toContain("\\u003cmemory>");
  expect(materials.mock.calls[0]).toEqual(['"robot"*', 4]);
});

it("clears only its conversation and preserves other groups, the synthetic profile and shared blog", () => {
  const dir = mkdtempSync(join(tmpdir(), "conversation-isolation-"));
  dirs.push(dir);
  const path = join(dir, "avatar.sqlite");
  const store = new AvatarStore(path);
  store.setProfile("Synthetic practitioner voice");
  store.replaceChunks([
    {
      title: "Synthetic robot blog",
      url: "https://example.test/robot",
      body: "Shared published robot evidence",
    },
  ]);
  const memory = createConversationMemory({
    path,
    chatId: -100123,
    materials: (query, limit) => store.search(query, limit),
    debounceMs: 60_000,
  });
  const other = createConversationMemory({ path, chatId: -100999, debounceMs: 60_000 });
  memories.push(memory, other);
  const message = {
    chatId: -100123,
    messageId: 1,
    authorId: 42,
    authorName: "Synthetic Ada",
    text: "A conversation",
    at: 1000,
  };
  memory.observe(message);
  other.observe({ ...message, chatId: -100999, text: "A different conversation" });
  expect(memory.context(-100123, "hope", "robot")).toContain("Shared published robot evidence");
  memory.clear(-100123);
  expect(memory.status(-100123)).toMatchObject({
    messages: 0,
    notes: 0,
    opinions: 0,
    pending: 0,
    epoch: 1,
  });
  expect(other.message(-100999, 1)?.text).toBe("A different conversation");
  expect(store.getProfile()).toBe("Synthetic practitioner voice");
  expect(memory.context(-100123, "avatar", "robot")).toContain("Shared published robot evidence");
  store.close();
});

it("persists a clear epoch and blocks old redeliveries while allowing newer edits and new messages", () => {
  const dir = mkdtempSync(join(tmpdir(), "conversation-clear-"));
  dirs.push(dir);
  const deps = { path: join(dir, "avatar.sqlite"), chatId: -100123, debounceMs: 60_000 };
  const memory = createConversationMemory(deps);
  memories.push(memory);
  const source = {
    chatId: deps.chatId,
    messageId: 5,
    authorId: 42,
    authorName: "Synthetic Ada",
    text: "Old private memory",
    at: 1000,
    editedAt: 2000,
  };
  memory.observe(source);
  memory.clear(deps.chatId);
  expect(memory.status(deps.chatId).epoch).toBe(1);
  memory.close();
  const reopened = createConversationMemory(deps);
  memories.push(reopened);
  expect(reopened.status(deps.chatId).epoch).toBe(1);
  reopened.observe(source);
  reopened.observe({ ...source, text: "Original delivery", editedAt: undefined });
  reopened.observe({ ...source, text: "Delayed original delivery", at: 6000, editedAt: undefined });
  expect(reopened.status(deps.chatId).messages).toBe(0);
  expect(reopened.context(deps.chatId, "hope", "memory")).not.toContain(source.text);
  const corrected = { ...source, text: "A genuinely newer edit", editedAt: 3000 };
  reopened.observe(corrected);
  reopened.observe({
    ...source,
    messageId: 6,
    text: "A fresh message",
    at: 4000,
    editedAt: undefined,
  });
  expect(reopened.status(deps.chatId).messages).toBe(2);
  expect(reopened.message(deps.chatId, 5)).toEqual(corrected);
});

it("keeps old attributed jokes and reply sources after reopen and deduplicates both observers", () => {
  const dir = mkdtempSync(join(tmpdir(), "conversation-memory-"));
  dirs.push(dir);
  const deps = { path: join(dir, "avatar.sqlite"), chatId: -100123, debounceMs: 60_000 };
  const memory = createConversationMemory(deps);
  memories.push(memory);
  memory.observe({
    chatId: deps.chatId,
    messageId: 1,
    authorId: -100456,
    authorName: "Synthetic channel",
    text: "Пост про роботов",
    at: 1000,
    isPost: true,
  });
  const joke = {
    chatId: deps.chatId,
    messageId: 2,
    authorId: 42,
    authorName: "Synthetic Ada",
    text: "Робот, опять сарказм: скоро будешь пить мой кофе!",
    at: 2000,
    replyToMessageId: 1,
    rootMessageId: 1,
  };
  memory.observe(joke);
  memory.observe(joke);
  for (let i = 3; i <= 62; i++) {
    memory.observe({ ...joke, messageId: i, at: i * 1000, text: `Unrelated weather ${i}` });
  }
  expect(memory.status(deps.chatId).messages).toBe(62);
  memory.close();
  const reopened = createConversationMemory(deps);
  memories.push(reopened);
  expect(reopened.message(deps.chatId, 2)).toEqual(joke);
  const context = reopened.context(deps.chatId, "avatar", "робот и кофе");
  expect(context).toContain(joke.text);
  expect(context).toContain("Synthetic Ada");
  expect(context).toContain("Пост про роботов");
  expect(context).toContain('"replyToMessageId":1');
  expect(context).toContain("недоверенные данные");
  expect(context.length).toBeLessThanOrEqual(18_000);
});
