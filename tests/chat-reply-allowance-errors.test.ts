import type { Update } from "grammy/types";

import { Bot } from "grammy";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { rmSync, mkdtempSync } from "node:fs";
import { it, vi, expect, describe, afterEach } from "vitest";

vi.mock("dotenv/config", () => ({}));
const generateReply = vi.fn();
vi.mock("../src/chatReply/generateReply.js", () => ({ generateReply, codexReply: vi.fn() }));
const CHAT = -1001234567890;
process.env.CHAT_REPLY_CHAT_ID = String(CHAT);

const { createChatReply } = await import("../src/chatReply/createChatReply.js");
const { CandidateStore } = await import("../src/store/index.js");

const disposers: (() => Promise<void>)[] = [];

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "reply-allowance-errors-"));
  const path = join(dir, "claims.sqlite");
  const store = new CandidateStore(path);
  const connection = new Database(path);
  const bot = new Bot("test:hope");
  bot.botInfo = {
    id: 777,
    first_name: "Hope",
    username: "hope_bot",
    is_bot: true,
  } as typeof bot.botInfo;
  const sent: Record<string, unknown>[] = [];
  bot.api.config.use((_previous, method, payload) => {
    if (method === "sendChatAction") return Promise.resolve({ ok: true, result: true } as never);
    if (method !== "sendMessage") throw new Error(`Unexpected synthetic API call: ${method}`);
    sent.push(payload as Record<string, unknown>);
    return Promise.resolve({
      ok: true,
      result: { message_id: 700 + sent.length, date: 0, chat: { id: CHAT, type: "supergroup" } },
    } as never);
  });
  const reportReplyError = vi.fn();
  const responder = createChatReply(bot, store, { reportReplyError });
  bot.use(responder.middleware);
  disposers.push(async () => {
    await Promise.allSettled([responder.drain()]);
    connection.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  async function deliver(messageId: number) {
    const update: Update = {
      update_id: messageId,
      message: {
        message_id: messageId,
        date: 0,
        text: "@hope_bot Как проверим агента?",
        chat: { id: CHAT, type: "supergroup", title: "Synthetic discussion" },
        from: { id: 42, is_bot: false, first_name: "Аня" },
      },
    };
    await bot.handleUpdate(update);
  }
  return { store, connection, sent, responder, deliver, reportReplyError };
}

afterEach(async () => {
  for (const dispose of disposers.splice(0)) await dispose();
  generateReply.mockReset();
  vi.restoreAllMocks();
});

describe("Hope queue isolates allowance storage failures", () => {
  it.each(["claim", "release"] as const)(
    "reports a real SQLite %s failure and still answers the next source exactly once",
    async (stage) => {
      const error = vi.spyOn(console, "error").mockImplementation(() => {});
      const fixture = setup();
      generateReply.mockResolvedValue({ action: "reply", text: "Проверим на одинаковых задачах." });
      const operation = vi.spyOn(fixture.store.replyAllowance, stage);
      if (stage === "claim") {
        const activate = fixture.store.replyAllowance.activate.bind(fixture.store.replyAllowance);
        vi.spyOn(fixture.store.replyAllowance, "activate").mockImplementationOnce(
          (chatId, source) => {
            activate(chatId, source);
            // The queued claim runs only after the source was activated successfully.
            fixture.connection.exec("BEGIN IMMEDIATE");
          },
        );
      } else {
        generateReply.mockResolvedValueOnce({ action: "silent", text: "" });
        fixture.connection.exec(`
          CREATE TRIGGER reject_unused_release BEFORE DELETE ON bot_reply_claims
          WHEN OLD.trigger_message_id = 650
          BEGIN SELECT RAISE(ABORT, 'Synthetic unused claim release failure'); END;
        `);
      }
      try {
        await fixture.deliver(650);
        const outcome = await fixture.responder.drain().then(
          () => "fulfilled",
          () => "rejected",
        );
        expect(operation.mock.results[0]?.type).toBe("throw");
        expect(operation.mock.results[0]?.value).toMatchObject({
          code: stage === "claim" ? "SQLITE_BUSY" : "SQLITE_CONSTRAINT_TRIGGER",
        });
        expect(fixture.sent).toHaveLength(0);
        expect(outcome).toBe("fulfilled");
        expect(fixture.reportReplyError).toHaveBeenCalledOnce();
        expect(error).toHaveBeenCalledWith(expect.stringContaining("answer to 650 failed"));
      } finally {
        if (stage === "claim") fixture.connection.exec("ROLLBACK");
        else fixture.connection.exec("DROP TRIGGER reject_unused_release");
      }
      await fixture.deliver(651);
      await fixture.responder.drain();
      expect(fixture.sent).toHaveLength(1);
      expect(fixture.sent[0]?.reply_parameters).toMatchObject({ message_id: 651 });
      await fixture.deliver(651);
      await fixture.responder.drain();
      expect(fixture.sent).toHaveLength(1);
      expect(generateReply).toHaveBeenCalledTimes(stage === "claim" ? 1 : 2);
      expect(fixture.store.replyAllowance.claim(CHAT, 650, "hope")).toBe(stage === "claim");
    },
    15_000,
  );
});
