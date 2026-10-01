import { it, vi, expect, describe, afterEach } from "vitest";

vi.stubEnv("TELEGRAM_CHANNEL_ID", "@ai_first_news");
const assembleIssue = vi.fn();
vi.mock("../src/channelDigest/assembleIssue.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/channelDigest/assembleIssue.js")>();
  return { ...actual, assembleIssue: (...a: unknown[]) => assembleIssue(...a) };
});
const flags = vi.fn();
vi.mock("../src/blog/fetchAutoPublishFlags.js", () => ({
  fetchAutoPublishFlags: () => flags(),
}));

const { createBot } = await import("../src/bot/index.js");
const { CandidateStore } = await import("../src/store/index.js");
const { lastChannelIssue } = await import("../src/channelDigest/index.js");
import type { Update } from "grammy/types";

import { CandidateKind, ChannelRubric, CandidateState } from "../src/enums.js";

import type { AssembledIssue } from "../src/channelDigest/types.js";

const NOW = Date.parse("2026-10-01T08:00:00Z");
const SLOT = { key: "2026-10-01/morning", title: "AI за утро · 1 октября" };
const OWNER = 123456789;

/** Records every sendRichMessage (chat and html) in `log`, in order; every Bot API call answers ok. */
function telegram(log: string[] = [], rejectOwnerRich: string | null = null) {
  const rich: { chat: string; html: string }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit = {}) => {
      if (String(url).endsWith("/sendRichMessage")) {
        const form = init.body as FormData;
        if (rejectOwnerRich && String(form.get("chat_id")) === String(OWNER))
          return new Response(JSON.stringify({ ok: false, description: rejectOwnerRich }), {
            status: 400,
          });
        rich.push({
          chat: String(form.get("chat_id")),
          html: JSON.parse(String(form.get("rich_message"))).html,
        });
        log.push(`rich:${String(form.get("chat_id"))}`);
      }
      return new Response(JSON.stringify({ ok: true, result: { message_id: 500 } }), {
        status: 200,
      });
    }),
  );
  return rich;
}

function makeBot(store: InstanceType<typeof CandidateStore>, log: string[] = []) {
  const bundle = createBot(store, async () => {});
  const sent: { text: string; markup: string }[] = [];
  bundle.bot.api.config.use((_prev, method, payload) => {
    if (method === "sendMessage") {
      const p = payload as { text: string; reply_markup?: unknown };
      sent.push({ text: p.text, markup: JSON.stringify(p.reply_markup ?? null) });
      log.push("message");
    }
    return Promise.resolve({
      ok: true,
      result: method === "sendMessage" ? { message_id: 42 } : true,
    } as never);
  });
  bundle.bot.botInfo = {
    id: 1,
    is_bot: true,
    first_name: "Bot",
    username: "bot",
  } as typeof bundle.bot.botInfo;
  return { ...bundle, sent };
}

function tap(data: string, from = OWNER): Update {
  return {
    update_id: 1,
    callback_query: {
      id: "cbq-1",
      from: { id: from, is_bot: false, first_name: "Someone" },
      chat_instance: "ci",
      data,
      message: {
        message_id: 10,
        date: 0,
        chat: { id: OWNER, type: "private", first_name: "Owner" },
      },
    },
  } as Update;
}

function queued(store: InstanceType<typeof CandidateStore>): number[] {
  return [1, 2, 3].map(
    (n) =>
      store.channelQueue.add(
        {
          dedupKey: `tg:a/${n}`,
          url: `https://t.me/a/${n}`,
          title: "t",
          snippet: "s",
          html: "s",
          feedTitle: "@a",
          imageUrl: null,
          imageUrls: [],
          publishedAt: NOW,
          kind: CandidateKind.Channel,
        },
        1,
      )!,
  );
}

function issueFor(ids: number[], slot = SLOT): AssembledIssue {
  const items = ids.map((candidateId) => ({
    candidateId,
    channel: "@a",
    emoji: "🔥",
    rubric: ChannelRubric.Model,
    title: `Новость ${candidateId}`,
    html: "Текст.",
    photos: [],
    linkKeys: [],
  }));
  return {
    slot,
    article: { html: "<h3>AI за утро · 1 октября</h3>", photos: [], items },
    fallbackText: "<b>AI за утро · 1 октября</b>",
  };
}

