import type { Update, Message, UserFromGetMe } from "grammy/types";

import { it, vi, expect, describe, afterEach } from "vitest";

const CHAT = -1001234567890;
const ROOT = 600;
const BODY = "А кто проверил тесты?";
process.env.CHAT_REPLY_CHAT_ID = String(CHAT);

const runCodex = vi.fn(async (_prompt: string) => JSON.stringify({ action: "reply", text: BODY }));
vi.mock("../src/llm/runCodex.js", () => ({ runCodex: (prompt: string) => runCodex(prompt) }));

const { createBot } = await import("../src/bot/index.js");
const { createDebates, messageReplyContext, sendConversationReply } =
  await import("../src/debate/index.js");
const { createAvatarBot } = await import("../src/avatar/index.js");
const { CandidateStore } = await import("../src/store/index.js");
const { AvatarStore } = await import("../src/avatar/avatarStore.js");

type Send = { name: string; payload: Record<string, unknown>; messageId: number };

async function setup(options: { rejectPeers?: boolean; deletedRootAfter?: number } = {}) {
  const sends: Send[] = [];
  const store = new CandidateStore(":memory:");
  const avatarStore = new AvatarStore(":memory:");
  avatarStore.allowChat(CHAT, "Discussion");
  avatarStore.setProfile("Synthetic practitioner who tests AI tools.");
  const hope = createBot(store, async () => {});
  const avatar = createAvatarBot("test:avatar", store, {
    fallbackNotify: async () => {},
    avatar: { avatarStore, index: async () => ({ posts: 0, chunks: 0, failed: 0 }) },
  });
  for (const [bot, name, id] of [
    [hope.bot, "Neiro Misha", 777],
    [avatar.bot, "neuro_misha", 999],
  ] as const) {
    bot.botInfo = {
      id,
      first_name: name,
      username: id === 777 ? "hope_bot" : "avatar_bot",
      is_bot: true,
      can_join_groups: true,
      can_read_all_group_messages: true,
      supports_inline_queries: false,
      can_connect_to_business: false,
      has_main_web_app: false,
      has_topics_enabled: false,
      allows_users_to_create_topics: false,
      can_manage_bots: false,
      supports_join_request_queries: false,
    } satisfies UserFromGetMe;
    bot.api.config.use((_prev, method, payload) => {
      const messageId = 700 + sends.length;
      if (method === "sendMessage") {
        const p = payload as Record<string, unknown>;
        sends.push({ name, payload: p, messageId });
        const reply = p.reply_parameters as
          | { message_id: number; allow_sending_without_reply: boolean }
          | undefined;
        const missingPeer = options.rejectPeers && reply?.message_id !== ROOT;
        const missingRoot =
          options.deletedRootAfter !== undefined &&
          sends.length > options.deletedRootAfter &&
          reply?.message_id === ROOT;
        if ((missingPeer || missingRoot) && !reply?.allow_sending_without_reply) {
          return Promise.resolve({
            ok: false,
            error_code: 400,
            description: "message to be replied not found",
          } as never);
        }
      }
      return Promise.resolve({
        ok: true,
        result:
          method === "sendMessage"
            ? { message_id: messageId, date: 0, chat: { id: CHAT, type: "supergroup" } }
            : true,
      } as never);
    });
  }
  const debates = createDebates({
    hope: hope.hope.speaker,
    avatar: avatar.avatar.speaker,
    turns: 3,
    pauseMs: 0,
    cooldownMs: 1,
  });
  hope.hope.onPostComment(debates.start);
  avatar.avatar.onReply(debates.start);
  return { hope, avatar, debates, sends, store };
}

const post = (): Update => ({
  update_id: 1,
  message: {
    message_id: ROOT,
    message_thread_id: ROOT,
    date: 0,
    text: "Агенты пишут тесты сами",
    chat: { id: CHAT, type: "supergroup", title: "Discussion" },
    from: { id: 777000, is_bot: false, first_name: "Telegram" },
    sender_chat: { id: -100555, type: "channel", title: "AI First" },
    is_automatic_forward: true,
  },
});

afterEach(() => {
  runCodex.mockClear();
  vi.restoreAllMocks();
});

