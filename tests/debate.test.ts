import { it, vi, expect, describe, afterEach } from "vitest";

const { createDebates } = await import("../src/debate/index.js");

import type { Side, Debate, Speaker, DebateLine } from "../src/debate/index.js";

const CHAT = -100500;
let nextMessageId = 100;

/** A speaker that answers every turn with "<side> <n>", or as `reply` says. */
function fakeSpeaker(side: Side, reply?: (debate: Debate) => string | null) {
  const canSpeak = vi.fn(async (_chatId: number) => true);
  const speak = vi.fn(async (debate: Debate): Promise<DebateLine | null> => {
    const own = debate.lines.filter((l) => l.side === side).length;
    const text = reply ? reply(debate) : `${side} ${own + 1}`;
    return text === null ? null : { side, text, messageId: nextMessageId++ };
  });
  return { canSpeak, speak } satisfies Speaker;
}

type FakeSpeaker = ReturnType<typeof fakeSpeaker>;

function setup(options: { hope?: FakeSpeaker; avatar?: FakeSpeaker; cooldownMs?: number } = {}) {
  const hope = options.hope ?? fakeSpeaker("hope");
  const avatar = options.avatar ?? fakeSpeaker("avatar");
  const debates = createDebates({
    hope,
    avatar,
    turns: 3,
    pauseMs: 0,
    cooldownMs: options.cooldownMs ?? 600_000,
  });
  return { hope, avatar, debates };
}

const opener = (side: Side, text = `${side} 1`): DebateLine => ({ side, text, messageId: 1 });

/** The debate a speaker got last; the engine keeps adding lines to it, so this is the whole debate. */
const finalLines = (speaker: Speaker): string[] => {
  const { calls } = (speaker.speak as ReturnType<typeof vi.fn>).mock;
  const last = calls.at(-1)?.[0] as Debate | undefined;
  return last ? last.lines.map((l) => l.text) : [];
};

afterEach(() => {
  vi.useRealTimers();
});

describe("a debate", () => {
  it("alternates the sides, three replies each, opener included", async () => {
    const { hope, avatar, debates } = setup();
    debates.start(CHAT, opener("hope"), "пост про агентов");
    await debates.idle();
    expect(hope.speak).toHaveBeenCalledTimes(2);
    expect(avatar.speak).toHaveBeenCalledTimes(3);
    expect(finalLines(avatar)).toEqual([
      "hope 1",
      "avatar 1",
      "hope 2",
      "avatar 2",
      "hope 3",
      "avatar 3",
    ]);
  });

  it("passes the topic and the chat to the speakers", async () => {
    const { avatar, debates } = setup();
    debates.start(CHAT, opener("hope"), "пост про агентов");
    await debates.idle();
    const debate = avatar.speak.mock.calls[0]?.[0];
    expect(debate?.chatId).toBe(CHAT);
    expect(debate?.topic).toBe("пост про агентов");
  });

  it("ends when a side has no reply", async () => {
    const hope = fakeSpeaker("hope", () => null);
    const { avatar, debates } = setup({ hope });
    debates.start(CHAT, opener("avatar"), "вопрос");
    await debates.idle();
    expect(hope.speak).toHaveBeenCalledTimes(1);
    expect(avatar.speak).not.toHaveBeenCalled();
  });

  it("ends when either side can no longer speak, so Hope never answers into the void", async () => {
    const avatar = fakeSpeaker("avatar");
    avatar.canSpeak.mockResolvedValueOnce(true).mockResolvedValue(false);
    const { hope, debates } = setup({ avatar });
    debates.start(CHAT, opener("hope"), "пост");
    await debates.idle();
    expect(avatar.speak).toHaveBeenCalledTimes(1);
    expect(hope.speak).not.toHaveBeenCalled();
  });

  it("ends when a speaker throws, and keeps working", async () => {
    const hope = fakeSpeaker("hope");
    hope.speak.mockRejectedValueOnce(new Error("boom"));
    const { debates } = setup({ hope, cooldownMs: 1 });
    debates.start(CHAT, opener("avatar"), "вопрос");
    await debates.idle();
    expect(hope.speak).toHaveBeenCalledTimes(1);
  });
});