function setup(channels: boolean, log: string[] = [], rejectOwnerRich: string | null = null) {
  vi.useFakeTimers({ toFake: ["Date"], now: NOW });
  const rich = telegram(log, rejectOwnerRich);
  const store = new CandidateStore(":memory:");
  const ids = queued(store);
  assembleIssue.mockResolvedValue({ assembled: issueFor(ids), picked: 3, written: 3 });
  flags.mockResolvedValue({ releases: false, news: false, channels });
  return { rich, store, ids, ...makeBot(store, log) };
}

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("channel digest flow", () => {
  it("publishes to the channel when autoPublishChannels is on, once per slot", async () => {
    const { rich, store, ids, runChannelIssue } = setup(true);

    await runChannelIssue(NOW);
    await runChannelIssue(NOW);

    expect(assembleIssue).toHaveBeenCalledTimes(1);
    expect(rich.map((r) => r.chat)).toEqual(["@ai_first_news"]);
    for (const id of ids) expect(store.get(id)!.state).toBe(CandidateState.Published);
    store.close();
  });

  it("spends no model call on a slot that already went out (duplicate fire, restart)", async () => {
    const { rich, store, runChannelIssue, sent } = setup(true);
    store.channelQueue.setLastSlot(SLOT.key);

    await runChannelIssue(NOW);

    expect(assembleIssue).not.toHaveBeenCalled();
    expect(flags).not.toHaveBeenCalled();
    expect(rich).toEqual([]);
    expect(sent).toEqual([]);
    store.close();
  });

  it("computes the slot once: the clock passing 15:00 while cards are written does not move the issue", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    const { rich, store, ids, runChannelIssue } = setup(true);
    assembleIssue.mockImplementation(async (_store: unknown, slot: typeof SLOT) => {
      vi.setSystemTime(Date.parse("2026-10-01T16:30:00Z"));
      return { assembled: issueFor(ids, slot), picked: 3, written: 3 };
    });

    await runChannelIssue();

    expect(assembleIssue.mock.calls[0]!.slice(1)).toEqual([SLOT, NOW]);
    expect(store.channelQueue.lastSlot()).toBe(SLOT.key);
    expect(lastChannelIssue()!.slot).toBe(SLOT.key);
    expect(rich).toHaveLength(1);
    store.close();
  });

  it("sends the article to the owner, then a separate message with ✅/❌; ✅ publishes it", async () => {
    const order: string[] = [];
    const { rich, store, ids, bot, runChannelIssue, sent } = setup(false, order);

    await runChannelIssue(NOW);

    expect(order).toEqual([`rich:${OWNER}`, "message"]);
    expect(rich[0]!.html).toBe(issueFor(ids).article.html);
    expect(sent.at(-1)?.text).toContain("Опубликовать в канале");
    expect(sent.at(-1)?.markup).toContain(`cdig_publish:${SLOT.key}`);
    expect(sent.at(-1)?.markup).toContain(`cdig_skip:${SLOT.key}`);
    expect(store.get(ids[0]!)!.state).toBe(CandidateState.DigestQueued);

    await bot.handleUpdate(tap(`cdig_publish:${SLOT.key}`));

    expect(rich.map((r) => r.chat)).toEqual([String(OWNER), "@ai_first_news"]);
    expect(rich[1]!.html).toBe(rich[0]!.html);
    expect(store.get(ids[0]!)!.state).toBe(CandidateState.Published);
    store.close();
  });

  it("tells the owner when Telegram rejected the article and the channel will get text", async () => {
    const { rich, store, runChannelIssue, sent } = setup(false, [], "RICH_MESSAGE_INVALID");

    await runChannelIssue(NOW);

    expect(rich).toEqual([]);
    expect(sent.at(-1)?.text).toContain(
      "⚠️ Telegram не принял статью (RICH_MESSAGE_INVALID), в канал уйдёт текстовая версия.",
    );
    expect(sent.at(-1)?.text).toContain("Опубликовать в канале");
    expect(sent.at(-1)?.markup).toContain(`cdig_publish:${SLOT.key}`);
    store.close();
  });

  it("does not add the rejection note when the article went through", async () => {
    const { store, runChannelIssue, sent } = setup(false);

    await runChannelIssue(NOW);

    expect(sent.at(-1)?.text).not.toContain("Telegram не принял");
    store.close();
  });

  it("refuses ✅ under a preview from an earlier slot, even one that is still pending", async () => {
    const { rich, store, ids, bot, runChannelIssue } = setup(false);
    await runChannelIssue(NOW);

    vi.setSystemTime(Date.parse("2026-10-01T13:00:00Z"));
    await bot.handleUpdate(tap(`cdig_publish:${SLOT.key}`));

    expect(rich.map((r) => r.chat)).toEqual([String(OWNER)]);
    expect(store.get(ids[0]!)!.state).toBe(CandidateState.DigestQueued);
    expect(store.channelQueue.lastSlot()).toBeNull();
    expect(lastChannelIssue()).toMatchObject({ slot: SLOT.key, outcome: "превью устарело" });
    store.close();
  });

  it("still publishes a preview of the current slot late in the same slot", async () => {
    const { rich, store, ids, bot, runChannelIssue } = setup(false);
    await runChannelIssue(NOW);

    vi.setSystemTime(Date.parse("2026-10-01T11:59:00Z"));
    await bot.handleUpdate(tap(`cdig_publish:${SLOT.key}`));

    expect(rich.map((r) => r.chat)).toEqual([String(OWNER), "@ai_first_news"]);
    expect(store.get(ids[0]!)!.state).toBe(CandidateState.Published);
    store.close();
  });

  it("a double tap on ✅ publishes once", async () => {
    const { rich, store, bot, runChannelIssue, sent } = setup(false);
    await runChannelIssue(NOW);

    await Promise.all([
      bot.handleUpdate(tap(`cdig_publish:${SLOT.key}`)),
      bot.handleUpdate(tap(`cdig_publish:${SLOT.key}`)),
    ]);

    expect(rich.filter((r) => r.chat === "@ai_first_news")).toHaveLength(1);
    expect(sent).toHaveLength(1);
    store.close();
  });

  it("❌ keeps the posts queued and sends nothing to the channel", async () => {
    const { rich, store, ids, bot, runChannelIssue } = setup(false);

    await runChannelIssue(NOW);
    await bot.handleUpdate(tap(`cdig_skip:${SLOT.key}`));
    await bot.handleUpdate(tap(`cdig_publish:${SLOT.key}`));

    expect(rich.map((r) => r.chat)).toEqual([String(OWNER)]);
    expect(store.get(ids[0]!)!.state).toBe(CandidateState.DigestQueued);
    store.close();
  });

  it("refuses a button under an older preview", async () => {
    const { rich, store, ids, bot, runChannelIssue } = setup(false);

    await runChannelIssue(NOW);
    await bot.handleUpdate(tap("cdig_publish:2026-09-30/evening"));

    expect(rich.map((r) => r.chat)).toEqual([String(OWNER)]);
    expect(store.get(ids[0]!)!.state).toBe(CandidateState.DigestQueued);
    store.close();
  });

  it("ignores a tap from anyone but the owner", async () => {
    const { rich, store, ids, bot, runChannelIssue } = setup(false);
    await runChannelIssue(NOW);

    await bot.handleUpdate(tap(`cdig_publish:${SLOT.key}`, 999));

    expect(rich.map((r) => r.chat)).toEqual([String(OWNER)]);
    expect(store.get(ids[0]!)!.state).toBe(CandidateState.DigestQueued);
    store.close();
  });

  it("does not write and preview the same slot twice while the first preview waits", async () => {
    const { rich, store, runChannelIssue } = setup(false);

    await runChannelIssue(NOW);
    await runChannelIssue(NOW);

    expect(assembleIssue).toHaveBeenCalledTimes(1);
    expect(rich).toHaveLength(1);
    store.close();
  });

  it("tells the owner once when fewer than 3 posts could be written", async () => {
    const rich = telegram();
    const store = new CandidateStore(":memory:");
    assembleIssue.mockResolvedValue({ assembled: null, picked: 4, written: 2 });
    const { runChannelIssue, sent } = makeBot(store);

    await runChannelIssue(NOW);

    expect(sent).toHaveLength(1);
    expect(sent[0]!.text).toContain("не собран");
    expect(sent[0]!.text).toContain("2 из 4");
    expect(rich).toEqual([]);
    expect(flags).not.toHaveBeenCalled();
    store.close();
  });

  it("stays silent for an empty queue", async () => {
    const rich = telegram();
    const store = new CandidateStore(":memory:");
    assembleIssue.mockResolvedValue({ assembled: null, picked: 0, written: 0 });
    const { runChannelIssue, sent } = makeBot(store);

    await runChannelIssue(NOW);

    expect(sent).toEqual([]);
    expect(rich).toEqual([]);
    expect(lastChannelIssue()).toMatchObject({ slot: SLOT.key, ok: true });
    store.close();
  });

  it("rethrows an assemble failure for the cron entry and shows it in /health", async () => {
    const store = new CandidateStore(":memory:");
    assembleIssue.mockRejectedValue(new Error("no card fits"));
    const { runChannelIssue, sent } = makeBot(store);

    await expect(runChannelIssue(NOW)).rejects.toThrow("no card fits");

    expect(lastChannelIssue()).toMatchObject({ slot: SLOT.key, ok: false });
    expect(lastChannelIssue()!.outcome).toContain("no card fits");
    expect(sent).toEqual([]);
    store.close();
  });
});
