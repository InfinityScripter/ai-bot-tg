import { it, expect, afterEach } from "vitest";

import { EnvSchema } from "../src/schemas/envSchema.js";
import { createSharedMemory } from "../src/chatMemory/createSharedMemory.js";

import type { ConversationMemory } from "../src/chatMemory/index.js";

const FIRST = -1001111111111;
const SECOND = -1002222222222;
const memories: ConversationMemory[] = [];
afterEach(() => {
  for (const memory of memories.splice(0)) memory.close();
});

it.each([
  ["one id", String(FIRST), [FIRST]],
  ["a comma-separated list", ` ${FIRST}, ${SECOND} ,`, [FIRST, SECOND]],
  ["a repeated id", `${FIRST},${FIRST}`, [FIRST]],
  ["an empty value", "", []],
  ["no value", undefined, []],
])("reads CHAT_REPLY_CHAT_ID from %s", (_label, value, expected) => {
  const parsed = EnvSchema.parse({ ...process.env, CHAT_REPLY_CHAT_ID: value });
  expect(parsed.CHAT_REPLY_CHAT_ID).toEqual(expected);
});

it("rejects a chat id that is not a number", () => {
  expect(EnvSchema.safeParse({ ...process.env, CHAT_REPLY_CHAT_ID: "-100, чат" }).success).toBe(
    false,
  );
});

it("keeps messages per group but lends conclusions to the other groups", async () => {
  const memory = createSharedMemory(
    {
      path: ":memory:",
      debounceMs: 60_000,
      generate: async (prompt) =>
        JSON.stringify({
          side: prompt.includes("отдельно для стороны hope") ? "hope" : "avatar",
          notes: [
            { kind: "participant", text: "Аня собирает бюджет на робота", sourceMessageIds: [7] },
          ],
          opinions: [],
        }),
    },
    [FIRST, SECOND],
  );
  memories.push(memory);
  memory.observe({
    chatId: SECOND,
    messageId: 7,
    authorId: 42,
    authorName: "Аня",
    text: "Секретная цифра бюджета робота — 900",
    at: 1,
  });
  await memory.reflect(SECOND);

  expect(memory.status(SECOND).messages).toBe(1);
  expect(memory.status(FIRST).messages).toBe(0);
  expect(memory.message(FIRST, 7)).toBeNull();
  const context = memory.context(FIRST, "hope", "бюджет робота");
  expect(context).toContain("otherGroups");
  expect(context).toContain("Аня собирает бюджет на робота");
  expect(context).not.toContain("Секретная цифра");
});

it("ignores a group outside the list", () => {
  const memory = createSharedMemory({ path: ":memory:" }, [FIRST]);
  memories.push(memory);
  memory.observe({ chatId: SECOND, messageId: 1, authorId: 1, authorName: "A", text: "x", at: 1 });
  expect(memory.status(SECOND)).toMatchObject({ epoch: 0, messages: 0 });
  expect(memory.context(SECOND, "hope", "x")).toBe("");
  memory.close();
  expect(memory.status(SECOND).epoch).toBe(-1);
});
