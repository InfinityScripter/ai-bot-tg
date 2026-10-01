import type { Update } from "grammy/types";

import { it, vi, expect, describe, afterEach, beforeEach } from "vitest";

// Must be set before src/config.ts is first imported (dynamic imports below).
const GROUP_ID = -1001234567890;
process.env.CHAT_REPLY_CHAT_ID = String(GROUP_ID);
process.env.CHAT_REPLY_MAX_PER_HOUR = "2";

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
  opts: { from?: number; chat?: number; replyToBot?: string } = {},
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
    },
  } as Update;
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

  it("stops calling the model after CHAT_REPLY_MAX_PER_HOUR answers", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { bot, drain } = await makeBot();
    for (let i = 0; i < 3; i += 1) {
      await bot.handleUpdate(groupMessage(`@${BOT_USERNAME} вопрос ${i}`));
    }
    await drain();
    expect(generateReply).toHaveBeenCalledTimes(2);
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
