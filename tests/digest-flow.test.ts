import { it, vi, expect, describe, afterEach } from "vitest";

// Stub the two blog calls the digest flow makes: fetchRecentPosts (so no
// network is needed to build a digest) and sendDigest (so we can observe
// whether the send actually fired). PublishError and everything else stay real.
const fetchRecentPosts = vi.fn();
const sendDigest = vi.fn();
vi.mock("../src/blog/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/blog/index.js")>();
  return {
    ...actual,
    fetchRecentPosts: (...a: unknown[]) => fetchRecentPosts(...a),
    sendDigest: (...a: unknown[]) => sendDigest(...a),
  };
});

const { createBot } = await import("../src/bot/index.js");
const { CandidateStore } = await import("../src/store/index.js");
import type { Update } from "grammy/types";

import { CandidateState } from "../src/enums.js";

import type { RecentPost } from "../src/blog/fetchRecentPosts.js";

const OWNER_ID = 123456789; // matches setup.ts OWNER_TELEGRAM_ID

const POSTS: RecentPost[] = [
  { id: "1", title: "GPT-5 вышла", description: "Крупный релиз.", createdAt: "2026-06-30" },
];

/**
 * A bot whose outgoing API calls are captured. Uses the store's mock provider
 * override so buildDigest emits the placeholder digest with no LLM call. Returns
 * the sends/edits/answers seen, plus the store for state assertions.
 */
function makeBot() {
  const store = new CandidateStore(":memory:");
  store.setMockOverride(true); // → mock digest containing {{ВЕРДИКТ}}
  const sends: string[] = [];
  const edits: string[] = [];
  const answers: string[] = [];
  const { bot } = createBot(store, async () => {});
  bot.api.config.use((_prev, method, payload) => {
    if (method === "sendMessage") sends.push((payload as { text: string }).text);
    if (method === "editMessageText") edits.push((payload as { text: string }).text);
    if (method === "answerCallbackQuery") {
      const { text } = payload as { text?: string };
      if (text) answers.push(text);
    }
    return Promise.resolve({ ok: true, result: { message_id: 99 } } as never);
  });
  return { bot, store, sends, edits, answers };
}

function callbackUpdate(data: string, updateId = 1): Update {
  return {
    update_id: updateId,
    callback_query: {
      id: `cbq-${updateId}`,
      from: { id: OWNER_ID, is_bot: false, first_name: "Owner" },
      chat_instance: "ci",
      data,
      message: {
        message_id: 10,
        date: 0,
        chat: { id: OWNER_ID, type: "private", first_name: "Owner" },
      },
    },
  } as Update;
}

function messageUpdate(text: string, updateId = 2): Update {
  // A "/cmd" message needs a bot_command entity for grammy's bot.command() to
  // route it; plain text needs none (it flows to the message:text handler).
  const entities = text.startsWith("/")
    ? [{ type: "bot_command", offset: 0, length: text.split(/\s/)[0]!.length }]
    : undefined;
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      date: 0,
      text,
      entities,
      from: { id: OWNER_ID, is_bot: false, first_name: "Owner" },
      chat: { id: OWNER_ID, type: "private", first_name: "Owner" },
    },
  } as Update;
}

afterEach(() => {
  vi.restoreAllMocks();
  fetchRecentPosts.mockReset();
  sendDigest.mockReset();
});

describe("digest verdict-edit flow", () => {
  it("refuses to send while {{ВЕРДИКТ}} is unfilled, and keeps the draft", async () => {
    fetchRecentPosts.mockResolvedValue(POSTS);
    sendDigest.mockResolvedValue({ sent: 5, failed: 0 });
    const { bot, answers } = makeBot();
    await bot.init();

    await bot.handleUpdate(messageUpdate("/digest")); // builds the placeholder digest
    await bot.handleUpdate(callbackUpdate("digest_send")); // ✅ Отправить

    // The send was blocked by the safety gate and the owner was told why.
    expect(sendDigest).not.toHaveBeenCalled();
    expect(answers.some((t) => t.includes("Сначала добавьте вердикт"))).toBe(true);
  });

  it("✍️ Вердикт → owner text fills the slot; then ✅ sends the filled html", async () => {
    fetchRecentPosts.mockResolvedValue(POSTS);
    sendDigest.mockResolvedValue({ sent: 5, failed: 0 });
    const { bot, sends } = makeBot();
    await bot.init();

    await bot.handleUpdate(messageUpdate("/digest"));
    await bot.handleUpdate(callbackUpdate("digest_verdict")); // arm verdict capture
    await bot.handleUpdate(messageUpdate("Неделя выдалась жаркой.")); // the verdict text
    await bot.handleUpdate(callbackUpdate("digest_send")); // ✅ Отправить

    expect(sendDigest).toHaveBeenCalledTimes(1);
    const html = sendDigest.mock.calls[0]![1] as string;
    expect(html).not.toContain("{{ВЕРДИКТ}}");
    expect(html).toContain("Неделя выдалась жаркой.");
    // The re-rendered preview reflected the verdict, not the placeholder.
    expect(sends.some((t) => t.includes("Неделя выдалась жаркой."))).toBe(true);
  });

  it("verdict text is NOT ingested as a candidate article", async () => {
    fetchRecentPosts.mockResolvedValue(POSTS);
    const { bot, store } = makeBot();
    await bot.init();

    await bot.handleUpdate(messageUpdate("/digest"));
    await bot.handleUpdate(callbackUpdate("digest_verdict"));
    await bot.handleUpdate(messageUpdate("Итоги недели."));

    // No candidate was created from the verdict message.
    expect(store.listByState(CandidateState.Collected)).toHaveLength(0);
  });

  it("a normal text (not awaiting verdict) still ingests as a candidate", async () => {
    fetchRecentPosts.mockResolvedValue(POSTS);
    const { bot, store } = makeBot();
    await bot.init();

    // No /digest, no ✍️ Вердикт → this is a normal manual-ingest message.
    await bot.handleUpdate(messageUpdate("Новость про ИИ.\n\nТело новости."));

    expect(store.listByState(CandidateState.Collected)).toHaveLength(1);
  });
});
