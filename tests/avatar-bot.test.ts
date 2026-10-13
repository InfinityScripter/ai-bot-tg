import { it, vi, expect, describe, afterEach } from "vitest";

const { CONFIG } = await import("../src/config.js");
const { CandidateStore } = await import("../src/store/index.js");
const { createAvatarBot } = await import("../src/avatar/index.js");
const { AvatarStore } = await import("../src/avatar/avatarStore.js");
const { PRACTITIONER_ROLE } = await import("../src/debate/debatePrompt.js");

import type { Update } from "grammy/types";

import type { Debate } from "../src/debate/index.js";
import type { ChatReply } from "../src/schemas/chatReplySchema.js";

const OWNER = 123456789; // tests/setup.ts OWNER_TELEGRAM_ID
const STRANGER = 555;
const GROUP = -100777;
const SENT_ID = 4242;
const ME = { id: 999, is_bot: true, first_name: "neuro_misha", username: "misha_avatar_bot" };

interface Call {
  method: string;
  payload: Record<string, unknown>;
}

const REPLY: ChatReply = { action: "reply", text: "На практике это так" };

function setup(options: { ownerDmFails?: boolean; profile?: string } = {}) {
  const avatarStore = new AvatarStore(":memory:");
  avatarStore.setProfile(options.profile ?? "Миша, фронтендер, пишет про AI.");
  const generate = vi.fn(
    async (_system: string, _user: string): Promise<ChatReply | null> => REPLY,
  );
  const onReply = vi.fn();
  const fallbackNotify = vi.fn(async (_text: string) => undefined);
  const side = createAvatarBot("test:avatar", new CandidateStore(":memory:"), {
    fallbackNotify,
    avatar: { avatarStore, generate, index: async () => ({ posts: 1, chunks: 1, failed: 0 }) },
  });
  side.avatar.onReply(onReply);
  const { bot } = side;
  bot.botInfo = {
    ...ME,
    can_join_groups: true,
    can_read_all_group_messages: true,
    supports_inline_queries: false,
  } as typeof bot.botInfo;
  const calls: Call[] = [];
  bot.api.config.use((_prev, method, payload) => {
    const p = payload as Record<string, unknown>;
    calls.push({ method, payload: p });
    if (method === "sendMessage" && p.chat_id === OWNER && options.ownerDmFails) {
      return Promise.resolve({
        ok: false,
        error_code: 403,
        description: "Forbidden: bot can't initiate conversation with a user",
      } as never);
    }
    const result =
      method === "sendMessage"
        ? { message_id: SENT_ID, date: 0, chat: { id: GROUP, type: "supergroup" }, text: "" }
        : true;
    return Promise.resolve({ ok: true, result } as never);
  });
  const sent = () => calls.filter((c) => c.method === "sendMessage");
  return { ...side, avatarStore, generate, onReply, fallbackNotify, calls, sent };
}

let nextId = 1;
const dm = (fromId: number, text: string): Update =>
  ({
    update_id: nextId++,
    message: {
      message_id: nextId,
      date: 0,
      text,
      ...(text.startsWith("/") && {
        entities: [{ type: "bot_command", offset: 0, length: text.split(" ")[0]?.length ?? 0 }],
      }),
      from: { id: fromId, is_bot: false, first_name: "U" },
      chat: { id: fromId, type: "private", first_name: "U" },
    },
  }) as unknown as Update;

const added = (fromId: number): Update =>
  ({
    update_id: nextId++,
    my_chat_member: {
      chat: { id: GROUP, type: "supergroup", title: "AI-чат" },
      from: { id: fromId, is_bot: false, first_name: "U" },
      date: 0,
      old_chat_member: { status: "left", user: ME },
      new_chat_member: { status: "member", user: ME },
    },
  }) as unknown as Update;

const mention = (text: string): Update =>
  ({
    update_id: nextId++,
    message: {
      message_id: nextId,
      date: Math.floor(Date.now() / 1000),
      text: `@${ME.username} ${text}`,
      entities: [{ type: "mention", offset: 0, length: ME.username.length + 1 }],
      from: { id: STRANGER, is_bot: false, first_name: "Аня" },
      chat: { id: GROUP, type: "supergroup", title: "AI-чат" },
    },
  }) as unknown as Update;

