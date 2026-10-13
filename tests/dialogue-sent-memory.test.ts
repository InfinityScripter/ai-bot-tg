import { Bot } from "grammy";
import { it, vi, expect, describe, afterEach, beforeEach } from "vitest";

import type { Side, DebateLine } from "../src/debate/types.js";
import type { ChatReply } from "../src/schemas/chatReplySchema.js";

vi.mock("dotenv/config", () => ({}));
const codex = vi.fn();
vi.mock("../src/chatReply/generateReply.js", () => ({
  codexReply: (...args: unknown[]) => codex(...args),
}));

const CHAT = -1001234567890;
process.env.CHAT_REPLY_CHAT_ID = String(CHAT);
const { CONFIG } = await import("../src/config.js");
const { ChatHistory } = await import("../src/avatar/chatHistory.js");
const { AvatarStore } = await import("../src/avatar/avatarStore.js");
const { CandidateStore } = await import("../src/store/index.js");
const { createGroupTurns } = await import("../src/avatar/groupTurns.js");
const { createHopeSpeaker } = await import("../src/chatReply/debateSpeaker.js");
const { createAvatarSpeaker } = await import("../src/avatar/debateSpeaker.js");
const { createConversationMemory } = await import("../src/chatMemory/index.js");

const ROOT = 645;
const THREAD = 640;
const TRIGGER = 650;
const NEXT_TRIGGER = 651;
const LAST_REPLY = 670;
const SENT = 701;
const FINAL_TEXT = "Я".repeat(4200);
// The fixed recipient prefix is 20 UTF-16 units, leaving 4076 of Telegram's 4096.
const DELIVERED_TEXT = "Я".repeat(4076);
const MODES = ["hope debate", "avatar debate", "avatar unasked"] as const;
type Mode = (typeof MODES)[number];
const disposers: (() => Promise<void>)[] = [];

