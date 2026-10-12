import { Bot } from "grammy";
import { it, vi, expect, describe, afterEach } from "vitest";

const { CONFIG } = await import("../src/config.js");
const { CandidateStore } = await import("../src/store/index.js");
const { AvatarStore } = await import("../src/avatar/avatarStore.js");
const { createAvatar, registerAvatarCommands } = await import("../src/avatar/index.js");

import type { Update } from "grammy/types";

import type { ChatReply } from "../src/schemas/chatReplySchema.js";

const OWNER = 123456789; // tests/setup.ts OWNER_TELEGRAM_ID
const STRANGER = 555;
const GROUP = -100777;
const ME = { id: 999, is_bot: true, first_name: "Bot", username: "blog_bot" };

interface Call {
  method: string;
  payload: Record<string, unknown>;
}

const REPLY: ChatReply = { action: "reply", text: "Ответ аватара" };

function setup(reply: ChatReply | null = REPLY, readsAll = true) {
  const avatarStore = new AvatarStore(":memory:");
  const generate = vi.fn(async (_system: string, _user: string) => reply);
  const index = vi.fn(async () => ({ posts: 2, chunks: 3, failed: 0 }));
  const bot = new Bot("test:token");
  bot.botInfo = {
    ...ME,
    can_join_groups: true,
    can_read_all_group_messages: readsAll,
    supports_inline_queries: false,
  } as typeof bot.botInfo;
  const calls: Call[] = [];
  bot.api.config.use((_prev, method, payload) => {
    calls.push({ method, payload: payload as Record<string, unknown> });
    const result =
      method === "sendMessage"
        ? { message_id: 4242, date: 0, chat: { id: GROUP, type: "supergroup" }, text: "" }
        : true;
    return Promise.resolve({ ok: true, result } as never);
  });
  const avatar = createAvatar(bot, new CandidateStore(":memory:"), {
    avatarStore,
    generate,
    index,
  });
  bot.use(avatar.middleware);
  registerAvatarCommands(bot, avatar);
  // Stands in for the owner lock and manual ingest: reached only when the avatar passed the update on.
  const passed = vi.fn();
  bot.on(["message", "my_chat_member"], passed);
  const sent = () => calls.filter((c) => c.method === "sendMessage");
  return { bot, avatarStore, generate, index, calls, passed, sent };
}

let nextId = 1;
const member = (
  fromId: number,
  before: string,
  after: string,
  chat: Record<string, unknown> = { id: GROUP, type: "supergroup", title: "AI-чат" },
): Update =>
  ({
    update_id: nextId++,
    my_chat_member: {
      chat,
      from: { id: fromId, is_bot: false, first_name: "U" },
      date: 0,
      old_chat_member: { status: before, user: ME },
      new_chat_member: { status: after, user: ME },
    },
  }) as unknown as Update;

const groupText = (fromId: number, text: string, extra: Record<string, unknown> = {}): Update =>
  ({
    update_id: nextId++,
    message: {
      message_id: nextId,
      date: Math.floor(Date.now() / 1000),
      chat: { id: GROUP, type: "supergroup", title: "AI-чат" },
      from: { id: fromId, is_bot: false, first_name: fromId === OWNER ? "Миша" : "Оля" },
      text,
      ...extra,
    },
  }) as unknown as Update;

const mention = (fromId: number) =>
  groupText(fromId, "@blog_bot что думаешь?", {
    entities: [{ type: "mention", offset: 0, length: 9 }],
  });

const dm = (text: string): Update => {
  const command = text.split(" ")[0] ?? "";
  return {
    update_id: nextId++,
    message: {
      message_id: nextId,
      date: 0,
      chat: { id: OWNER, type: "private", first_name: "Миша" },
      from: { id: OWNER, is_bot: false, first_name: "Миша" },
      text,
      entities: command.startsWith("/")
        ? [{ type: "bot_command", offset: 0, length: command.length }]
        : [],
    },
  } as unknown as Update;
};

afterEach(() => {
  vi.useRealTimers();
});