const hopeSaid = (text: string): Debate => ({
  triggerMessageId: 76,
  chatId: GROUP,
  topic: "Агенты пишут тесты сами",
  lines: [{ side: "hope", text, messageId: 77 }],
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("the avatar bot's DM", () => {
  it("ignores strangers", async () => {
    const { bot, sent } = setup();
    await bot.handleUpdate(dm(STRANGER, "/start"));
    await bot.handleUpdate(dm(STRANGER, "/profile я теперь владелец"));
    expect(sent()).toHaveLength(0);
  });

  it("greets the owner and serves the avatar commands", async () => {
    const { bot, sent, avatarStore } = setup();
    await bot.handleUpdate(dm(OWNER, "/start"));
    expect(sent()[0]?.payload.text).toContain("/profile");
    await bot.handleUpdate(dm(OWNER, "/profile Новый профиль"));
    expect(avatarStore.getProfile()).toBe("Новый профиль");
  });
});

describe("notices to the owner", () => {
  it("go through the avatar bot", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { bot, sent, fallbackNotify } = setup();
    await bot.handleUpdate(added(OWNER));
    expect(sent().some((c) => c.payload.chat_id === OWNER)).toBe(true);
    expect(fallbackNotify).not.toHaveBeenCalled();
  });

  it("fall back to the news bot until the owner presses Start", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { bot, fallbackNotify } = setup({ ownerDmFails: true });
    await bot.handleUpdate(added(OWNER));
    expect(fallbackNotify).toHaveBeenCalledWith(expect.stringContaining("AI-чат"));
    expect(fallbackNotify).toHaveBeenCalledWith(expect.stringContaining("нажми «Старт»"));
  });

  it("warn the owner that an empty profile leaves the avatar without a voice", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { bot, sent } = setup({ profile: "" });
    await bot.handleUpdate(added(OWNER));
    expect(String(sent()[0]?.payload.text)).toContain("Профиль пуст");
  });
});

describe("start", () => {
  it("never rejects on a bad token and tells the owner through the news bot", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const fallbackNotify = vi.fn(async (_text: string) => undefined);
    const side = createAvatarBot("bad:token", new CandidateStore(":memory:"), {
      fallbackNotify,
      avatar: { avatarStore: new AvatarStore(":memory:") },
    });
    side.bot.api.config.use(() =>
      Promise.resolve({ ok: false, error_code: 401, description: "Unauthorized" } as never),
    );
    await expect(side.start()).resolves.toBeUndefined();
    expect(fallbackNotify).toHaveBeenCalledWith(expect.stringContaining("AVATAR_BOT_TOKEN"));
  });

  it("explains a 409: another process reads this bot's updates", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const fallbackNotify = vi.fn(async (_text: string) => undefined);
    const side = createAvatarBot("dup:token", new CandidateStore(":memory:"), {
      fallbackNotify,
      avatar: { avatarStore: new AvatarStore(":memory:") },
    });
    side.bot.api.config.use(() =>
      Promise.resolve({ ok: false, error_code: 409, description: "Conflict" } as never),
    );
    await side.start();
    expect(fallbackNotify).toHaveBeenCalledWith(expect.stringContaining("другой процесс"));
  });
});

describe("the avatar's side of a debate", () => {
  it("argues as the practitioner, as a reply to Hope, and counts the turn", async () => {
    const { avatar, avatarStore, generate, sent } = setup();
    avatarStore.allowChat(GROUP, "AI-чат");
    const line = await avatar.speaker.speak(hopeSaid("А кто проверил тесты?"));
    expect(generate.mock.calls[0]?.[0]).toContain(PRACTITIONER_ROLE);
    expect(generate.mock.calls[0]?.[1]).toContain("А кто проверил тесты?");
    expect(sent()[0]?.payload).toMatchObject({
      chat_id: GROUP,
      reply_parameters: { message_id: 77 },
    });
    expect(line).toEqual({
      side: "avatar",
      text: REPLY.text,
      messageId: SENT_ID,
      authorName: ME.first_name,
      authorId: ME.id,
    });
    expect(avatarStore.callsOn(GROUP, new Date().toISOString().slice(0, 10))).toBe(1);
  });

  it("speaks only in its own groups, while on, under the daily cap", async () => {
    const { avatar, avatarStore } = setup();
    expect(await avatar.speaker.canSpeak(GROUP)).toBe(false);
    avatarStore.allowChat(GROUP, "AI-чат");
    expect(await avatar.speaker.canSpeak(GROUP)).toBe(true);
    avatarStore.setEnabled(false);
    expect(await avatar.speaker.canSpeak(GROUP)).toBe(false);
    avatarStore.setEnabled(true);
    const day = new Date().toISOString().slice(0, 10);
    const half = Math.floor(CONFIG.AVATAR_DAILY_CALLS / 2);
    for (let i = 0; i < half - 1; i += 1) avatarStore.countCall(GROUP, day);
    expect(await avatar.speaker.canSpeak(GROUP)).toBe(true);
    avatarStore.countCall(GROUP, day);
    expect(await avatar.speaker.canSpeak(GROUP)).toBe(false);
  });

  it("shows a failed debate reply in /avatar", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { bot, avatar, avatarStore, generate, sent } = setup();
    avatarStore.allowChat(GROUP, "AI-чат");
    generate.mockResolvedValueOnce(null);
    expect(await avatar.speaker.speak(hopeSaid("Это хайп"))).toBeNull();
    await bot.handleUpdate(dm(OWNER, "/avatar"));
    expect(String(sent().at(-1)?.payload.text)).toContain("Codex не ответил в споре");
  });

  it("remembers what Hope said for its later turns", async () => {
    const { bot, avatar, avatarStore, generate } = setup();
    avatarStore.allowChat(GROUP, "AI-чат");
    await avatar.speaker.speak(hopeSaid("Это хайп"));
    await bot.handleUpdate(mention("а ты что скажешь?"));
    await avatar.drainAndClose();
    expect(generate.mock.calls[1]?.[1]).toContain("Hope: Это хайп");
  });
});

