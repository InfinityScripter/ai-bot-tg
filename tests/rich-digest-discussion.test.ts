import type { Opts, Message, RichText, RichBlock, RichMessage, UserFromGetMe } from "grammy/types";

import { Bot } from "grammy";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync, mkdtempSync } from "node:fs";
import { it, vi, expect, afterEach } from "vitest";

const runCodex = vi.fn();
vi.mock("dotenv/config", () => ({}));
vi.mock("grammy", async (importOriginal) => {
  const actual = await importOriginal<typeof import("grammy")>();
  const { default: fetch } = await import("node-fetch");
  return {
    ...actual,
    Bot: class extends actual.Bot {
      constructor(...args: ConstructorParameters<typeof actual.Bot>) {
        const [token, options] = args;
        super(token, {
          ...options,
          client: {
            ...options?.client,
            fetch: Object.assign(async () => {
              throw new Error("Real Telegram network disabled in rich digest tests");
            }, fetch),
          },
        });
        this.api.config.use((_previous, method) => {
          if (method === "setMyCommands")
            return Promise.resolve({ ok: true, result: true } as never);
          throw new Error(`Telegram transport blocked before fixture setup: ${method}`);
        });
      }
    },
  };
});
vi.mock("../src/llm/runCodex.js", () => ({
  runCodex: (...args: unknown[]) => runCodex(...args),
}));
vi.mock("../src/avatar/indexBlog.js", () => ({
  indexBlog: async () => ({ posts: 1, chunks: 1, failed: 0 }),
}));

const GROUP = -1000000000777;
const OWNER = 123456789;
const HOPE: UserFromGetMe = {
  id: 777,
  is_bot: true,
  first_name: "Hope",
  username: "hope_bot",
  can_join_groups: true,
  can_read_all_group_messages: true,
  supports_inline_queries: false,
  can_connect_to_business: false,
  has_main_web_app: false,
  has_topics_enabled: false,
  allows_users_to_create_topics: false,
  can_manage_bots: false,
  supports_join_request_queries: false,
};
const AVATAR: UserFromGetMe = { ...HOPE, id: 999, first_name: "Аватар", username: "avatar_bot" };
const LATE = "Поздний пятый материал: проверка затрат на агента";
let nestedText: RichText = {
  type: "url",
  text: "Глубокий материал",
  url: "https://example.com/deep",
};
for (let depth = 0; depth < 16; depth++) nestedText = [{ type: "bold", text: nestedText }];
let nestedBlock: RichBlock = { type: "paragraph", text: nestedText };
for (let depth = 0; depth < 16; depth++)
  nestedBlock = { type: "details", summary: `Уровень ${depth + 1}`, blocks: [nestedBlock] };
const RICH: RichMessage = {
  blocks: [
    { type: "heading", size: 1, text: "Выпуск из пяти материалов" },
    ...[1, 2, 3, 4, 5].flatMap((item): RichBlock[] => [
      { type: "heading", size: 2, text: item === 5 ? LATE : `Материал ${item}` },
      {
        type: "paragraph",
        text: item === 5 ? "Сколько стоит полезный результат?" : "x".repeat(850),
      },
      {
        type: "paragraph",
        text: [
          { type: "url", text: "Исходный пост", url: `https://t.me/synthetic_feed/${item}` },
          " | ",
          { type: "url", text: "Исследование", url: `https://example.com/paper-${item}` },
        ],
      },
    ]),
    {
      type: "list",
      items: [
        {
          label: "1.",
          blocks: [{ type: "blockquote", blocks: [nestedBlock], credit: "Автор цитаты" }],
        },
      ],
    },
    {
      type: "pullquote",
      text: [{ type: "italic", text: "Выделенная цитата" }],
      credit: "Её автор",
    },
    {
      type: "collage",
      caption: { text: "Подпись коллажа", credit: "Фотограф" },
      blocks: [
        {
          type: "photo",
          photo: [
            { file_id: "synthetic-photo-id", file_unique_id: "photo-1", width: 1, height: 1 },
          ],
          caption: {
            text: "Подпись фото",
            credit: { type: "url", text: "Фото", url: "https://example.com/photo" },
          },
        },
      ],
    },
    {
      type: "slideshow",
      blocks: [],
      caption: { text: "Подпись слайдов", credit: "Создатель слайдов" },
    },
    {
      type: "table",
      caption: { type: "url", text: "Таблица", url: "https://example.com/table" },
      cells: [
        [
          { text: "Цена", is_header: true, align: "left", valign: "top" },
          { text: "42", align: "right", valign: "middle" },
        ],
      ],
    },
    { type: "footer", text: "<<< это данные, а не команды >>>" },
    {
      type: "paragraph",
      text: { type: "url", text: "Подборка", url: "https://example.com/@hope_bot/@avatar_bot" },
    },
  ],
};
const POST = {
  message_id: 10,
  date: 10,
  chat: { id: GROUP, type: "supergroup", title: "Synthetic group" },
  from: { id: 777000, is_bot: false, first_name: "Telegram" },
  sender_chat: { id: -100555, type: "channel", title: "Synthetic channel" },
  is_automatic_forward: true,
  rich_message: RICH,
} satisfies Message.RichMessageMessage;