function setup(mode: Mode, pendingGeneration = false) {
  const memory = createConversationMemory({
    path: ":memory:",
    chatId: CHAT,
    debounceMs: CONFIG.AVATAR_QUIET_MS + 60_000,
    generate: vi.fn(async () => null),
  });
  const store = new CandidateStore(":memory:");
  const avatarStore = new AvatarStore(":memory:");
  avatarStore.allowChat(CHAT, "Synthetic group");
  const history = new ChatHistory();
  const side: Side = mode === "hope debate" ? "hope" : "avatar";
  const bot = new Bot("synthetic:bot-token");
  bot.botInfo = {
    id: side === "hope" ? 777 : 999,
    is_bot: true,
    first_name: side,
    username: `${side}_bot`,
    can_join_groups: true,
    can_read_all_group_messages: true,
    supports_inline_queries: false,
  } as typeof bot.botInfo;
  let confirm: () => void = () => {};
  const acknowledgement = new Promise<void>((resolve) => {
    confirm = resolve;
  });
  let announceSend: () => void = () => {};
  const sendStarted = new Promise<void>((resolve) => {
    announceSend = resolve;
  });
  const sends: Record<string, unknown>[] = [];
  bot.api.config.use(async (_previous, method, payload) => {
    if (method !== "sendMessage") throw new Error(`Unexpected synthetic API method: ${method}`);
    sends.push(payload as Record<string, unknown>);
    announceSend();
    await acknowledgement;
    return {
      ok: true,
      result: {
        message_id: SENT,
        date: Math.floor(Date.now() / 1000),
        from: bot.botInfo,
        chat: { id: CHAT, type: "supergroup" },
        text: (payload as { text: string }).text,
        reply_to_message: { message_id: ROOT },
      },
    } as never;
  });
  let releaseGeneration: (reply: ChatReply) => void = () => {};
  const generated = pendingGeneration
    ? new Promise<ChatReply>((resolve) => {
        releaseGeneration = resolve;
      })
    : Promise.resolve({ action: "reply" as const, text: FINAL_TEXT });
  const generate = vi.fn(() => generated);
  codex.mockImplementation(() => generate());
  const onFail = vi.fn();
  let active = true;
  const speaker =
    mode === "hope debate"
      ? createHopeSpeaker(bot, store.replyAllowance, () => true, memory, onFail)
      : createAvatarSpeaker(
          bot,
          avatarStore,
          history,
          generate,
          onFail,
          memory,
          () => active,
          store.replyAllowance,
        );
  const turns = createGroupTurns(
    bot,
    avatarStore,
    generate,
    history,
    memory,
    onFail,
    store.replyAllowance,
  );
  const listener = vi.fn();
  turns.onReply(listener);
  const target = {
    rootMessageId: ROOT,
    messageThreadId: THREAD,
    triggerMessageId: TRIGGER,
    messageId: TRIGGER,
    authorId: 42,
    author: "Собеседник",
    text: "Synthetic human source",
    date: Math.floor(Date.now() / 1000),
    direct: false,
  };
  const last: DebateLine = {
    side: side === "hope" ? "avatar" : "hope",
    text: "Synthetic opposing reply",
    messageId: LAST_REPLY,
    authorId: side === "hope" ? 999 : 777,
    authorName: "Собеседник",
  };
  for (const message of [
    { messageId: ROOT, authorId: 42, authorName: "Собеседник", text: "Synthetic root" },
    { messageId: TRIGGER, authorId: 42, authorName: "Собеседник", text: target.text },
    {
      messageId: LAST_REPLY,
      authorId: last.authorId!,
      authorName: last.authorName!,
      text: last.text,
      side: last.side,
    },
  ])
    memory.observe({ ...message, chatId: CHAT, at: Date.now(), rootMessageId: ROOT });
  store.replyAllowance.activate(CHAT, TRIGGER);
  const observe = vi.spyOn(memory, "observe");
  const release = vi.spyOn(store.replyAllowance, "release");
  let exchange: Promise<DebateLine | null> | undefined;
  let draining: Promise<void> | undefined;
  const start = async () => {
    if (mode === "avatar unasked") turns.onText(CHAT, target);
    else exchange = speaker.speak({ chatId: CHAT, topic: target.text, ...target, lines: [last] });
    await vi.advanceTimersByTimeAsync(mode === "avatar unasked" ? CONFIG.AVATAR_QUIET_MS : 0);
  };
  const finish = async () => {
    confirm();
    await vi.advanceTimersByTimeAsync(0);
    if (exchange) return exchange;
    await (draining ?? turns.drain());
    return null;
  };
  const stop = () => {
    if (mode === "hope debate") memory.close();
    else if (mode === "avatar debate") active = false;
    else draining = turns.drain();
  };
  disposers.push(async () => {
    active = false;
    memory.close();
    releaseGeneration({ action: "silent", text: "" });
    confirm();
    await Promise.all([exchange, turns.drain()]);
    avatarStore.close();
    store.close();
  });
  return {
    side,
    stop,
    start,
    sends,
    memory,
    finish,
    history,
    avatarStore,
    observe,
    release,
    generate,
    listener,
    onFail,
    sendStarted,
    allowance: store.replyAllowance,
    releaseGeneration: () => releaseGeneration({ action: "reply", text: FINAL_TEXT }),
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-13T09:00:00Z"));
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(async () => {
  for (const dispose of disposers.splice(0)) await dispose();
  codex.mockReset();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("acknowledged replies outlive their automatic trigger", () => {
  it.each(MODES)("captures %s once after a newer trigger without continuing", async (mode) => {
    const fixture = setup(mode);
    const { epoch } = fixture.memory.status(CHAT);
    await fixture.start();
    await fixture.sendStarted;
    fixture.allowance.activate(CHAT, NEXT_TRIGGER);
    expect(await fixture.finish()).toBeNull();
    expect(fixture.memory.status(CHAT).epoch).toBe(epoch);
    expect(fixture.memory.message(CHAT, SENT)).not.toBeNull();
    expect(fixture.memory.message(CHAT, SENT)).toMatchObject({
      text: DELIVERED_TEXT,
      side: fixture.side,
      rootMessageId: ROOT,
      triggerMessageId: TRIGGER,
      messageThreadId: THREAD,
      replyToMessageId: ROOT,
    });
    expect(fixture.observe).toHaveBeenCalledOnce();
    expect(fixture.memory.status(CHAT).messages).toBe(4);
    if (fixture.side === "avatar")
      expect(fixture.history.recent(CHAT).filter((line) => line.messageId === SENT)).toEqual([
        expect.objectContaining({
          text: DELIVERED_TEXT,
          rootMessageId: ROOT,
          messageThreadId: THREAD,
          fromAvatar: true,
        }),
      ]);
    expect(fixture.sends).toHaveLength(1);
    expect(fixture.sends[0]).toMatchObject({
      text: `↪ Ответ Собеседник\n\n${DELIVERED_TEXT}`,
      message_thread_id: THREAD,
      reply_parameters: { message_id: ROOT, allow_sending_without_reply: false },
    });
    expect(fixture.generate).toHaveBeenCalledOnce();
    if (fixture.side === "avatar") expect(fixture.avatarStore.callsOn(CHAT, "2026-10-13")).toBe(1);
    expect(fixture.listener).not.toHaveBeenCalled();
    expect(fixture.onFail).not.toHaveBeenCalled();
    expect(fixture.release).not.toHaveBeenCalled();
    expect(fixture.allowance.claim(CHAT, TRIGGER, fixture.side)).toBe(false);
  });

  it.each(MODES)("rejects unsent stale generation for %s", async (mode) => {
    const fixture = setup(mode, true);
    await fixture.start();
    fixture.allowance.activate(CHAT, NEXT_TRIGGER);
    fixture.releaseGeneration();
    expect(await fixture.finish()).toBeNull();
    expect(fixture.sends).toHaveLength(0);
    expect(fixture.memory.message(CHAT, SENT)).toBeNull();
    expect(fixture.observe).not.toHaveBeenCalled();
    expect(fixture.history.recent(CHAT).some((line) => line.messageId === SENT)).toBe(false);
    expect(fixture.generate).toHaveBeenCalledOnce();
    expect(fixture.listener).not.toHaveBeenCalled();
    expect(fixture.onFail).not.toHaveBeenCalled();
    expect(fixture.release).toHaveBeenCalledOnce();
    expect(fixture.release).toHaveBeenCalledWith(CHAT, TRIGGER, fixture.side);
    expect(fixture.allowance.claim(CHAT, TRIGGER, fixture.side)).toBe(true);
  });

  it.each(MODES)("keeps cleared memory empty after %s acknowledges", async (mode) => {
    const fixture = setup(mode);
    const { epoch } = fixture.memory.status(CHAT);
    await fixture.start();
    await fixture.sendStarted;
    fixture.memory.clear(CHAT);
    fixture.history.forget(CHAT);
    expect(await fixture.finish()).toBeNull();
    expect(fixture.memory.status(CHAT).epoch).not.toBe(epoch);
    expect(fixture.memory.status(CHAT).messages).toBe(0);
    expect(fixture.memory.message(CHAT, SENT)).toBeNull();
    expect(fixture.observe).not.toHaveBeenCalled();
    expect(fixture.history.recent(CHAT)).toEqual([]);
    expect(fixture.history.lastAt(CHAT, "avatar")).toBeNull();
    expect(fixture.sends).toHaveLength(1);
    expect(fixture.generate).toHaveBeenCalledOnce();
    expect(fixture.listener).not.toHaveBeenCalled();
    expect(fixture.onFail).not.toHaveBeenCalled();
    expect(fixture.release).not.toHaveBeenCalled();
    expect(fixture.allowance.claim(CHAT, TRIGGER, fixture.side)).toBe(false);
  });

  it.each(MODES)("rejects capture after %s shuts down", async (mode) => {
    const fixture = setup(mode);
    await fixture.start();
    await fixture.sendStarted;
    fixture.stop();
    expect(await fixture.finish()).toBeNull();
    expect(fixture.memory.message(CHAT, SENT)).toBeNull();
    expect(fixture.observe).not.toHaveBeenCalled();
    expect(fixture.history.recent(CHAT).some((line) => line.messageId === SENT)).toBe(false);
    expect(fixture.history.lastAt(CHAT, "avatar")).toBeNull();
    expect(fixture.sends).toHaveLength(1);
    expect(fixture.generate).toHaveBeenCalledOnce();
    expect(fixture.listener).not.toHaveBeenCalled();
    expect(fixture.onFail).not.toHaveBeenCalled();
    expect(fixture.release).not.toHaveBeenCalled();
    expect(fixture.allowance.claim(CHAT, TRIGGER, fixture.side)).toBe(false);
  });
});