describe("how often debates start", () => {
  it("runs one debate per chat at a time", async () => {
    const { hope, debates } = setup();
    debates.start(CHAT, opener("avatar"), "первый");
    debates.start(CHAT, opener("avatar"), "второй");
    await debates.idle();
    const topics = hope.speak.mock.calls.map((c) => c[0].topic);
    expect(new Set(topics)).toEqual(new Set(["первый"]));
  });

  it("waits out the cooldown after a debate, then starts the next one", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(0);
    const { hope, debates } = setup({ cooldownMs: 600_000 });
    debates.start(CHAT, opener("avatar"), "первый");
    await debates.idle();
    expect(hope.speak).toHaveBeenCalledTimes(3);

    vi.setSystemTime(599_000);
    debates.start(CHAT, opener("avatar"), "рано");
    vi.setSystemTime(600_000);
    debates.start(CHAT, opener("avatar"), "вовремя");
    await debates.idle();
    const topics = hope.speak.mock.calls.map((c) => c[0].topic);
    expect(topics).not.toContain("рано");
    expect(topics).toContain("вовремя");
  });

  it("holds the cooldown after a failed reply, so a dead Codex is not asked again and again", async () => {
    const hope = fakeSpeaker("hope", () => null);
    const { debates } = setup({ hope });
    debates.start(CHAT, opener("avatar"), "первый");
    await debates.idle();
    debates.start(CHAT, opener("avatar"), "второй");
    await debates.idle();
    expect(hope.speak).toHaveBeenCalledTimes(1);
  });

  it("holds the cooldown after a debate nobody could join", async () => {
    const avatar = fakeSpeaker("avatar");
    avatar.canSpeak.mockResolvedValue(false);
    const { debates } = setup({ avatar });
    debates.start(CHAT, opener("hope"), "первый");
    await debates.idle();
    avatar.canSpeak.mockResolvedValue(true);
    debates.start(CHAT, opener("hope"), "второй");
    await debates.idle();
    expect(avatar.speak).not.toHaveBeenCalled();
  });

  it("runs debates in different chats side by side", async () => {
    const { hope, debates } = setup();
    debates.start(CHAT, opener("avatar"), "один");
    debates.start(CHAT - 1, opener("avatar"), "два");
    await debates.idle();
    expect(new Set(hope.speak.mock.calls.map((c) => c[0].chatId))).toEqual(
      new Set([CHAT, CHAT - 1]),
    );
  });
});

describe("shutdown", () => {
  it("stops right after a reply in flight, without starting a new pause", async () => {
    vi.useFakeTimers();
    let finish: (line: DebateLine) => void = () => {};
    const hope = fakeSpeaker("hope");
    hope.speak.mockImplementationOnce(
      () =>
        new Promise<DebateLine>((resolve) => {
          finish = resolve;
        }),
    );
    const avatar = fakeSpeaker("avatar");
    const debates = createDebates({ hope, avatar, turns: 3, pauseMs: 60_000, cooldownMs: 1 });
    debates.start(CHAT, opener("avatar"), "вопрос");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(hope.speak).toHaveBeenCalledOnce();
    let drained = false;
    void debates.drain().then(() => {
      drained = true;
    });
    finish({ side: "hope", text: "hope 1", messageId: 5 });
    await vi.advanceTimersByTimeAsync(0);
    expect(drained).toBe(true);
    expect(avatar.speak).not.toHaveBeenCalled();
  });

  it("stops a debate during its pause and starts no new one", async () => {
    const hope = fakeSpeaker("hope");
    const avatar = fakeSpeaker("avatar");
    const debates = createDebates({ hope, avatar, turns: 3, pauseMs: 60_000, cooldownMs: 1 });
    debates.start(CHAT, opener("hope"), "пост");
    const started = Date.now();
    await debates.drain();
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(avatar.speak).not.toHaveBeenCalled();
    debates.start(CHAT - 1, opener("hope"), "после остановки");
    await debates.drain();
    expect(avatar.speak).not.toHaveBeenCalled();
  });
});
