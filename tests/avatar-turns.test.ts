import { it, vi, expect, describe, afterEach } from "vitest";

const { isDirect } = await import("../src/avatar/isDirect.js");
const { replyGate } = await import("../src/avatar/replyGate.js");
const { ChatHistory } = await import("../src/avatar/chatHistory.js");
const { QuietTimers } = await import("../src/avatar/quietTimers.js");

import type { Message, UserFromGetMe } from "grammy/types";

import type { ChatLine } from "../src/avatar/types.js";
import type { GateInput } from "../src/avatar/replyGate.js";

const ME = { id: 999, is_bot: true, first_name: "A", username: "Avatar_Bot" } as UserFromGetMe;

const line = (authorId: number, at: number, fromAvatar = false): ChatLine => ({
  messageId: at,
  authorId,
  author: "x",
  text: "t",
  at,
  fromAvatar,
});

afterEach(() => vi.useRealTimers());

describe("ChatHistory", () => {
  it("keeps the last 40 lines per chat", () => {
    const h = new ChatHistory();
    for (let i = 1; i <= 45; i++) h.push(-1, line(7, i));
    expect(h.recent(-1)).toHaveLength(40);
    expect(h.recent(-1)[0]?.at).toBe(6);
    expect(h.recent(-2)).toEqual([]);
  });

  it("remembers stamps beyond the 40-line window and forgets the chat whole", () => {
    const h = new ChatHistory();
    h.stamp(-1, "avatar", 5);
    for (let i = 1; i <= 50; i++) h.push(-1, line(7, i));
    expect(h.lastAt(-1, "avatar")).toBe(5);
    expect(h.lastAt(-1, "owner")).toBeNull();
    h.forget(-1);
    expect(h.recent(-1)).toEqual([]);
    expect(h.lastAt(-1, "avatar")).toBeNull();
  });
});

describe("isDirect", () => {
  const msg = (extra: Partial<Message>) => ({ message_id: 1, date: 0, ...extra }) as Message;

  it("is true for a reply to the avatar", () => {
    expect(
      isDirect(
        msg({
          text: "да",
          reply_to_message: { from: ME } as unknown as NonNullable<Message["reply_to_message"]>,
        }),
        ME,
      ),
    ).toBe(true);
  });

  it("is true for an @mention, case-insensitive", () => {
    const text = "эй @avatar_bot что думаешь?";
    const m = msg({ text, entities: [{ type: "mention", offset: 3, length: 11 }] });
    expect(isDirect(m, ME)).toBe(true);
  });

  it("is false for a mention of someone else and for plain text", () => {
    const m = msg({ text: "@other_bot", entities: [{ type: "mention", offset: 0, length: 10 }] });
    expect(isDirect(m, ME)).toBe(false);
    expect(isDirect(msg({ text: "просто текст" }), ME)).toBe(false);
  });
});

describe("replyGate", () => {
  const limits = { dailyCalls: 4, cooldownMs: 600_000 };
  const base: GateInput = {
    direct: false,
    now: 1_000_000,
    callsToday: 0,
    lastAvatarAt: null,
    lastUnaskedAt: null,
    lastOwnerAt: null,
    limits,
  };

  it.each([
    ["unasked, quiet chat", {}, { call: true }],
    [
      "daily cap beats a mention",
      { direct: true, callsToday: 4 },
      { call: false, reason: "daily_cap" },
    ],
    ["a mention may use the second half", { direct: true, callsToday: 3 }, { call: true }],
    ["unasked turns get only half", { callsToday: 2 }, { call: false, reason: "unasked_cap" }],
    ["a mention ignores cooldown", { direct: true, lastAvatarAt: 999_000 }, { call: true }],
    ["a mention ignores the owner", { direct: true, lastOwnerAt: 999_000 }, { call: true }],
    ["owner wrote recently", { lastOwnerAt: 900_000 }, { call: false, reason: "owner_active" }],
    ["avatar spoke recently", { lastAvatarAt: 900_000 }, { call: false, reason: "cooldown" }],
    [
      "a silent unasked turn also starts the cooldown",
      { lastUnaskedAt: 900_000 },
      { call: false, reason: "cooldown" },
    ],
    ["avatar spoke long ago", { lastAvatarAt: 1, lastUnaskedAt: 2 }, { call: true }],
  ])("%s", (_name, patch, expected) => {
    expect(replyGate({ ...base, ...patch })).toEqual(expected);
  });
});

describe("QuietTimers", () => {
  it("fires once per pause, per chat, and can be cancelled", () => {
    vi.useFakeTimers();
    const timers = new QuietTimers(1000);
    const a = vi.fn();
    const b = vi.fn();
    timers.bump(-1, a);
    vi.advanceTimersByTime(900);
    timers.bump(-1, a);
    timers.bump(-2, b);
    vi.advanceTimersByTime(900);
    expect(a).not.toHaveBeenCalled();
    timers.cancel(-2);
    vi.advanceTimersByTime(200);
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).not.toHaveBeenCalled();
    timers.bump(-3, b);
    timers.stopAll();
    vi.advanceTimersByTime(5000);
    expect(b).not.toHaveBeenCalled();
  });
});