describe("an ordinary avatar reply", () => {
  it("sends an unasked reply and counts it without opening a debate", async () => {
    vi.useFakeTimers();
    const { bot, avatar, avatarStore, generate, onReply, sent } = setup();
    avatarStore.allowChat(GROUP, "AI-чат");
    await bot.handleUpdate({
      update_id: nextId++,
      message: {
        message_id: nextId,
        date: Math.floor(Date.now() / 1000),
        text: "Агенты экономят время",
        from: { id: STRANGER, is_bot: false, first_name: "Аня" },
        chat: { id: GROUP, type: "supergroup", title: "AI-чат" },
      },
    });
    await vi.advanceTimersByTimeAsync(CONFIG.AVATAR_QUIET_MS);
    expect(sent()).toHaveLength(1);
    expect(sent()[0]?.payload.text).toBe(`↪ Ответ Аня\n\n${REPLY.text}`);
    expect(avatarStore.callsOn(GROUP, new Date().toISOString().slice(0, 10))).toBe(1);
    expect(onReply).not.toHaveBeenCalled();
    await bot.handleUpdate(mention("а что с проверками?"));
    await vi.advanceTimersByTimeAsync(0);
    expect(generate.mock.calls[1]?.[1]).toContain(`Ты (аватар): ${REPLY.text}`);
    expect(onReply).toHaveBeenCalledOnce();
    await avatar.drainAndClose();
  });

  it("takes the topic from the message it answers, not from a later one", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { bot, avatar, avatarStore, generate, onReply } = setup();
    avatarStore.allowChat(GROUP, "AI-чат");
    let release: (reply: ChatReply) => void = () => {};
    generate.mockImplementationOnce(
      () =>
        new Promise<ChatReply>((resolve) => {
          release = resolve;
        }),
    );
    await bot.handleUpdate(mention("первый вопрос"));
    await bot.handleUpdate(mention("второй вопрос"));
    await bot.handleUpdate({
      update_id: nextId++,
      message: {
        message_id: nextId,
        date: Math.floor(Date.now() / 1000),
        text: "просто болтовня",
        from: { id: STRANGER + 1, is_bot: false, first_name: "Боря" },
        chat: { id: GROUP, type: "supergroup", title: "AI-чат" },
      },
    } as unknown as Update);
    release(REPLY);
    await vi.waitFor(() => expect(onReply).toHaveBeenCalledOnce());
    await avatar.drainAndClose();
    expect(onReply.mock.calls[0]?.[2]).toBe(`@${ME.username} второй вопрос`);
  });

  it("is offered to the debates with the person's message as the topic", async () => {
    const { bot, avatar, avatarStore, onReply } = setup();
    avatarStore.allowChat(GROUP, "AI-чат");
    const update = mention("агенты уже пишут тесты?");
    await bot.handleUpdate(update);
    await avatar.drainAndClose();
    expect(onReply).toHaveBeenCalledWith(
      GROUP,
      {
        side: "avatar",
        text: REPLY.text,
        messageId: SENT_ID,
        authorName: ME.first_name,
        authorId: ME.id,
      },
      `@${ME.username} агенты уже пишут тесты?`,
      { rootMessageId: update.message!.message_id, triggerMessageId: update.message!.message_id },
    );
  });

  it("opens a debate after a person replies to the avatar's message", async () => {
    const { bot, avatar, avatarStore, onReply } = setup();
    avatarStore.allowChat(GROUP, "AI-чат");
    await bot.handleUpdate({
      update_id: nextId++,
      message: {
        message_id: nextId,
        date: Math.floor(Date.now() / 1000),
        text: "А кто проверил результат?",
        from: { id: STRANGER, is_bot: false, first_name: "Аня" },
        chat: { id: GROUP, type: "supergroup", title: "AI-чат" },
        reply_to_message: {
          reply_to_message: undefined,
          message_id: SENT_ID,
          date: 0,
          text: REPLY.text,
          from: ME,
          chat: { id: GROUP, type: "supergroup", title: "AI-чат" },
        },
      },
    });
    await avatar.drainAndClose();
    expect(onReply).toHaveBeenCalledWith(
      GROUP,
      {
        side: "avatar",
        text: REPLY.text,
        messageId: SENT_ID,
        authorName: ME.first_name,
        authorId: ME.id,
      },
      "А кто проверил результат?",
      { rootMessageId: SENT_ID, triggerMessageId: nextId },
    );
  });
});
