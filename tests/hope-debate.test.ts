import type { Update } from "grammy/types";

import { it, vi, expect, describe, afterEach, beforeEach } from "vitest";

// Must be set before src/config.ts is first imported (dynamic imports below).
const GROUP_ID = -1001234567890;
process.env.CHAT_REPLY_CHAT_ID = String(GROUP_ID);

const runCodex = vi.fn();
vi.mock("../src/llm/runCodex.js", () => ({
  runCodex: (...a: unknown[]) => runCodex(...a),
}));

const { createBot } = await import("../src/bot/index.js");
const { CandidateStore } = await import("../src/store/index.js");
const { SKEPTIC_ROLE } = await import("../src/debate/debatePrompt.js");

import type { Debate } from "../src/debate/index.js";

const OWNER_ID = 123456789; // setup.ts OWNER_TELEGRAM_ID
const OTHER_GROUP = -100999;
const SENT_ID = 4242;

type Call = { method: string; payload: Record<string, unknown> };

async function makeBot(memberStatus: string | Error = "member", isMember = true) {
  const calls: Call[] = [];
  const bundle = createBot(new CandidateStore(":memory:"), async () => {});
  bundle.bot.api.config.use((_prev, method, payload) => {
    calls.push({ method, payload: payload as Record<string, unknown> });
    if (method === "getChatMember" && memberStatus instanceof Error) {
      return Promise.resolve({
        ok: false,
        error_code: 400,
        description: "chat not found",
      } as never);
    }
    const results: Record<string, unknown> = {
      getMe: { id: 777, is_bot: true, first_name: "Neiro Misha", username: "hope_bot" },
      sendMessage: { message_id: SENT_ID, date: 0, chat: { id: GROUP_ID, type: "supergroup" } },
      getChatMember: {
        status: memberStatus,
        is_member: isMember,
        user: { id: 777, is_bot: true, first_name: "Bot" },
      },
    };
    return Promise.resolve({ ok: true, result: results[method] ?? true } as never);
  });
  await bundle.bot.init();
  const sent = () => calls.filter((c) => c.method === "sendMessage");
  return { ...bundle, calls, sent };
}

let nextId = 100;
function message(text: string, extra: Record<string, unknown> = {}): Update {
  nextId += 1;
  return {
    update_id: nextId,
    message: {
      message_id: nextId,
      date: 0,
      text,
      chat: { id: GROUP_ID, type: "supergroup", title: "Чат" },
      from: { id: 42, is_bot: false, first_name: "Аня" },
      ...extra,
    },
  } as Update;
}

/** A channel post as Telegram copies it into the linked discussion group. */
const channelPost = (text: string): Update =>
  message(text, {
    from: { id: 777000, is_bot: false, first_name: "Telegram" },
    sender_chat: { id: -100555, type: "channel", title: "AI First" },
    is_automatic_forward: true,
  });

const debate = (chatId = GROUP_ID): Debate => ({
  chatId,
  topic: "Агенты пишут тесты сами",
  lines: [
    {
      side: "avatar",
      text: "Я так уже месяц живу, полёт нормальный",
      messageId: 77,
      authorName: "neuro_misha",
      authorId: 999,
    },
  ],
});

beforeEach(() => {
  runCodex.mockResolvedValue(JSON.stringify({ action: "reply", text: "А кто проверил тесты?" }));
});

afterEach(() => {
  runCodex.mockReset();
  vi.restoreAllMocks();
});

describe("the news bot in groups", () => {
  it("never turns the owner's text in another group into a post card", async () => {
    const { bot, drain, sent } = await makeBot();
    await bot.handleUpdate(
      message("https://example.com/article", {
        chat: { id: OTHER_GROUP, type: "supergroup", title: "Другая" },
        from: { id: OWNER_ID, is_bot: false, first_name: "Owner" },
      }),
    );
    await drain();
    expect(sent()).toHaveLength(0);
  });
});

describe("Hope opens a debate under a channel post", () => {
  it("passes her post comment and the post to the listener", async () => {
    const { bot, drain, hope } = await makeBot();
    const listener = vi.fn();
    hope.onPostComment(listener);
    const update = channelPost("Codex собрал песочницу для агентов");
    await bot.handleUpdate(update);
    await drain();
    expect(listener).toHaveBeenCalledWith(
      GROUP_ID,
      {
        side: "hope",
        text: "А кто проверил тесты?",
        messageId: SENT_ID,
        authorName: "Neiro Misha",
        authorId: 777,
      },
      "Codex собрал песочницу для агентов",
      { rootMessageId: update.message!.message_id },
    );
  });

  it("does not open a debate from an answer to a mention", async () => {
    const { bot, drain, hope } = await makeBot();
    const listener = vi.fn();
    hope.onPostComment(listener);
    await bot.handleUpdate(message("@hope_bot что думаешь?"));
    await drain();
    expect(listener).not.toHaveBeenCalled();
  });
});

describe("Hope's side of a debate", () => {
  it("argues as the skeptic, through Codex, as a reply to the avatar", async () => {
    const { hope, sent } = await makeBot();
    const line = await hope.speaker.speak(debate());
    const prompt = runCodex.mock.calls[0]?.[0] as string;
    expect(prompt).toContain(SKEPTIC_ROLE);
    expect(prompt).toContain("Я так уже месяц живу, полёт нормальный");
    expect(sent()[0]?.payload).toMatchObject({
      chat_id: GROUP_ID,
      text: "↪ Ответ neuro_misha\n\nА кто проверил тесты?",
      reply_parameters: { message_id: 77, allow_sending_without_reply: false },
    });
    expect(line).toEqual({
      side: "hope",
      text: "А кто проверил тесты?",
      messageId: SENT_ID,
      authorName: "Neiro Misha",
      authorId: 777,
    });
  });

  it("ends the debate when Codex fails: no paid fallback, nothing sent", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    runCodex.mockRejectedValue(new Error("401"));
    const { hope, sent } = await makeBot();
    expect(await hope.speaker.speak(debate())).toBeNull();
    expect(sent()).toHaveLength(0);
  });

  it("speaks in the discussion group and in groups where the news bot is a member", async () => {
    expect(await (await makeBot()).hope.speaker.canSpeak(GROUP_ID)).toBe(true);
    expect(await (await makeBot("member")).hope.speaker.canSpeak(OTHER_GROUP)).toBe(true);
  });

  it("does not speak where the news bot is not a member", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    expect(await (await makeBot("left")).hope.speaker.canSpeak(OTHER_GROUP)).toBe(false);
    expect(await (await makeBot(new Error())).hope.speaker.canSpeak(OTHER_GROUP)).toBe(false);
    expect(await (await makeBot("restricted", false)).hope.speaker.canSpeak(OTHER_GROUP)).toBe(
      false,
    );
    expect(await (await makeBot("restricted", true)).hope.speaker.canSpeak(OTHER_GROUP)).toBe(true);
  });

  it("does not speak while /chat is off", async () => {
    const { bot, hope } = await makeBot();
    await bot.handleUpdate({
      update_id: 1,
      message: {
        message_id: 1,
        date: 0,
        text: "/chat",
        entities: [{ type: "bot_command", offset: 0, length: 5 }],
        from: { id: OWNER_ID, is_bot: false, first_name: "Owner" },
        chat: { id: OWNER_ID, type: "private", first_name: "Owner" },
      },
    } as Update);
    expect(await hope.speaker.canSpeak(GROUP_ID)).toBe(false);
  });
});
