import type { Update } from "grammy/types";

import { it, vi, expect, describe, afterEach, beforeEach } from "vitest";

// Must be set before src/config.ts is first imported (dynamic imports below).
const GROUP_ID = -1001234567890;
process.env.CHAT_REPLY_CHAT_ID = String(GROUP_ID);
process.env.CHAT_REPLY_FALLBACK_PER_HOUR = "2";

const generateReply = vi.fn();
vi.mock("../src/chatReply/generateReply.js", () => ({
  generateReply: (...a: unknown[]) => generateReply(...a),
}));

const { createBot } = await import("../src/bot/index.js");
const { CandidateStore } = await import("../src/store/index.js");

const OWNER_ID = 123456789; // setup.ts OWNER_TELEGRAM_ID
const BOT_ID = 777;
const BOT_USERNAME = "aifirst_test_bot";

type Call = { method: string; payload: Record<string, unknown> };

async function makeBot() {
  const calls: Call[] = [];
  const store = new CandidateStore(":memory:");
  const bundle = createBot(store, async () => {});
  bundle.bot.api.config.use((_prev, method, payload) => {
    calls.push({ method, payload: payload as Record<string, unknown> });
    const result =
      method === "getMe"
        ? { id: BOT_ID, is_bot: true, first_name: "Bot", username: BOT_USERNAME }
        : true;
    return Promise.resolve({ ok: true, result } as never);
  });
  await bundle.bot.init();
  const sent = () => calls.filter((c) => c.method === "sendMessage");
  return { ...bundle, sent };
}

let nextId = 100;
function groupMessage(
  text: string,
  opts: { from?: number; chat?: number; replyToBot?: string; replyToPost?: string } = {},
): Update {
  nextId += 1;
  const chat = { id: opts.chat ?? GROUP_ID, type: "supergroup", title: "Чат" };
  return {
    update_id: nextId,
    message: {
      message_id: nextId,
      date: 0,
      text,
      chat,
      from: { id: opts.from ?? 42, is_bot: false, first_name: "Аня" },
      ...(opts.replyToBot === undefined
        ? {}
        : {
            reply_to_message: {
              message_id: 5,
              date: 0,
              chat,
              text: opts.replyToBot,
              from: { id: BOT_ID, is_bot: true, first_name: "Bot" },
            },
          }),
      ...(opts.replyToPost === undefined
        ? {}
        : { reply_to_message: channelPostMessage(opts.replyToPost, 6) }),
    },
  } as Update;
}

/** A channel post as Telegram copies it into the linked discussion group. */
function channelPostMessage(text: string | undefined, messageId: number) {
  return {
    message_id: messageId,
    date: 0,
    chat: { id: GROUP_ID, type: "supergroup", title: "Чат" },
    from: { id: 777000, is_bot: false, first_name: "Telegram" },
    sender_chat: { id: -100555, type: "channel", title: "AI First" },
    is_automatic_forward: true,
    ...(text === undefined ? {} : { caption: text }),
  };
}

function channelPost(text?: string): Update {
  nextId += 1;
  return { update_id: nextId, message: channelPostMessage(text, nextId) } as Update;
}

function ownerDm(text: string): Update {
  nextId += 1;
  return {
    update_id: nextId,
    message: {
      message_id: nextId,
      date: 0,
      text,
      entities: text.startsWith("/")
        ? [{ type: "bot_command", offset: 0, length: text.length }]
        : [],
      from: { id: OWNER_ID, is_bot: false, first_name: "Owner" },
      chat: { id: OWNER_ID, type: "private", first_name: "Owner" },
    },
  } as Update;
}

beforeEach(() => {
  generateReply.mockResolvedValue({ action: "reply", text: "Привет, я тут." });
});

afterEach(() => {
  generateReply.mockReset();
  vi.restoreAllMocks();
});

