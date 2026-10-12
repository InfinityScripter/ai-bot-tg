import type { Message, RichText } from "grammy/types";

import { it, expect } from "vitest";

import { messageText } from "../src/telegram/messageText.js";

it("bounds malformed recursive rich arrays before they can exhaust the stack", () => {
  const cycle: RichText[] = [];
  cycle.push(cycle);
  const message: Message.RichMessageMessage = {
    message_id: 1,
    date: 0,
    chat: { id: -100777, type: "supergroup", title: "Synthetic group" },
    rich_message: {
      blocks: [
        { type: "paragraph", text: cycle },
        { type: "paragraph", text: "Следующий видимый абзац" },
      ],
    },
  };
  expect(() => messageText(message)).not.toThrow();
  expect(messageText(message)).toContain("Следующий видимый абзац");
  expect(messageText(undefined)).toBeUndefined();
  expect(messageText({ ...message, text: "Обычный текст", caption: "Подпись" })).toBe(
    "Обычный текст",
  );
  expect(messageText({ ...message, caption: "Подпись" })).toBe("Подпись");
  expect(messageText({ ...message, text: "", caption: "Подпись" })).toBe("");
  expect(messageText({ ...message, rich_message: { blocks: [] } })).toBeUndefined();
  const normal: Message.RichMessageMessage = {
    ...message,
    rich_message: { blocks: [{ type: "paragraph", text: `${"x".repeat(32_767)}終` }] },
  };
  expect(messageText(normal)).toHaveLength(32_768);
  expect(messageText(normal)).toMatch(/終$/);
  const oversized: Message.RichMessageMessage = {
    ...message,
    rich_message: { blocks: [{ type: "paragraph", text: "x".repeat(200_000) }] },
  };
  expect(messageText(oversized)?.length).toBeLessThanOrEqual(131_072);
});
