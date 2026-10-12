import { it, vi, expect, afterEach } from "vitest";

import { createConversationMemory } from "../src/chatMemory/index.js";

import type { ConversationMemory } from "../src/chatMemory/index.js";

vi.mock("dotenv/config", () => ({}));

const memories: ConversationMemory[] = [];
afterEach(() => {
  for (const memory of memories.splice(0)) memory.close();
});

it("recalls a late material beyond an early contents mention without losing source identity", () => {
  const memory = createConversationMemory({
    path: ":memory:",
    chatId: -100123,
    debounceMs: 60_000,
  });
  memories.push(memory);
  const text = [
    "Исправленные затраты. Выпуск: кварцевые агенты и маршрутизатор.",
    "Сведения о маршрутизаторе. ".repeat(160),
    "Кварцевые агенты",
    "Кварцевые агенты откатывают действия: ZETA_FINISH_481.",
    "Исходный пост: https://t.me/devfm/678",
    "Материал: https://example.test/quartz",
  ].join("\n");
  const source = {
    chatId: -100123,
    messageId: 10,
    authorId: -100555,
    authorName: "Synthetic channel",
    text,
    at: 10_000,
    editedAt: 20_000,
    isPost: true,
    rootMessageId: 10,
  };
  memory.observe(source);
  for (const side of ["hope", "avatar"] as const) {
    const context = memory.context(-100123, side, "Что было про кварцевые агенты в выпуске?");
    expect(context).toContain("ZETA_FINISH_481");
    expect(context).toContain("https://t.me/devfm/678");
    expect(context).toContain("https://example.test/quartz");
    expect(context).toContain("Исправленные затраты");
    expect(context).toContain('"authorId":-100555');
    expect(context).toContain('"rootMessageId":10');
    const data = JSON.parse(context.split("```json\n")[1]!.split("\n```")[0]!) as {
      messages: { text: string }[];
    };
    expect(data.messages[0]?.text.length).toBeLessThanOrEqual(900);
    expect(context.length).toBeLessThanOrEqual(18_000);
  }
  expect(memory.message(-100123, 10)).toEqual(source);
  expect(memory.context(-100123, "hope", "Unknown subject")).not.toContain("ZETA_FINISH_481");
  memory.clear(-100123);
  expect(memory.context(-100123, "hope", "Кварцевые агенты")).not.toContain("ZETA_FINISH_481");
});

it("recalls the matching portion of a long material under the existing source and total budgets", () => {
  const memory = createConversationMemory({
    path: ":memory:",
    chatId: -100123,
    debounceMs: 60_000,
    materials: () => [
      {
        title: "Synthetic article",
        url: "https://example.test/quartz",
        body: `${"Маршрутизатор и измерения. ".repeat(120)}\nКварцевые агенты: ZETA_FINISH_481.`,
      },
    ],
  });
  memories.push(memory);
  const context = memory.context(-100123, "hope", "Кварцевые агенты");
  expect(context).toContain("ZETA_FINISH_481");
  expect(context).toContain("https://example.test/quartz");
  const data = JSON.parse(context.split("```json\n")[1]!.split("\n```")[0]!) as {
    materials: { body: string }[];
  };
  expect(data.materials[0]?.body.length).toBeLessThanOrEqual(900);
  expect(context.length).toBeLessThanOrEqual(18_000);
});