describe("root-bound debate replies", () => {
  it("keeps all six replies under the forwarded post and links each exact recipient", async () => {
    const { hope, avatar, debates, sends, store } = await setup({ rejectPeers: true });
    await hope.bot.handleUpdate(post());
    await hope.drain();
    await debates.idle();
    await avatar.avatar.drainAndClose();
    store.close();
    expect(sends).toHaveLength(6);
    expect(sends.map((send) => send.payload.reply_parameters)).toEqual(
      Array.from({ length: 6 }, () => ({
        message_id: ROOT,
        allow_sending_without_reply: false,
      })),
    );
    for (const [index, send] of sends.entries()) {
      const recipient = index === 0 ? "AI First" : sends[index - 1]!.name;
      const recipientId = index === 0 ? ROOT : sends[index - 1]!.messageId;
      const prefix = `↪ Ответ ${recipient}`;
      expect(send.payload).toMatchObject({
        chat_id: CHAT,
        reply_parameters: { message_id: ROOT, allow_sending_without_reply: false },
        text: `${prefix}\n\n${BODY}`,
        entities: [
          {
            type: "text_link",
            offset: 0,
            length: prefix.length,
            url: `https://t.me/c/1234567890/${recipientId}`,
          },
        ],
      });
      expect(send.payload).not.toHaveProperty("message_thread_id");
      expect(send.payload).not.toHaveProperty("parse_mode");
    }
    expect(runCodex).toHaveBeenCalledTimes(12);
    const editorPrompts = runCodex.mock.calls.filter((_, index) => index % 2 === 1);
    for (const [prompt] of editorPrompts) {
      expect(prompt).not.toContain("↪ Ответ");
    }
  });

  it("bounds the UTF-16 message without splitting emoji or interpreting HTML", async () => {
    const { hope, avatar, sends, store } = await setup();
    await sendConversationReply(hope.bot, CHAT, `<b>literal</b>${"🙂".repeat(3000)}`, {
      rootMessageId: ROOT,
      messageId: 42,
      authorName: "👩‍🔬 <Миша>&",
      chatUsername: "@test_public",
    });
    await avatar.avatar.drainAndClose();
    store.close();
    const { payload } = sends[0]!;
    expect((payload.text as string).length).toBeLessThanOrEqual(4096);
    expect(payload.text).toMatch(/^↪ Ответ 👩‍🔬 <Миша>&\n\n<b>literal<\/b>/);
    expect(payload.text).toMatch(/🙂$/u);
    expect(payload.entities).toEqual([
      { type: "text_link", offset: 0, length: 21, url: "https://t.me/test_public/42" },
    ]);
    expect(payload).not.toHaveProperty("parse_mode");
  });

  it("recovers the discussion root from a reply without mistaking it for a forum topic", () => {
    const message: Message = {
      message_id: 900,
      date: 0,
      chat: { id: CHAT, type: "supergroup", title: "Discussion" },
      text: "@avatar_bot что дальше?",
      reply_to_message: {
        reply_to_message: undefined,
        message_id: 800,
        message_thread_id: ROOT,
        date: 0,
        chat: { id: CHAT, type: "supergroup", title: "Discussion" },
        text: BODY,
      },
    };
    expect(messageReplyContext(message)).toEqual({ rootMessageId: ROOT });
    expect(messageReplyContext(message, (id) => (id === 800 ? 500 : undefined))).toEqual({
      rootMessageId: 500,
    });
    expect(
      messageReplyContext({ ...message, is_topic_message: true, message_thread_id: 400 }),
    ).toEqual({
      rootMessageId: 800,
      messageThreadId: 400,
    });
    expect(messageReplyContext(post().message!)).toEqual({ rootMessageId: ROOT });
  });

  it("stops at a deleted root without retrying as a floating group message", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { hope, avatar, debates, sends, store } = await setup({ deletedRootAfter: 1 });
    await hope.bot.handleUpdate(post());
    await hope.drain();
    await debates.idle();
    expect(sends).toHaveLength(2);
    for (const send of sends) {
      expect(send.payload.reply_parameters).toEqual({
        message_id: ROOT,
        allow_sending_without_reply: false,
      });
    }
    expect(avatar.avatar.lastError()?.text).toContain("реплика в споре не отправилась");
    await avatar.avatar.drainAndClose();
    store.close();
  });

  it("keeps an avatar-started 3+3 conversation in the same linked discussion", async () => {
    const { hope, avatar, debates, sends, store } = await setup({ rejectPeers: true });
    const forwarded = post().message!;
    await avatar.bot.handleUpdate({
      update_id: 2,
      message: {
        message_id: 650,
        message_thread_id: ROOT,
        date: 0,
        text: "@avatar_bot что думаешь?",
        entities: [{ type: "mention", offset: 0, length: 11 }],
        from: { id: 42, is_bot: false, first_name: "Аня" },
        chat: { id: CHAT, type: "supergroup", title: "Discussion" },
        reply_to_message: { ...forwarded, reply_to_message: undefined },
      },
    });
    await vi.waitFor(() => expect(sends.length).toBeGreaterThan(0));
    await debates.idle();
    await hope.drain();
    await avatar.avatar.drainAndClose();
    store.close();
    expect(sends).toHaveLength(6);
    expect(sends[0]!.name).toBe("neuro_misha");
    expect(sends[0]!.payload.text).toBe(`↪ Ответ Аня\n\n${BODY}`);
    for (const [index, send] of sends.entries()) {
      const recipient = index === 0 ? "Аня" : sends[index - 1]!.name;
      const target = index === 0 ? 650 : sends[index - 1]!.messageId;
      expect(send.payload).toMatchObject({
        reply_parameters: { message_id: ROOT, allow_sending_without_reply: false },
        text: `↪ Ответ ${recipient}\n\n${BODY}`,
        entities: [{ url: `https://t.me/c/1234567890/${target}` }],
      });
      expect(send.payload).not.toHaveProperty("message_thread_id");
    }
  });

  it.each([
    { messageId: 0 },
    { messageId: 42, rootMessageId: 0 },
    { messageId: 42, rootMessageId: Number.NaN },
  ])("rejects an unusable message root before contacting Telegram", async (target) => {
    const { hope, avatar, sends, store } = await setup();
    await expect(async () => sendConversationReply(hope.bot, CHAT, BODY, target)).rejects.toThrow(
      "Reply root is not a usable Telegram message",
    );
    expect(sends).toHaveLength(0);
    await avatar.avatar.drainAndClose();
    store.close();
  });

  it("sends a forum topic separately from the reply root", async () => {
    const { hope, avatar, sends, store } = await setup();
    await sendConversationReply(hope.bot, CHAT, BODY, {
      rootMessageId: ROOT,
      messageThreadId: 400,
      messageId: 31,
      authorName: "Миша",
    });
    expect(sends[0]?.payload).toMatchObject({
      message_thread_id: 400,
      reply_parameters: { message_id: ROOT, allow_sending_without_reply: false },
      text: `↪ Ответ Миша\n\n${BODY}`,
      entities: [{ url: "https://t.me/c/1234567890/31" }],
    });
    await avatar.avatar.drainAndClose();
    store.close();
  });

  it("does not invent a basic group link or accept a URL as a username", async () => {
    const { hope, avatar, sends, store } = await setup();
    await sendConversationReply(hope.bot, -1234, BODY, {
      messageId: 32,
      authorName: "Миша",
      chatUsername: "bad/path?url=https://example.com",
    });
    expect(sends[0]?.payload).toMatchObject({
      chat_id: -1234,
      text: `↪ Ответ Миша\n\n${BODY}`,
      reply_parameters: { message_id: 32, allow_sending_without_reply: false },
      entities: [],
    });
    await avatar.avatar.drainAndClose();
    store.close();
  });

  it("leaves an unasked standalone line without an invented addressee", async () => {
    const { hope, avatar, sends, store } = await setup();
    await sendConversationReply(hope.bot, CHAT, BODY, {});
    expect(sends[0]?.payload.text).toBe(BODY);
    expect(sends[0]?.payload.entities).toEqual([]);
    expect(sends[0]?.payload).not.toHaveProperty("reply_parameters");
    await avatar.avatar.drainAndClose();
    store.close();
  });
});