describe("who may bring the bot into a group", () => {
  it("stays where the owner added it and tells the owner how to let it see everything", async () => {
    const { bot, avatarStore, calls } = setup(REPLY, false);
    await bot.handleUpdate(member(OWNER, "left", "member"));
    expect(avatarStore.isAllowed(GROUP)).toBe(true);
    const dmToOwner = calls.find((c) => c.method === "sendMessage" && c.payload.chat_id === OWNER);
    expect(String(dmToOwner?.payload.text)).toContain("администратором");
    expect(calls.map((c) => c.method)).not.toContain("leaveChat");
  });

  it("leaves a group a stranger added it to", async () => {
    const { bot, avatarStore, calls } = setup();
    await bot.handleUpdate(member(STRANGER, "left", "member"));
    expect(avatarStore.isAllowed(GROUP)).toBe(false);
    expect(calls).toContainEqual({ method: "leaveChat", payload: { chat_id: GROUP } });
  });

  it("never leaves on a promotion, even in a group it does not speak in", async () => {
    const { bot, avatarStore, calls } = setup();
    await bot.handleUpdate(member(STRANGER, "member", "administrator"));
    expect(avatarStore.isAllowed(GROUP)).toBe(false);
    expect(calls.map((c) => c.method)).not.toContain("leaveChat");
  });

  it("forgets a group it was removed from and drops its pending turn", async () => {
    vi.useFakeTimers();
    const { bot, avatarStore, generate } = setup();
    avatarStore.allowChat(GROUP, "AI-чат");
    await bot.handleUpdate(groupText(STRANGER, "агенты экономят время"));
    await bot.handleUpdate(member(OWNER, "member", "kicked"));
    await vi.advanceTimersByTimeAsync(CONFIG.AVATAR_QUIET_MS);
    expect(avatarStore.isAllowed(GROUP)).toBe(false);
    expect(generate).not.toHaveBeenCalled();
  });

  it("leaves channels alone and passes their updates on", async () => {
    const { bot, calls, passed } = setup();
    await bot.handleUpdate(
      member(STRANGER, "left", "administrator", { id: -1001, type: "channel", title: "Канал" }),
    );
    expect(calls.map((c) => c.method)).not.toContain("leaveChat");
    expect(passed).toHaveBeenCalledTimes(1);
  });

  it("moves the permission when a group becomes a supergroup", async () => {
    const { bot, avatarStore } = setup();
    avatarStore.allowChat(-42, "AI-чат");
    await bot.handleUpdate(groupText(OWNER, "", { text: undefined, migrate_from_chat_id: -42 }));
    expect(avatarStore.isAllowed(GROUP)).toBe(true);
    expect(avatarStore.isAllowed(-42)).toBe(false);
  });
});

describe("group updates never reach the owner lock", () => {
  it("stops the owner's own text in a group that is not an avatar group", async () => {
    const { bot, passed, generate } = setup();
    await bot.handleUpdate(groupText(OWNER, "https://example.com/news"));
    expect(passed).not.toHaveBeenCalled();
    expect(generate).not.toHaveBeenCalled();
  });

  it("passes private messages on", async () => {
    const { bot, passed } = setup();
    await bot.handleUpdate(dm("https://example.com/news"));
    expect(passed).toHaveBeenCalledTimes(1);
  });
});

