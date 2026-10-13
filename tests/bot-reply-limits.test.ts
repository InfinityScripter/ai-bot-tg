import type { Update } from "grammy/types";

import { Bot } from "grammy";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync, mkdtempSync } from "node:fs";
import { it, vi, expect, describe, afterEach } from "vitest";

vi.mock("dotenv/config", () => ({}));
const runCodex = vi.fn();
vi.mock("../src/llm/runCodex.js", () => ({ runCodex: (...args: unknown[]) => runCodex(...args) }));

const CHAT = -1001234567890;
const ROOT = 600;
process.env.CHAT_REPLY_CHAT_ID = String(CHAT);

const { createChatReply } = await import("../src/chatReply/createChatReply.js");
const { createAvatar } = await import("../src/avatar/createAvatar.js");
const { createDebates } = await import("../src/debate/index.js");
const { CandidateStore } = await import("../src/store/index.js");
const { AvatarStore } = await import("../src/avatar/avatarStore.js");

import type { Side } from "../src/debate/index.js";

const disposers: (() => Promise<void>)[] = [];
const response = '{"action":"reply","text":"Проверим на одинаковых задачах."}';

function setup(path = ":memory:", failSend = false) {
  const store = new CandidateStore(path);
  const avatarStore = new AvatarStore(":memory:");
  avatarStore.allowChat(CHAT, "Synthetic discussion");
  avatarStore.setProfile("Synthetic profile");
  avatarStore.replaceChunks([{ title: "Task", url: "https://example.com", body: "Task" }]);
  const hopeBot = new Bot("test:hope");
  const avatarBot = new Bot("test:avatar");
  const sent: { side: Side; payload: Record<string, unknown> }[] = [];
  for (const [bot, side, id] of [
    [hopeBot, "hope", 777],
    [avatarBot, "avatar", 999],
  ] as const) {
    bot.botInfo = {
      id,
      is_bot: true,
      first_name: side,
      username: `${side}_bot`,
    } as typeof bot.botInfo;
    bot.api.config.use((_previous, method, payload) => {
      if (method === "sendChatAction") return Promise.resolve({ ok: true, result: true } as never);
      if (method !== "sendMessage") throw new Error(`Unexpected synthetic API call: ${method}`);
      sent.push({ side, payload: payload as Record<string, unknown> });
      if (failSend) return Promise.reject(new Error("Synthetic unknown Telegram result"));
      return Promise.resolve({
        ok: true,
        result: { message_id: 700 + sent.length, date: 0, chat: { id: CHAT, type: "supergroup" } },
      } as never);
    });
  }
  // Deliberately no ConversationMemory: the allowance must protect every group.
  const hope = createChatReply(hopeBot, store);
  const avatar = createAvatar(avatarBot, store, { avatarStore });
  hopeBot.use(hope.middleware);
  avatarBot.use(avatar.middleware);
  const onEnded = vi.fn();
  const debates = createDebates({
    hope: hope.hope.speaker,
    avatar: avatar.speaker,
    turns: 10,
    pauseMs: 0,
    cooldownMs: 600_000,
    onEnded,
  });
  hope.hope.onReply(debates.start);
  avatar.onReply(debates.start);
  const close = async () => {
    await debates.drain();
    await hope.drain();
    await avatar.drainAndClose();
    store.close();
  };
  disposers.push(close);
  async function deliver(id: number, sides: Side[] = ["hope", "avatar"]) {
    const update: Update = {
      update_id: id,
      message: {
        message_id: id,
        message_thread_id: ROOT,
        date: 0,
        text: "@hope_bot @avatar_bot Как проверим агента?",
        entities: [
          { type: "mention", offset: 0, length: 9 },
          { type: "mention", offset: 10, length: 11 },
        ],
        from: { id: 42, is_bot: false, first_name: "Аня" },
        chat: { id: CHAT, type: "supergroup", title: "Synthetic discussion" },
        reply_to_message: {
          reply_to_message: undefined,
          message_id: ROOT,
          date: 0,
          text: "Synthetic post",
          is_automatic_forward: true,
          chat: { id: CHAT, type: "supergroup", title: "Synthetic discussion" },
        },
      },
    };
    await Promise.all(
      sides.map((side) => (side === "hope" ? hopeBot : avatarBot).handleUpdate(update)),
    );
  }
  return { deliver, sent, debates, onEnded, hope, avatar, close };
}

afterEach(async () => {
  for (const dispose of disposers.splice(0)) await dispose();
  runCodex.mockReset();
  vi.restoreAllMocks();
});

