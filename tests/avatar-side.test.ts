import { Bot } from "grammy";
import { it, vi, expect, describe, afterEach, beforeEach } from "vitest";

const runCodex = vi.fn();
vi.mock("../src/llm/runCodex.js", () => ({
  runCodex: (...args: unknown[]) => runCodex(...args),
}));
vi.mock("../src/avatar/indexBlog.js", () => ({
  indexBlog: async () => ({ posts: 1, chunks: 1, failed: 0 }),
}));

import type { Side, DebateOpener } from "../src/debate/index.js";

const GROUP = -100777;
const OWNER = 123456789;
const AVATAR = { id: 999, is_bot: true, first_name: "Аватар", username: "misha_avatar_bot" };
const HOPE = { id: 777, is_bot: true, first_name: "Hope", username: "hope_bot" };

beforeEach(() => {
  vi.resetModules();
  process.env.AVATAR_BOT_TOKEN = "test:avatar";
  process.env.CHAT_REPLY_CHAT_ID = String(GROUP);
  runCodex.mockResolvedValue('{"action":"reply","text":"Ответ через Codex"}');
});

afterEach(() => {
  runCodex.mockReset();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("starting the avatar side", () => {
  it("refuses the news bot's own token and tells the owner, so both bots do not get 409", async () => {
    process.env.AVATAR_BOT_TOKEN = "test:telegram-token";
    const { CandidateStore } = await import("../src/store/index.js");
    const { startAvatarSide } = await import("../src/avatar/index.js");
    vi.spyOn(console, "error").mockImplementation(() => {});
    const notifyOwner = vi.fn(async (_text: string) => undefined);
    const hope = { speaker: { canSpeak: vi.fn(), speak: vi.fn() }, onPostComment: vi.fn() };
    expect(startAvatarSide(new CandidateStore(":memory:"), hope, notifyOwner)).toBeNull();
    expect(notifyOwner).toHaveBeenCalledWith(expect.stringContaining("токен новостного бота"));
    expect(hope.onPostComment).not.toHaveBeenCalled();
  });

  it.each(["hope", "avatar"] as const)(
    "completes 3+3 replies when %s opens the debate",
    async (opener) => {
      vi.useFakeTimers();
      vi.spyOn(console, "log").mockImplementation(() => {});
      const { CONFIG } = await import("../src/config.js");
      const { CandidateStore } = await import("../src/store/index.js");
      const { startAvatarSide } = await import("../src/avatar/index.js");
      const { createChatReply } = await import("../src/chatReply/index.js");
      const store = new CandidateStore(":memory:");
      const sent: { side: Side; messageId: number; replyTo: unknown }[] = [];
      let messageId = 100;
      let endPolling: () => void = () => {};
      const polling = vi.spyOn(Bot.prototype, "start").mockImplementation(function startPolling(
        this: Bot,
      ) {
        this.botInfo = {
          ...AVATAR,
          can_join_groups: true,
          can_read_all_group_messages: true,
          supports_inline_queries: false,
        } as typeof this.botInfo;
        this.api.config.use((_prev, method, payload) => {
          const p = payload as { chat_id?: number; reply_parameters?: { message_id: number } };
          messageId += 1;
          if (method === "sendMessage" && p.chat_id === GROUP) {
            sent.push({
              side: "avatar",
              messageId,
              replyTo: p.reply_parameters?.message_id,
            });
          }
          return Promise.resolve({
            ok: true,
            result: { message_id: messageId, date: 0, chat: { id: GROUP, type: "supergroup" } },
          } as never);
        });
        return new Promise<void>((resolve) => {
          endPolling = resolve;
        });
      });
      const newsBot = new Bot("test:telegram-token");
      newsBot.botInfo = { ...HOPE } as typeof newsBot.botInfo;
      newsBot.api.config.use((_prev, method, payload) => {
        const p = payload as { reply_parameters?: { message_id: number } };
        messageId += 1;
        if (method === "sendMessage") {
          sent.push({ side: "hope", messageId, replyTo: p.reply_parameters?.message_id });
        }
        return Promise.resolve({
          ok: true,
          result: { message_id: messageId, date: 0, chat: { id: GROUP, type: "supergroup" } },
        } as never);
      });
      const responder = createChatReply(newsBot, store);
      newsBot.use(responder.middleware);
      const side = startAvatarSide(
        store,
        responder.hope,
        vi.fn(async () => undefined),
      );
      const avatarBot = polling.mock.contexts[0] as Bot | undefined;
      if (!side || !avatarBot) throw new Error("Avatar side did not start");
      try {
        await avatarBot.handleUpdate({
          update_id: 1,
          my_chat_member: {
            chat: { id: GROUP, type: "supergroup", title: "AI-чат" },
            from: { id: OWNER, is_bot: false, first_name: "Миша" },
            date: 0,
            old_chat_member: { status: "left", user: AVATAR },
            new_chat_member: { status: "member", user: AVATAR },
          },
        });
        await (opener === "hope" ? newsBot : avatarBot).handleUpdate({
          update_id: 2,
          message: {
            message_id: 10,
            date: Math.floor(Date.now() / 1000),
            text:
              opener === "hope" ? "Агенты пишут тесты сами" : `@${AVATAR.username} что думаешь?`,
            from: { id: 555, is_bot: false, first_name: "Аня" },
            chat: { id: GROUP, type: "supergroup", title: "AI-чат" },
            ...(opener === "hope"
              ? {
                  sender_chat: { id: -100555, type: "channel", title: "AI First" },
                  is_automatic_forward: true,
                }
              : { entities: [{ type: "mention", offset: 0, length: AVATAR.username.length + 1 }] }),
          },
        });
        await vi.advanceTimersByTimeAsync(0);
        expect(sent.map((line) => line.side)).toEqual([opener]);
        for (let turn = 1; turn <= 6; turn += 1) {
          await vi.advanceTimersByTimeAsync(CONFIG.AVATAR_DEBATE_PAUSE_MS);
        }
        expect(sent.map((line) => line.side)).toEqual(
          opener === "hope"
            ? ["hope", "avatar", "hope", "avatar", "hope", "avatar"]
            : ["avatar", "hope", "avatar", "hope", "avatar", "hope"],
        );
        expect(runCodex).toHaveBeenCalledTimes(6);
        for (let turn = 1; turn < sent.length; turn += 1) {
          expect(sent[turn]?.replyTo).toBe(sent[turn - 1]?.messageId);
        }
      } finally {
        endPolling();
        await vi.advanceTimersByTimeAsync(0);
        await side.stop();
        await side.drain();
        await responder.drain();
        store.close();
      }
    },
  );

  it.each([false, true])(
    "stops debate turns and new debates when polling ends (failed=%s)",
    async (failed) => {
      vi.useFakeTimers();
      vi.spyOn(console, "log").mockImplementation(() => {});
      vi.spyOn(console, "error").mockImplementation(() => {});
      const { CONFIG } = await import("../src/config.js");
      const { CandidateStore } = await import("../src/store/index.js");
      const { startAvatarSide } = await import("../src/avatar/index.js");
      const store = new CandidateStore(":memory:");
      let endPolling: () => void = () => {};
      const polling = vi.spyOn(Bot.prototype, "start").mockImplementation(
        () =>
          new Promise<void>((resolve, reject) => {
            endPolling = () => (failed ? reject(new Error("polling failed")) : resolve());
          }),
      );
      const hope = {
        speaker: {
          canSpeak: vi.fn(async () => true),
          speak: vi.fn(async () => ({ side: "hope" as const, text: "Ответ Hope", messageId: 5 })),
        },
        onPostComment: vi.fn<(listener: DebateOpener) => void>(),
      };
      const notifyOwner = vi.fn(async () => undefined);
      const side = startAvatarSide(store, hope, notifyOwner);
      const avatarBot = polling.mock.contexts[0] as Bot | undefined;
      const open = hope.onPostComment.mock.calls[0]?.[0];
      if (!side || !avatarBot || !open) throw new Error("Avatar side did not start");
      try {
        avatarBot.botInfo = { ...AVATAR } as typeof avatarBot.botInfo;
        avatarBot.api.config.use(() => Promise.resolve({ ok: true, result: true } as never));
        await avatarBot.handleUpdate({
          update_id: 1,
          my_chat_member: {
            chat: { id: GROUP, type: "supergroup", title: "AI-чат" },
            from: { id: OWNER, is_bot: false, first_name: "Миша" },
            date: 0,
            old_chat_member: { status: "left", user: AVATAR },
            new_chat_member: { status: "member", user: AVATAR },
          },
        });
        open(GROUP, { side: "avatar", text: "Начальная реплика", messageId: 4 }, "Тема");
        await vi.advanceTimersByTimeAsync(CONFIG.AVATAR_DEBATE_PAUSE_MS);
        expect(hope.speaker.speak).toHaveBeenCalledOnce();
        endPolling();
        await vi.advanceTimersByTimeAsync(CONFIG.AVATAR_DEBATE_PAUSE_MS);
        expect(hope.speaker.speak).toHaveBeenCalledOnce();
        expect(runCodex).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(CONFIG.AVATAR_COOLDOWN_MS);
        open(GROUP, { side: "avatar", text: "Новый спор", messageId: 6 }, "Другая тема");
        await vi.advanceTimersByTimeAsync(CONFIG.AVATAR_DEBATE_PAUSE_MS);
        expect(hope.speaker.speak).toHaveBeenCalledOnce();
        expect(runCodex).not.toHaveBeenCalled();
        if (failed) {
          expect(notifyOwner).toHaveBeenCalledWith(expect.stringContaining("polling failed"));
        } else {
          expect(notifyOwner).not.toHaveBeenCalled();
        }
      } finally {
        endPolling();
        await side.stop();
        await side.drain();
        store.close();
      }
    },
  );
});