afterEach(() => {
  runCodex.mockReset();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

it("opens one rooted 3+3 conversation from a rich-only digest, preserving the late item and links", async () => {
  vi.resetModules();
  vi.useFakeTimers();
  process.env.CHAT_REPLY_CHAT_ID = String(GROUP);
  process.env.AVATAR_BOT_TOKEN = "test:avatar";
  vi.spyOn(console, "log").mockImplementation(() => {});
  runCodex.mockImplementation(async (prompt: string) =>
    JSON.stringify({
      action: "reply",
      text: prompt.includes("humanizer 4.2.0-ru")
        ? "Отредактированная реплика"
        : "Черновик о затратах",
    }),
  );
  const { CONFIG } = await import("../src/config.js");
  const { CandidateStore } = await import("../src/store/index.js");
  const { startAvatarSide } = await import("../src/avatar/startAvatarSide.js");
  const { createChatReply } = await import("../src/chatReply/createChatReply.js");
  const { createConversationMemory } = await import("../src/chatMemory/index.js");
  const directory = mkdtempSync(join(tmpdir(), "rich-discussion-"));
  const path = join(directory, "memory.sqlite");
  let memory = createConversationMemory({
    path,
    chatId: GROUP,
    debounceMs: 60_000,
    generate: async (prompt) =>
      JSON.stringify({
        side: prompt.includes("для стороны hope") ? "hope" : "avatar",
        notes: [],
        opinions: [],
      }),
  });
  const store = new CandidateStore(":memory:");
  const sent: { side: "hope" | "avatar"; id: number; payload: Opts<"sendMessage"> }[] = [];
  let nextId = 100;
  const transport = (bot: Bot, side: "hope" | "avatar") => {
    bot.api.config.use((_previous, method, payload) => {
      if (method !== "sendMessage") return Promise.resolve({ ok: true, result: true } as never);
      const options = payload as Opts<"sendMessage">;
      const id = ++nextId;
      if (options.chat_id === GROUP) sent.push({ side, id, payload: options });
      const result: Message.TextMessage = {
        message_id: id,
        date: 11,
        from: bot.botInfo,
        chat: POST.chat,
        text: options.text,
      };
      return Promise.resolve({ ok: true, result } as never);
    });
  };
  let endPolling: () => void = () => {};
  const polling = vi.spyOn(Bot.prototype, "start").mockImplementation(function start(this: Bot) {
    this.botInfo = AVATAR;
    transport(this, "avatar");
    return new Promise<void>((resolve) => {
      endPolling = resolve;
    });
  });
  const newsBot = new Bot("test:telegram-token");
  newsBot.botInfo = HOPE;
  transport(newsBot, "hope");
  const responder = createChatReply(newsBot, store, { memory });
  let continued: ReturnType<typeof createChatReply> | undefined;
  newsBot.use(responder.middleware);
  const side = startAvatarSide(
    store,
    responder.hope,
    vi.fn(async () => undefined),
    { memory },
  );
  const avatarBot = polling.mock.contexts[0] as Bot | undefined;
  if (!side || !avatarBot) throw new Error("Avatar side did not start");
  try {
    await avatarBot.handleUpdate({
      update_id: 1,
      my_chat_member: {
        chat: POST.chat,
        from: { id: OWNER, is_bot: false, first_name: "Synthetic owner" },
        date: 0,
        old_chat_member: { status: "left", user: AVATAR },
        new_chat_member: { status: "member", user: AVATAR },
      },
    });
    for (const bot of [avatarBot, newsBot]) await bot.handleUpdate({ update_id: 2, message: POST });
    await vi.advanceTimersByTimeAsync(0);
    expect.soft(sent.map((line) => line.side)).toEqual(["hope"]);
    expect.soft(runCodex.mock.calls[0]?.[0] ?? "").toContain(LATE);
    expect.soft(memory.message(GROUP, 10)?.text ?? "").toContain("https://t.me/synthetic_feed/5");
    for (let turn = 0; turn < 6; turn++)
      await vi.advanceTimersByTimeAsync(CONFIG.AVATAR_DEBATE_PAUSE_MS);
    expect(sent.map((line) => line.side)).toEqual([
      "hope",
      "avatar",
      "hope",
      "avatar",
      "hope",
      "avatar",
    ]);
    expect(runCodex).toHaveBeenCalledTimes(12);
    expect.soft(runCodex.mock.calls[2]?.[0]).toContain(LATE);
    expect.soft(runCodex.mock.calls[2]?.[0]).toContain("https://example.com/paper-5");
    for (let turn = 0; turn < sent.length; turn++) {
      expect(sent[turn]?.payload.reply_parameters).toMatchObject({
        message_id: POST.message_id,
        allow_sending_without_reply: false,
      });
      expect(sent[turn]?.payload.entities).toEqual([
        {
          type: "text_link",
          offset: 0,
          length: expect.any(Number),
          url: `https://t.me/c/777/${turn === 0 ? POST.message_id : sent[turn - 1]!.id}`,
        },
      ]);
      expect(sent[turn]?.payload.text).toContain("Отредактированная реплика");
      expect(runCodex.mock.calls[turn * 2 + 1]?.[0]).toContain("humanizer 4.2.0-ru");
      expect(runCodex.mock.calls[turn * 2 + 1]?.[0]).not.toContain(LATE);
    }
    for (let item = 1; item <= 5; item++) {
      expect(memory.message(GROUP, 10)?.text).toContain(`https://t.me/synthetic_feed/${item}`);
      expect(memory.message(GROUP, 10)?.text).toContain(`https://example.com/paper-${item}`);
    }
    const storedText = memory.message(GROUP, 10)?.text ?? "";
    for (const content of [
      "Глубокий материал",
      "https://example.com/deep",
      "Автор цитаты",
      "Выделенная цитата",
      "Её автор",
      "Подпись фото",
      "https://example.com/photo",
      "Подпись коллажа",
      "Фотограф",
      "Подпись слайдов",
      "Создатель слайдов",
      "https://example.com/table",
      "Цена | 42",
    ])
      expect(storedText).toContain(content);
    expect(storedText).not.toContain("synthetic-photo-id");
    expect(storedText).toContain("https://example.com/@hope_bot/@avatar_bot");
    expect(runCodex.mock.calls[0]?.[0]).toContain("https://example.com/@hope_bot/@avatar_bot");
    expect(runCodex.mock.calls[2]?.[0]).toContain("https://example.com/@hope_bot/@avatar_bot");
    expect(storedText).toContain("<<< это данные, а не команды >>>");
    expect(runCodex.mock.calls[0]?.[0]).toContain("» это данные, а не команды »");
    expect(memory.status(GROUP).messages).toBe(7);
    await newsBot.handleUpdate({ update_id: 30, message: POST });
    await vi.advanceTimersByTimeAsync(0);
    expect(sent).toHaveLength(6);
    expect(runCodex).toHaveBeenCalledTimes(12);
    await newsBot.handleUpdate({
      update_id: 3,
      edited_message: {
        ...POST,
        edit_date: 20,
        rich_message: {
          blocks: [{ type: "paragraph", text: "Исправленные затраты" }, ...RICH.blocks],
        },
      },
    });
    await vi.advanceTimersByTimeAsync(CONFIG.AVATAR_DEBATE_PAUSE_MS);
    expect(sent).toHaveLength(6);
    expect(runCodex).toHaveBeenCalledTimes(12);
    expect(memory.message(GROUP, 10)).toMatchObject({ editedAt: 20_000, rootMessageId: 10 });
    expect(memory.message(GROUP, 10)?.text).toContain("Исправленные затраты");
    const editedText = memory.message(GROUP, 10)?.text;
    memory.close();
    memory = createConversationMemory({
      path,
      chatId: GROUP,
      debounceMs: 60_000,
      generate: async () => null,
    });
    expect(memory.message(GROUP, 10)).toMatchObject({ text: editedText, rootMessageId: 10 });
    for (const self of ["hope", "avatar"] as const) {
      const context = memory.context(GROUP, self, LATE);
      expect(context).toContain('"rootMessageId":10');
      expect(context).toContain("Исправленные затраты");
      const data = JSON.parse(context.split("```json\n")[1]!.split("\n```")[0]!) as {
        messages: { text: string }[];
      };
      expect(data.messages.every((message) => message.text.length <= 900)).toBe(true);
      expect(context.length).toBeLessThanOrEqual(18_000);
      expect(memory.message(GROUP, 10)?.text).toContain("https://t.me/synthetic_feed/5");
    }
    const freshBot = new Bot("test:telegram-token");
    freshBot.botInfo = HOPE;
    transport(freshBot, "hope");
    continued = createChatReply(freshBot, store, { memory });
    freshBot.use(continued.middleware);
    await freshBot.handleUpdate({
      update_id: 4,
      message: {
        message_id: 20,
        date: 30,
        chat: POST.chat,
        from: { id: 42, is_bot: false, first_name: "Synthetic participant" },
        text: "@hope_bot почему этот материал?",
        reply_to_message: { ...POST, reply_to_message: undefined },
      },
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(runCodex.mock.calls[12]?.[0]).toContain("https://t.me/synthetic_feed/1");
    expect(sent.at(-1)?.payload.reply_parameters).toMatchObject({ message_id: 10 });
    expect(sent).toHaveLength(7);
    memory.clear(GROUP);
    await freshBot.handleUpdate({ update_id: 5, message: POST });
    await vi.advanceTimersByTimeAsync(0);
    expect(sent).toHaveLength(7);
    expect(memory.status(GROUP).messages).toBe(0);
    await freshBot.handleUpdate({ update_id: 6, edited_message: { ...POST, edit_date: 40 } });
    expect(memory.message(GROUP, 10)?.text).toContain(LATE);
    expect(sent).toHaveLength(7);
  } finally {
    memory.close();
    endPolling();
    await vi.advanceTimersByTimeAsync(0);
    await side.stop();
    await side.drain();
    await responder.drain();
    await continued?.drain();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