describe("turns in an avatar group", () => {
  it("answers a mention right away, as a reply, and counts the turn", async () => {
    const { bot, avatarStore, sent } = setup();
    avatarStore.allowChat(GROUP, "AI-чат");
    await bot.handleUpdate(mention(STRANGER));
    await vi.waitFor(() => expect(sent()).toHaveLength(1));
    expect(sent()[0]?.payload.text).toBe("Ответ аватара");
    expect(sent()[0]?.payload.reply_parameters).toEqual({
      message_id: expect.any(Number),
      allow_sending_without_reply: true,
    });
    expect(avatarStore.callsOn(GROUP, new Date().toISOString().slice(0, 10))).toBe(1);
  });

  it("asks the model once per pause, not once per message", async () => {
    vi.useFakeTimers();
    const { bot, avatarStore, generate } = setup({ action: "silent", text: "" });
    avatarStore.allowChat(GROUP, "AI-чат");
    await bot.handleUpdate(groupText(STRANGER, "агенты экономят время"));
    await bot.handleUpdate(groupText(STRANGER, "или нет"));
    await bot.handleUpdate(groupText(STRANGER, "спорно"));
    expect(generate).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(CONFIG.AVATAR_QUIET_MS);
    expect(generate).toHaveBeenCalledTimes(1);
    expect(generate.mock.calls[0]?.[0]).toContain("Тебя не звали");
  });

  it("stays silent unasked while the owner is talking", async () => {
    vi.useFakeTimers();
    const { bot, avatarStore, generate } = setup();
    avatarStore.allowChat(GROUP, "AI-чат");
    await bot.handleUpdate(groupText(OWNER, "я тут"));
    await bot.handleUpdate(groupText(STRANGER, "что скажешь"));
    await vi.advanceTimersByTimeAsync(CONFIG.AVATAR_QUIET_MS);
    expect(generate).not.toHaveBeenCalled();
  });

  it("answers a mention that came while an unasked turn was running", async () => {
    vi.useFakeTimers();
    const { bot, avatarStore, generate, sent } = setup();
    avatarStore.allowChat(GROUP, "AI-чат");
    let release: (r: ChatReply) => void = () => {};
    generate.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    await bot.handleUpdate(groupText(STRANGER, "агенты экономят время"));
    await vi.advanceTimersByTimeAsync(CONFIG.AVATAR_QUIET_MS);
    await bot.handleUpdate(mention(STRANGER));
    release({ action: "silent", text: "" });
    await vi.waitFor(() => expect(sent()).toHaveLength(1));
    expect(generate).toHaveBeenCalledTimes(2);
    expect(sent()[0]?.payload.reply_parameters).toBeDefined();
  });

  it("stops at the daily cap, even for mentions", async () => {
    const { bot, avatarStore, generate } = setup();
    avatarStore.allowChat(GROUP, "AI-чат");
    const day = new Date().toISOString().slice(0, 10);
    for (let i = 0; i < CONFIG.AVATAR_DAILY_CALLS; i++) avatarStore.countCall(GROUP, day);
    await bot.handleUpdate(mention(STRANGER));
    await new Promise((r) => setTimeout(r, 10));
    expect(generate).not.toHaveBeenCalled();
  });

  it("does not count a turn no model could answer, and shows the error in /avatar", async () => {
    const { bot, avatarStore, generate, calls } = setup(null);
    avatarStore.allowChat(GROUP, "AI-чат");
    await bot.handleUpdate(mention(STRANGER));
    await vi.waitFor(() => expect(generate).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 10));
    expect(avatarStore.callsOn(GROUP, new Date().toISOString().slice(0, 10))).toBe(0);
    await bot.handleUpdate(dm("/avatar"));
    expect(String(calls.at(-1)?.payload.text)).toContain("Codex не ответил");
  });

  it("does nothing while switched off", async () => {
    const { bot, avatarStore, generate } = setup();
    avatarStore.allowChat(GROUP, "AI-чат");
    avatarStore.setEnabled(false);
    await bot.handleUpdate(mention(STRANGER));
    await new Promise((r) => setTimeout(r, 10));
    expect(generate).not.toHaveBeenCalled();
  });

  it("starts the first blog crawl on the first message when the memory is empty", async () => {
    const { bot, avatarStore, index } = setup({ action: "silent", text: "" });
    avatarStore.allowChat(GROUP, "AI-чат");
    await bot.handleUpdate(groupText(STRANGER, "привет"));
    await bot.handleUpdate(groupText(STRANGER, "ещё"));
    expect(index).toHaveBeenCalledTimes(1);
  });
});

describe("owner commands", () => {
  it("saves the profile", async () => {
    const { bot, avatarStore } = setup();
    await bot.handleUpdate(dm("/profile Разработчик, пишу про ИИ"));
    expect(avatarStore.getProfile()).toBe("Разработчик, пишу про ИИ");
  });

  it("switches the avatar off and on", async () => {
    const { bot, avatarStore } = setup();
    await bot.handleUpdate(dm("/avatar off"));
    expect(avatarStore.isEnabled()).toBe(false);
    await bot.handleUpdate(dm("/avatar on"));
    expect(avatarStore.isEnabled()).toBe(true);
  });

  it("reports a reindex", async () => {
    const { bot, index, calls } = setup();
    await bot.handleUpdate(dm("/reindex"));
    await vi.waitFor(() => expect(String(calls.at(-1)?.payload.text)).toContain("кусков 3"));
    expect(index).toHaveBeenCalledTimes(1);
  });

  it("leaves a group by id and forgets it", async () => {
    const { bot, avatarStore, calls } = setup();
    avatarStore.allowChat(GROUP, "AI-чат");
    await bot.handleUpdate(dm(`/avatar leave ${GROUP}`));
    expect(calls).toContainEqual({ method: "leaveChat", payload: { chat_id: GROUP } });
    expect(avatarStore.isAllowed(GROUP)).toBe(false);
  });
});