describe("persistent shared replies through both actual bot middlewares", () => {
  it("refuses a continuation without the original human trigger", async () => {
    runCodex.mockResolvedValue(response);
    const fixture = setup();
    const debate = {
      chatId: CHAT,
      rootMessageId: ROOT,
      topic: "A bot reply cannot create a new human allowance",
      lines: [{ side: "avatar" as const, text: "Bot line", messageId: 700 }],
    };
    expect(await fixture.hope.hope.speaker.speak(debate)).toBeNull();
    expect(
      await fixture.avatar.speaker.speak({
        ...debate,
        lines: [{ ...debate.lines[0]!, side: "hope" }],
      }),
    ).toBeNull();
    expect(fixture.sent).toHaveLength(0);
    expect(runCodex).not.toHaveBeenCalled();
  });

  it("cancels an old automatic generation before send and allows the new counterpart", async () => {
    let releaseOld: ((text: string) => void) | undefined;
    runCodex.mockImplementation((prompt: string) => {
      if (prompt.includes("Ты — @hope_bot,") && !prompt.includes("Ты редактор") && !releaseOld) {
        return new Promise<string>((resolve) => {
          releaseOld = resolve;
        });
      }
      return response;
    });
    const fixture = setup();
    await fixture.deliver(650, ["avatar"]);
    await vi.waitFor(() => expect(releaseOld).toBeTypeOf("function"));
    await fixture.deliver(651, ["avatar"]);
    await vi.waitFor(() =>
      expect(fixture.sent.filter((line) => line.side === "avatar")).toHaveLength(2),
    );
    releaseOld!(response);
    await fixture.debates.idle();
    expect(fixture.sent.map((line) => line.side)).toEqual(["avatar", "avatar", "hope"]);
    expect(fixture.sent[2]?.payload.entities).toEqual([
      expect.objectContaining({ url: "https://t.me/c/1234567890/702" }),
    ]);
  });

  it.each(["hope", "avatar"] as const)(
    "releases unused %s allowance after model silence",
    async (side) => {
      runCodex.mockResolvedValue('{"action":"silent","text":""}');
      const fixture = setup();
      await fixture.deliver(650, [side]);
      await fixture.hope.drain();
      await vi.waitFor(() => expect(runCodex).toHaveBeenCalledOnce());
      expect(fixture.sent).toHaveLength(0);
      runCodex.mockResolvedValue(response);
      await fixture.deliver(650, [side]);
      await vi.waitFor(() => expect(fixture.sent.length).toBeGreaterThanOrEqual(2));
      await fixture.debates.idle();
      expect(fixture.sent).toHaveLength(2);
    },
  );

  it("keeps both claims after an unknown Telegram result instead of retrying", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    runCodex.mockResolvedValue(response);
    const fixture = setup(":memory:", true);
    await fixture.deliver(650);
    await vi.waitFor(() => expect(fixture.sent).toHaveLength(2));
    await fixture.hope.drain();
    await fixture.deliver(650);
    await fixture.hope.drain();
    expect(fixture.sent).toHaveLength(2);
    expect(runCodex).toHaveBeenCalledTimes(4);
  });

  it.each(["hope", "avatar"] as const)(
    "uses one allowance per side when the %s generation finishes first",
    async (first) => {
      const finish = new Map<Side, (text: string) => void>();
      runCodex.mockImplementation((prompt: string) => {
        if (prompt.includes("Ты редактор готовой разговорной реплики.")) return response;
        const side = prompt.includes("Ты — @hope_bot,") ? "hope" : "avatar";
        if (finish.has(side)) return response;
        return new Promise<string>((resolve) => finish.set(side, resolve));
      });
      const fixture = setup();
      await fixture.deliver(650);
      await vi.waitFor(() => expect(finish.size).toBe(2));
      finish.get(first)!(response);
      await vi.waitFor(() => expect(fixture.sent.some((line) => line.side === first)).toBe(true));
      finish.get(first === "hope" ? "avatar" : "hope")!(response);
      await vi.waitFor(() => expect(fixture.sent.length).toBeGreaterThanOrEqual(2));
      await fixture.hope.drain();
      await fixture.debates.idle();
      expect(fixture.sent.map((line) => line.side)).toEqual([
        first,
        first === "hope" ? "avatar" : "hope",
      ]);
      runCodex.mockResolvedValue(response);
      await fixture.deliver(650);
      await fixture.hope.drain();
      await fixture.debates.idle();
      expect(fixture.sent).toHaveLength(2);
      expect(runCodex).toHaveBeenCalledTimes(4);
    },
  );

  it("answers the next human in the same post before the previous cooldown expires", async () => {
    runCodex.mockResolvedValue(response);
    const fixture = setup();
    await fixture.deliver(650, ["avatar"]);
    await vi.waitFor(() => expect(fixture.onEnded).toHaveBeenCalledOnce());
    await fixture.debates.idle();
    await fixture.deliver(651, ["hope"]);
    await fixture.hope.drain();
    await fixture.debates.idle();
    expect(fixture.sent.map((line) => line.side)).toEqual(["avatar", "hope", "hope", "avatar"]);
    expect(
      fixture.sent.every(
        (line) => (line.payload.reply_parameters as { message_id: number }).message_id === ROOT,
      ),
    ).toBe(true);
  });

  it("does not reopen either allowance after SQLite and both bots reopen", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bot-reply-limits-"));
    const path = join(dir, "claims.sqlite");
    runCodex.mockResolvedValue(response);
    const before = setup(path);
    await before.deliver(650);
    await vi.waitFor(() => expect(before.sent.length).toBeGreaterThanOrEqual(2));
    await before.close();
    disposers.splice(disposers.indexOf(before.close), 1);
    const reopened = setup(path);
    await reopened.deliver(650);
    await reopened.hope.drain();
    await reopened.debates.idle();
    expect(reopened.sent).toHaveLength(0);
    await reopened.close();
    disposers.splice(disposers.indexOf(reopened.close), 1);
    rmSync(dir, { recursive: true, force: true });
  });
});