describe("group responder routing", () => {
  it("answers a mention in its group, as a reply to that message", async () => {
    const { bot, drain, sent } = await makeBot();
    await bot.handleUpdate(groupMessage(`@${BOT_USERNAME} что думаешь про луну?`));
    await drain();
    expect(generateReply).toHaveBeenCalledOnce();
    const user = generateReply.mock.calls[0]?.[2] as string;
    expect(user).toContain("что думаешь про луну?");
    expect(user).not.toContain(`@${BOT_USERNAME}`);
    expect(sent()).toHaveLength(1);
    expect(sent()[0]?.payload).toMatchObject({
      chat_id: GROUP_ID,
      text: "Привет, я тут.",
      reply_parameters: { message_id: nextId },
    });
  });

  it("answers a reply to its own message and shows the model what it replied to", async () => {
    const { bot, drain } = await makeBot();
    await bot.handleUpdate(groupMessage("а почему?", { replyToBot: "Луна быстрее." }));
    await drain();
    expect(generateReply.mock.calls[0]?.[2]).toContain("«Луна быстрее.»");
  });

  it("stays out of group talk that is not addressed to it", async () => {
    const { bot, drain, sent } = await makeBot();
    await bot.handleUpdate(groupMessage("обычный разговор без бота"));
    await drain();
    expect(generateReply).not.toHaveBeenCalled();
    expect(sent()).toHaveLength(0);
  });

  it("never turns the owner's group message into a blog post (manual ingest)", async () => {
    const { bot, drain, sent } = await makeBot();
    await bot.handleUpdate(groupMessage("https://example.com/article", { from: OWNER_ID }));
    await bot.handleUpdate(groupMessage("/fetch", { from: OWNER_ID }));
    await drain();
    expect(sent()).toHaveLength(0);
    expect(generateReply).not.toHaveBeenCalled();
  });

  it("ignores mentions in other groups and logs their id for setup", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const { bot, drain, sent } = await makeBot();
    await bot.handleUpdate(groupMessage(`@${BOT_USERNAME} привет`, { chat: -100999 }));
    await drain();
    expect(generateReply).not.toHaveBeenCalled();
    expect(sent()).toHaveLength(0);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("-100999"));
  });

  it("sends nothing when the model chooses silence", async () => {
    generateReply.mockResolvedValue({ action: "silent", text: "" });
    const { bot, drain, sent } = await makeBot();
    await bot.handleUpdate(groupMessage(`@${BOT_USERNAME} купи крипту`));
    await drain();
    expect(sent()).toHaveLength(0);
  });

  it("/chat in the owner DM switches the responder off and back on", async () => {
    const { bot, drain, sent } = await makeBot();
    await bot.handleUpdate(ownerDm("/chat"));
    expect(sent().at(-1)?.payload.text).toContain("выключен");
    await bot.handleUpdate(groupMessage(`@${BOT_USERNAME} ты тут?`));
    await drain();
    expect(generateReply).not.toHaveBeenCalled();
    await bot.handleUpdate(ownerDm("/chat"));
    expect(sent().at(-1)?.payload.text).toContain("включён");
    await bot.handleUpdate(groupMessage(`@${BOT_USERNAME} ты тут?`));
    await drain();
    expect(generateReply).toHaveBeenCalledOnce();
  });

  it("answers past the hourly cap: CHAT_REPLY_FALLBACK_PER_HOUR only limits the paid path", async () => {
    const { bot, drain } = await makeBot();
    for (let i = 0; i < 3; i += 1) {
      await bot.handleUpdate(groupMessage(`@${BOT_USERNAME} вопрос ${i}`));
      await drain();
    }
    expect(generateReply).toHaveBeenCalledTimes(3);
    const takePaidSlot = generateReply.mock.calls[0]?.[3] as () => boolean;
    expect([takePaidSlot(), takePaidSlot(), takePaidSlot()]).toEqual([true, true, false]);
  });

  it("shows the model the channel post a mention replies to", async () => {
    const { bot, drain } = await makeBot();
    await bot.handleUpdate(
      groupMessage(`@${BOT_USERNAME} что скажешь?`, { replyToPost: "Луна обогнала Sol в тестах" }),
    );
    await drain();
    expect(generateReply.mock.calls[0]?.[2]).toContain("Луна обогнала Sol в тестах");
  });

  it("comments on a new channel post with its own take, under that post", async () => {
    const { bot, drain, sent } = await makeBot();
    const update = channelPost("Codex собрал песочницу для агентов");
    await bot.handleUpdate(update);
    await drain();
    expect(generateReply).toHaveBeenCalledOnce();
    expect(generateReply.mock.calls[0]?.[2]).toContain("Codex собрал песочницу для агентов");
    expect(sent()[0]?.payload).toMatchObject({
      chat_id: GROUP_ID,
      reply_parameters: { message_id: update.message?.message_id },
    });
  });

  it("skips a channel post without text, like an album photo with no caption", async () => {
    const { bot, drain } = await makeBot();
    await bot.handleUpdate(channelPost());
    await drain();
    expect(generateReply).not.toHaveBeenCalled();
  });

  it("remembers its comment, so a later question about the post has the context", async () => {
    const { bot, drain } = await makeBot();
    await bot.handleUpdate(channelPost("Codex собрал песочницу для агентов"));
    await drain();
    await bot.handleUpdate(groupMessage(`@${BOT_USERNAME} а ты что думаешь про пост выше?`));
    await drain();
    expect(generateReply.mock.calls[1]?.[2]).toContain("Codex собрал песочницу для агентов");
  });

  it("remembers the exchange and shows it in the next prompt", async () => {
    const { bot, drain } = await makeBot();
    await bot.handleUpdate(groupMessage(`@${BOT_USERNAME} меня зовут Аня`));
    await drain();
    await bot.handleUpdate(groupMessage(`@${BOT_USERNAME} как меня зовут?`));
    await drain();
    const second = generateReply.mock.calls[1]?.[2] as string;
    expect(second).toContain("Аня: меня зовут Аня");
    expect(second).toContain("ты: Привет, я тут.");
  });
});
