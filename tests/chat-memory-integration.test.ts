import type { Update } from "grammy/types";

import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync, mkdtempSync } from "node:fs";
import { it, vi, expect, describe, afterEach } from "vitest";

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
              throw new Error("Real Telegram network disabled in memory tests");
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

const GROUP = -1001234567890;
const OWNER = 123456789;
process.env.CHAT_REPLY_CHAT_ID = String(GROUP);

const ordinary = vi.fn();
const codex = vi.fn();
vi.mock("../src/chatReply/generateReply.js", () => ({
  generateReply: (...args: unknown[]) => ordinary(...args),
  codexReply: (...args: unknown[]) => codex(...args),
}));

const { createBot } = await import("../src/bot/index.js");
const { createAvatarBot } = await import("../src/avatar/createAvatarBot.js");
const { CandidateStore } = await import("../src/store/index.js");
const { AvatarStore } = await import("../src/avatar/avatarStore.js");
const { createConversationMemory } = await import("../src/chatMemory/index.js");
const { CONFIG } = await import("../src/config.js");

import type { Bot } from "grammy";

import type { MemoryWiring } from "../src/chatMemory/wiring.js";
import type { ConversationMemory } from "../src/chatMemory/index.js";

const disposers: (() => Promise<unknown> | void)[] = [];
let nextId = 100;
const message = (text: string, extra: Record<string, unknown> = {}): Update =>
  ({
    update_id: ++nextId,
    message: {
      message_id: nextId,
      date: 10,
      text,
      chat: { id: GROUP, type: "supergroup", title: "Synthetic group" },
      from: { id: 42, is_bot: false, first_name: "Аня" },
      ...extra,
    },
  }) as Update;

function api(bot: Bot, id: number, username: string) {
  bot.botInfo = {
    id,
    username,
    first_name: id === 777 ? "Neiro Misha" : "neuro_misha",
    is_bot: true,
    can_join_groups: true,
    can_read_all_group_messages: true,
    supports_inline_queries: false,
  } as typeof bot.botInfo;
  const sent: Record<string, unknown>[] = [];
  bot.api.config.use((_previous, method, payload) => {
    if (method === "sendMessage") sent.push(payload as Record<string, unknown>);
    return Promise.resolve({
      ok: true,
      result:
        method === "sendMessage"
          ? {
              message_id: ++nextId,
              date: 11,
              from: bot.botInfo,
              chat: { id: (payload as { chat_id: number }).chat_id, type: "supergroup" },
              text: (payload as { text: string }).text,
            }
          : true,
    } as never);
  });
  return sent;
}

function setup(memory?: ConversationMemory, wiring: MemoryWiring = {}) {
  const shared =
    memory ?? createConversationMemory({ path: ":memory:", chatId: GROUP, debounceMs: 60_000 });
  const store = new CandidateStore(":memory:");
  const avatarStore = new AvatarStore(":memory:");
  avatarStore.allowChat(GROUP, "Synthetic group");
  avatarStore.setEnabled(false);
  const refreshMaterials = vi.fn();
  const hope = createBot(store, async () => {}, { ...wiring, memory: shared, refreshMaterials });
  const avatar = createAvatarBot("test:avatar", store, {
    fallbackNotify: vi.fn(async () => undefined),
    avatar: {
      ...wiring,
      avatarStore,
      memory: shared,
      refreshMaterials,
      generate: codex,
      index: async () => ({ posts: 1, chunks: 1, failed: 0 }),
    },
  });
  const hopeSent = api(hope.bot, 777, "hope_bot");
  const avatarSent = api(avatar.bot, 999, "avatar_bot");
  store.setRawSetting("chat_reply_enabled", "0");
  disposers.push(async () => {
    shared.close();
    await Promise.all([hope.drain(), avatar.avatar.drainAndClose()]);
    store.close();
  });
  return { shared, store, avatarStore, hope, avatar, hopeSent, avatarSent, refreshMaterials };
}

afterEach(async () => {
  for (const dispose of disposers.splice(0)) await dispose();
  ordinary.mockReset();
  codex.mockReset();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("connected group memory through both Telegram middlewares", () => {
  it("deduplicates a confirmed rich opener when persistent memory is unavailable", async () => {
    const store = new CandidateStore(":memory:");
    const hope = createBot(store, async () => {});
    const sent = api(hope.bot, 777, "hope_bot");
    disposers.push(async () => {
      await hope.drain();
      store.close();
    });
    ordinary.mockResolvedValue({ action: "reply", text: "Подтверждённый ответ Hope" });
    const post = message("", {
      text: undefined,
      rich_message: { blocks: [{ type: "paragraph", text: "Выпуск про кварцевые агенты" }] },
      sender_chat: { id: -100555, type: "channel", title: "Synthetic channel" },
      is_automatic_forward: true,
    });
    await hope.bot.handleUpdate(post);
    await hope.drain();
    expect(sent).toHaveLength(1);
    await hope.bot.handleUpdate({ ...post, update_id: ++nextId });
    await hope.drain();
    expect(sent).toHaveLength(1);
    expect(ordinary).toHaveBeenCalledOnce();
  });

  it("deduplicates an actually sent opener when saving its acknowledgement fails", async () => {
    const { shared, hope, hopeSent, store } = setup();
    store.setRawSetting("chat_reply_enabled", "1");
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { observe } = shared;
    vi.spyOn(shared, "observe").mockImplementation((incoming) => {
      if (incoming.side === "hope") throw new Error("Synthetic acknowledgement write failure");
      observe(incoming);
    });
    ordinary.mockResolvedValue({ action: "reply", text: "Подтверждённый ответ Hope" });
    const post = message("", {
      text: undefined,
      rich_message: { blocks: [{ type: "paragraph", text: "Выпуск про кварцевые агенты" }] },
      sender_chat: { id: -100555, type: "channel", title: "Synthetic channel" },
      is_automatic_forward: true,
    });
    await hope.bot.handleUpdate(post);
    await hope.drain();
    expect(hopeSent).toHaveLength(1);
    expect(shared.status(GROUP).messages).toBe(1);
    await hope.bot.handleUpdate({ ...post, update_id: ++nextId });
    await hope.drain();
    expect(hopeSent).toHaveLength(1);
    expect(ordinary).toHaveBeenCalledOnce();
  });

  it("deduplicates queued rich posts without suppressing an avatar-first source", async () => {
    vi.useFakeTimers();
    const { shared, hope, avatar, hopeSent, store } = setup();
    store.setRawSetting("chat_reply_enabled", "1");
    let release: (reply: { action: "reply"; text: string }) => void = () => {};
    ordinary.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    ordinary.mockResolvedValue({ action: "reply", text: "Ответ Hope" });
    const post = message("", {
      text: undefined,
      rich_message: { blocks: [{ type: "paragraph", text: "Выпуск про кварцевые агенты" }] },
      sender_chat: { id: -100555, type: "channel", title: "Synthetic channel" },
      is_automatic_forward: true,
    });
    await avatar.bot.handleUpdate(post);
    await hope.bot.handleUpdate(post);
    await vi.advanceTimersByTimeAsync(0);
    await hope.bot.handleUpdate({ ...post, update_id: ++nextId });
    release({ action: "reply", text: "Ответ Hope" });
    await vi.advanceTimersByTimeAsync(0);
    await hope.drain();
    expect(hopeSent).toHaveLength(1);
    expect(ordinary).toHaveBeenCalledOnce();
    expect(shared.message(GROUP, post.message!.message_id)?.isPost).toBe(true);
    expect(shared.status(GROUP).messages).toBe(2);
  });

  it("does not generate another opener for a confirmed rich post after memory reopen", async () => {
    vi.useFakeTimers();
    const dir = mkdtempSync(join(tmpdir(), "confirmed-digest-memory-"));
    const deps = { path: join(dir, "memory.sqlite"), chatId: GROUP, debounceMs: 60_000 };
    const first = createConversationMemory(deps);
    const initial = setup(first);
    initial.store.setRawSetting("chat_reply_enabled", "1");
    ordinary.mockResolvedValue({ action: "reply", text: "Подтверждённый ответ Hope" });
    const post = message("", {
      text: undefined,
      rich_message: { blocks: [{ type: "paragraph", text: "Выпуск про кварцевые агенты" }] },
      sender_chat: { id: -100555, type: "channel", title: "Synthetic channel" },
      is_automatic_forward: true,
    });
    await initial.hope.bot.handleUpdate(post);
    await initial.hope.drain();
    expect(initial.hopeSent).toHaveLength(1);
    first.close();
    const reopened = createConversationMemory(deps);
    const current = setup(reopened);
    disposers.push(() => rmSync(dir, { recursive: true, force: true }));
    current.store.setRawSetting("chat_reply_enabled", "1");
    await current.hope.bot.handleUpdate({ ...post, update_id: ++nextId });
    await current.hope.drain();
    expect(current.hopeSent).toHaveLength(0);
    expect(ordinary).toHaveBeenCalledOnce();
    expect(reopened.status(GROUP).messages).toBe(2);
  });

  it.each(["model", "send"])(
    "retries a rich post after an unconfirmed %s failure",
    async (stage) => {
      const { shared, hope, hopeSent, store } = setup();
      store.setRawSetting("chat_reply_enabled", "1");
      vi.spyOn(console, "error").mockImplementation(() => {});
      ordinary.mockResolvedValue({ action: "reply", text: "Подтверждённый ответ Hope" });
      if (stage === "model") ordinary.mockResolvedValueOnce(null);
      if (stage === "send") {
        let failed = false;
        hope.bot.api.config.use((previous, method, payload, signal) => {
          if (method === "sendMessage" && !failed) {
            failed = true;
            return Promise.reject(new Error("Synthetic send failure"));
          }
          return previous(method, payload, signal);
        });
      }
      const post = message("", {
        text: undefined,
        rich_message: { blocks: [{ type: "paragraph", text: "Выпуск про кварцевые агенты" }] },
        sender_chat: { id: -100555, type: "channel", title: "Synthetic channel" },
        is_automatic_forward: true,
      });
      await hope.bot.handleUpdate(post);
      await hope.drain();
      expect(hopeSent).toHaveLength(0);
      expect(shared.status(GROUP).messages).toBe(1);
      await hope.bot.handleUpdate({ ...post, update_id: ++nextId });
      await hope.drain();
      expect(hopeSent).toHaveLength(1);
      expect(ordinary).toHaveBeenCalledTimes(2);
      expect(shared.status(GROUP).messages).toBe(2);
    },
  );

  it.each(["hope", "avatar"] as const)(
    "recalls the late rich digest material through a new %s mention after reopen",
    async (side) => {
      vi.useFakeTimers();
      const dir = mkdtempSync(join(tmpdir(), "late-digest-memory-"));
      const deps = { path: join(dir, "memory.sqlite"), chatId: GROUP, debounceMs: 60_000 };
      const first = createConversationMemory(deps);
      const initial = setup(first);
      const post: Update = {
        update_id: ++nextId,
        message: {
          message_id: 10,
          date: 10,
          chat: { id: GROUP, type: "supergroup", title: "Synthetic group" },
          from: { id: 777000, is_bot: false, first_name: "Telegram" },
          sender_chat: { id: -100555, type: "channel", title: "Synthetic channel" },
          is_automatic_forward: true,
          rich_message: {
            blocks: [
              { type: "heading", size: 1, text: "Выпуск: кварцевые агенты и другие темы" },
              ...[1, 2, 3, 4, 5].map((item) => ({
                type: "paragraph" as const,
                text: `Материал ${item}: ${"Сведения о маршрутизаторе. ".repeat(25)}`,
              })),
              { type: "heading", size: 2, text: "Кварцевые агенты" },
              {
                type: "paragraph",
                text: "Кварцевые агенты откатывают действия: ключ проверки ZETA_FINISH_481.",
              },
              {
                type: "paragraph",
                text: {
                  type: "url",
                  text: "Исходный пост",
                  url: "https://t.me/devfm/678",
                },
              },
            ],
          },
        },
      };
      await initial.avatar.bot.handleUpdate(post);
      await initial.hope.bot.handleUpdate(post);
      const source = first.message(GROUP, 10);
      expect(source?.text.length).toBeGreaterThan(3000);
      expect(source?.text).toContain("ZETA_FINISH_481");
      first.close();
      const reopened = createConversationMemory(deps);
      const current = setup(reopened);
      disposers.push(() => rmSync(dir, { recursive: true, force: true }));
      current.store.setRawSetting("chat_reply_enabled", "1");
      current.avatarStore.setEnabled(true);
      ordinary.mockResolvedValue({ action: "reply", text: "Новый ответ Hope" });
      codex.mockResolvedValue({ action: "reply", text: "Новый ответ аватара" });
      const bot = side === "hope" ? current.hope.bot : current.avatar.bot;
      await bot.handleUpdate(
        message(`@${side}_bot Что было про кварцевые агенты в выпуске?`, {
          entities: [{ type: "mention", offset: 0, length: side === "hope" ? 9 : 11 }],
        }),
      );
      await vi.advanceTimersByTimeAsync(0);
      const prompt = side === "hope" ? ordinary.mock.calls[0]?.[2] : codex.mock.calls[0]?.[1];
      expect(prompt).toContain("ZETA_FINISH_481");
      expect(prompt).toContain("https://t.me/devfm/678");
      expect(reopened.message(GROUP, 10)).toEqual(source);
      const context = reopened.context(GROUP, side, "Кварцевые агенты");
      const data = JSON.parse(context.split("```json\n")[1]!.split("\n```")[0]!) as {
        messages: { text: string }[];
      };
      expect(data.messages.every((item) => item.text.length <= 900)).toBe(true);
      expect(context.length).toBeLessThanOrEqual(18_000);
    },
  );

  it("captures ordinary text, captions and edits once before reply gates, with sender-chat identity", async () => {
    const { shared, hope, avatar } = setup();
    const original = message("сарказм про бумажных агентов");
    const caption = message("", {
      text: undefined,
      caption: "Статья: агенты и тесты",
      sender_chat: { id: -100555, type: "channel", title: "AI First" },
      is_automatic_forward: true,
    });
    for (const bot of [hope.bot, avatar.bot]) {
      await bot.handleUpdate(original);
      await bot.handleUpdate(caption);
      await bot.handleUpdate({
        update_id: ++nextId,
        edited_message: { ...original.message, text: "пояснение: это была шутка", edit_date: 20 },
      } as Update);
      await bot.handleUpdate(original);
      await bot.handleUpdate(
        message("другая группа", { chat: { id: -100999, type: "supergroup", title: "Other" } }),
      );
      await bot.handleUpdate(
        message("личка", {
          chat: { id: OWNER, type: "private", first_name: "Owner" },
          from: { id: OWNER, is_bot: false, first_name: "Owner" },
        }),
      );
    }
    expect(shared.status(GROUP).messages).toBe(2);
    expect(shared.message(GROUP, original.message!.message_id)).toMatchObject({
      text: "пояснение: это была шутка",
      editedAt: 20_000,
      authorId: 42,
    });
    expect(shared.message(GROUP, caption.message!.message_id)).toMatchObject({
      text: "Статья: агенты и тесты",
      authorId: -100555,
      authorName: "AI First",
      rootMessageId: caption.message!.message_id,
      isPost: true,
    });
    expect(ordinary).not.toHaveBeenCalled();
    expect(codex).not.toHaveBeenCalled();
  });

  it("uses sourced old memory, blog material and only its own position in all six reply paths after reopen", async () => {
    vi.useFakeTimers();
    const dir = mkdtempSync(join(tmpdir(), "memory-wiring-"));
    const path = join(dir, "avatar.sqlite");
    const materials = new AvatarStore(path);
    materials.setProfile("Synthetic owner profile");
    materials.replaceChunks([
      {
        title: "Фрактальная ложка в разработке",
        url: "https://example.com/spoon",
        body: "Статья: сравнение фрактальной ложки и агента",
      },
    ]);
    const deps = {
      path,
      chatId: GROUP,
      debounceMs: 60_000,
      materials: (query: string, limit: number) => materials.search(query, limit),
      generate: async (prompt: string) => {
        const side = prompt.includes("для стороны hope") ? "hope" : "avatar";
        return JSON.stringify({
          side,
          notes: [
            { kind: "joke", text: "Фрактальная ложка была шуткой Ани", sourceMessageIds: [5] },
          ],
          opinions: [
            {
              topic: "фрактальная ложка",
              stance: side === "hope" ? "Hope требует измерений" : "Avatar выбирает опыт",
              reason: "Реакция на шутку",
              sourceMessageIds: [5],
            },
          ],
        });
      },
    };
    const first = createConversationMemory(deps);
    first.observe({
      chatId: GROUP,
      messageId: 5,
      authorId: 42,
      authorName: "Аня",
      text: "фрактальная ложка вместо кофе — сарказм",
      at: 1,
    });
    first.observe({
      chatId: GROUP,
      messageId: 20,
      authorId: 777,
      authorName: "Neiro Misha",
      text: "Старый ответ",
      at: 2,
      side: "hope",
      rootMessageId: 5,
      replyToMessageId: 5,
    });
    await first.reflect(GROUP);
    for (let i = 0; i < 60; i++)
      first.observe({
        chatId: GROUP,
        messageId: 1000 + i,
        authorId: 55,
        authorName: "Борис",
        text: `поздняя болтовня ${i}`,
        at: 100 + i,
      });
    first.close();
    const shared = createConversationMemory(deps);
    const { hope, avatar, store, avatarStore, hopeSent, avatarSent } = setup(shared);
    disposers.unshift(() => {
      materials.close();
      rmSync(dir, { recursive: true, force: true });
    });
    store.setRawSetting("chat_reply_enabled", "1");
    avatarStore.setEnabled(true);
    ordinary.mockResolvedValue({ action: "reply", text: "Подтверждённый Hope" });
    codex.mockResolvedValue({ action: "reply", text: "Подтверждённый Codex" });
    await hope.bot.handleUpdate(
      message("@hope_bot фрактальная ложка?", {
        reply_to_message: {
          message_id: 20,
          date: 1,
          chat: { id: GROUP, type: "supergroup", title: "Synthetic group" },
          from: hope.bot.botInfo,
          text: "Старый ответ",
        },
      }),
    );
    await hope.drain();
    await hope.bot.handleUpdate(
      message("фрактальная ложка — новый пост", {
        sender_chat: { id: -100555, type: "channel", title: "AI First" },
        is_automatic_forward: true,
      }),
    );
    await hope.drain();
    await avatar.bot.handleUpdate(
      message("@avatar_bot фрактальная ложка?", {
        entities: [{ type: "mention", offset: 0, length: 11 }],
      }),
    );
    await vi.advanceTimersByTimeAsync(0);
    const debate = {
      chatId: GROUP,
      topic: "фрактальная ложка",
      rootMessageId: 5,
      lines: [
        {
          side: "avatar" as const,
          text: "фрактальная ложка",
          messageId: 20,
          authorName: "neuro_misha",
          authorId: 999,
        },
      ],
    };
    await hope.hope.speaker.speak(debate);
    await avatar.avatar.speaker.speak({
      ...debate,
      lines: [{ ...debate.lines[0]!, side: "hope", authorName: "Neiro Misha", authorId: 777 }],
    });
    await vi.advanceTimersByTimeAsync(CONFIG.AVATAR_COOLDOWN_MS);
    await avatar.bot.handleUpdate(message("фрактальная ложка — без упоминания"));
    await vi.advanceTimersByTimeAsync(CONFIG.AVATAR_QUIET_MS);
    const hopePrompts = [
      ordinary.mock.calls[0]?.[2],
      ordinary.mock.calls[1]?.[2],
      codex.mock.calls[1]?.[1],
    ] as string[];
    const avatarPrompts = [
      codex.mock.calls[0]?.[1],
      codex.mock.calls[2]?.[1],
      codex.mock.calls[3]?.[1],
    ] as string[];
    for (const prompt of [...hopePrompts, ...avatarPrompts]) {
      expect(prompt).toContain("фрактальная ложка вместо кофе — сарказм");
      expect(prompt).toContain('"authorName":"Аня"');
      expect(prompt).toContain("https://example.com/spoon");
      expect(prompt.length).toBeLessThan(30_000);
    }
    for (const prompt of hopePrompts) {
      expect(prompt).toContain("Hope требует измерений");
      expect(prompt).not.toContain("Avatar выбирает опыт");
    }
    for (const prompt of avatarPrompts) {
      expect(prompt).toContain("Avatar выбирает опыт");
      expect(prompt).not.toContain("Hope требует измерений");
    }
    expect(hopeSent[0]?.reply_parameters).toEqual({
      message_id: 5,
      allow_sending_without_reply: false,
    });
    expect(shared.status(GROUP).messages).toBe(72);
    expect(shared.context(GROUP, "hope", "Подтверждённый")).toContain('"authorId":777');
    expect(shared.context(GROUP, "avatar", "Подтверждённый")).toContain('"authorId":999');
    expect(avatarSent).toHaveLength(3);
  });

  it("restricts memory commands to owner DMs and clears legacy, RAM and pending results without deleting profile or articles", async () => {
    const { shared, store, avatarStore, hope, avatar, hopeSent, avatarSent } = setup();
    avatarStore.setProfile("Synthetic protected profile");
    avatarStore.replaceChunks([
      { title: "Статья", url: "https://example.com/material", body: "Общий материал" },
    ]);
    shared.observe({
      chatId: GROUP,
      messageId: 1,
      authorId: 42,
      authorName: "Аня",
      text: "Старая шутка",
      at: 1,
    });
    store.setRawSetting(
      `chat_reply_memory:${GROUP}`,
      JSON.stringify([
        { at: 1, userId: 42, name: "Аня", text: "Старая шутка", reply: "Прежний ответ" },
      ]),
    );
    const command = (text: string, from = OWNER, privateChat = true) =>
      message(text, {
        entities: [{ type: "bot_command", offset: 0, length: text.split(" ")[0]!.length }],
        from: { id: from, is_bot: false, first_name: "Owner" },
        ...(privateChat && { chat: { id: from, type: "private", first_name: "Owner" } }),
      });
    await avatar.bot.handleUpdate(command("/memory", 666));
    await avatar.bot.handleUpdate(command("/memory clear", OWNER, false));
    expect(avatarSent).toHaveLength(0);
    expect(shared.message(GROUP, 1)).not.toBeNull();
    await avatar.bot.handleUpdate(command("/memory"));
    expect(avatarSent.at(-1)?.text).toContain("Сообщений:");
    expect(avatarSent.at(-1)?.text).not.toContain("Старая шутка");
    store.setRawSetting("chat_reply_enabled", "1");
    avatarStore.setEnabled(true);
    let finishHope: (reply: { action: "reply"; text: string }) => void = () => {};
    let finishAvatar: (reply: { action: "reply"; text: string }) => void = () => {};
    ordinary.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishHope = resolve;
        }),
    );
    codex.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishAvatar = resolve;
        }),
    );
    await hope.bot.handleUpdate(message("@hope_bot вспомни старую шутку"));
    await avatar.bot.handleUpdate(
      message("@avatar_bot старая шутка", {
        entities: [{ type: "mention", offset: 0, length: 11 }],
      }),
    );
    await vi.waitFor(() => expect(ordinary).toHaveBeenCalledOnce());
    await hope.bot.handleUpdate(message("@hope_bot очередь со старым контекстом"));
    await avatar.bot.handleUpdate(
      message("@avatar_bot очередь", { entities: [{ type: "mention", offset: 0, length: 11 }] }),
    );
    await avatar.bot.handleUpdate(command("/memory clear"));
    finishHope({ action: "reply", text: "Поздний старый Hope" });
    finishAvatar({ action: "reply", text: "Поздний старый Avatar" });
    await hope.drain();
    await vi.waitFor(() => expect(avatarSent.at(-1)?.text).toContain("очищена"));
    expect(ordinary).toHaveBeenCalledOnce();
    expect(codex).toHaveBeenCalledOnce();
    expect(hopeSent).toHaveLength(0);
    expect(avatarSent).toHaveLength(2);
    expect(shared.status(GROUP).messages).toBe(0);
    expect(store.getRawSetting(`chat_reply_memory:${GROUP}`)).toBe("[]");
    expect(avatarStore.getProfile()).toBe("Synthetic protected profile");
    expect(avatarStore.chunkCount()).toBe(1);
    ordinary.mockResolvedValue({ action: "reply", text: "Новый Hope" });
    codex.mockResolvedValue({ action: "reply", text: "Новый Avatar" });
    await hope.bot.handleUpdate(message("@hope_bot новое обращение"));
    await hope.drain();
    await avatar.bot.handleUpdate(
      message("@avatar_bot новое обращение", {
        entities: [{ type: "mention", offset: 0, length: 11 }],
      }),
    );
    await vi.waitFor(() => expect(avatarSent).toHaveLength(3));
    expect(ordinary.mock.calls.at(-1)?.[2]).not.toContain("Старая шутка");
    expect(codex.mock.calls.at(-1)?.[1]).not.toContain("старая шутка");
  });

  it("uses an edited source in the avatar transcript instead of retaining its old RAM text", async () => {
    const { avatar, avatarStore, avatarSent } = setup();
    avatarStore.setEnabled(true);
    codex.mockResolvedValue({ action: "reply", text: "Ответ после редакции" });
    const original = message("старый ошибочный сарказм");
    await avatar.bot.handleUpdate(original);
    await avatar.bot.handleUpdate({
      update_id: ++nextId,
      edited_message: {
        ...original.message,
        text: "исправлено: это проверяемая гипотеза",
        edit_date: 20,
      },
    } as Update);
    await avatar.bot.handleUpdate(
      message("@avatar_bot что думаешь?", {
        entities: [{ type: "mention", offset: 0, length: 11 }],
      }),
    );
    await vi.waitFor(() => expect(avatarSent).toHaveLength(1));
    expect(codex.mock.calls[0]?.[1]).toContain("исправлено: это проверяемая гипотеза");
    expect(codex.mock.calls[0]?.[1]).not.toContain("старый ошибочный сарказм");
  });

  it("does not answer a replay of a cleared source from either polling stream", async () => {
    const { shared, store, avatarStore, hope, avatar } = setup();
    const original = message("@hope_bot @avatar_bot старое обращение", {
      entities: [{ type: "mention", offset: 10, length: 11 }],
    });
    for (const bot of [hope.bot, avatar.bot]) await bot.handleUpdate(original);
    await avatar.bot.handleUpdate(
      message("/memory clear", {
        entities: [{ type: "bot_command", offset: 0, length: 7 }],
        chat: { id: OWNER, type: "private", first_name: "Owner" },
        from: { id: OWNER, is_bot: false, first_name: "Owner" },
      }),
    );
    store.setRawSetting("chat_reply_enabled", "1");
    avatarStore.setEnabled(true);
    ordinary.mockResolvedValue({ action: "reply", text: "Старое ожило" });
    codex.mockResolvedValue({ action: "reply", text: "Старое ожило" });
    for (const bot of [hope.bot, avatar.bot]) await bot.handleUpdate(original);
    await hope.drain();
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(ordinary).not.toHaveBeenCalled();
    expect(codex).not.toHaveBeenCalled();
    expect(shared.status(GROUP).messages).toBe(0);
  });

  it("records no failed sends, reports safe errors and ends a cleared debate before another model turn", async () => {
    const reportReplyError = vi.fn();
    const { shared, store, avatarStore, hope, avatar } = setup(undefined, { reportReplyError });
    shared.observe({
      chatId: GROUP,
      messageId: 1,
      authorId: 777,
      authorName: "Neiro Misha",
      text: "Подтверждённый opener",
      at: 1,
      rootMessageId: 90,
      side: "hope",
    });
    store.setRawSetting("chat_reply_enabled", "1");
    avatarStore.setEnabled(true);
    ordinary.mockResolvedValue({ action: "reply", text: "Непроизнесённый ответ" });
    codex.mockResolvedValue({ action: "reply", text: "Непроизнесённый ответ" });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    for (const bot of [hope.bot, avatar.bot])
      bot.api.config.use((previous, method, payload, signal) =>
        method === "sendMessage"
          ? Promise.resolve({
              ok: false,
              error_code: 400,
              description: "synthetic private text: reply root deleted",
            } as never)
          : previous(method, payload, signal),
      );
    const incoming = message("@hope_bot @avatar_bot вопрос", {
      entities: [{ type: "mention", offset: 10, length: 11 }],
    });
    await hope.bot.handleUpdate(incoming);
    await hope.drain();
    await avatar.bot.handleUpdate(incoming);
    await vi.waitFor(() => expect(reportReplyError).toHaveBeenCalledTimes(2));
    const debate = {
      chatId: GROUP,
      topic: "Тема",
      rootMessageId: 90,
      lines: [
        {
          side: "hope" as const,
          text: "Подтверждённый opener",
          messageId: 1,
          authorId: 777,
          authorName: "Neiro Misha",
        },
      ],
    };
    expect(await hope.hope.speaker.speak(debate)).toBeNull();
    expect(await avatar.avatar.speaker.speak(debate)).toBeNull();
    expect(reportReplyError).toHaveBeenCalledTimes(4);
    expect(shared.status(GROUP).messages).toBe(2);
    expect(shared.context(GROUP, "hope", "ответ")).not.toContain("Непроизнесённый ответ");
    expect(store.getRawSetting(`chat_reply_memory:${GROUP}`)).toBeNull();
    expect(JSON.stringify([...warn.mock.calls, ...error.mock.calls])).not.toContain(
      "synthetic private text",
    );
    shared.clear(GROUP);
    codex.mockClear();
    expect(await hope.hope.speaker.speak(debate)).toBeNull();
    expect(await avatar.avatar.speaker.speak(debate)).toBeNull();
    expect(codex).not.toHaveBeenCalled();
  });

  it.each(["hope", "avatar"] as const)(
    "refreshes the edited root topic before a %s debate turn",
    async (side) => {
      const { shared, hope, avatar } = setup();
      const original = message("старый ошибочный сарказм о корне");
      await hope.bot.handleUpdate(original);
      await hope.bot.handleUpdate({
        update_id: ++nextId,
        edited_message: {
          ...original.message,
          text: "исправленная гипотеза о корне",
          edit_date: 20,
        },
      } as Update);
      shared.observe({
        chatId: GROUP,
        messageId: 2,
        authorId: 777,
        authorName: "Neiro Misha",
        text: "Подтверждённый ответ",
        at: 11_000,
        side: "hope",
        rootMessageId: original.message!.message_id,
      });
      codex.mockResolvedValue({ action: "reply", text: "Новая реплика" });
      const speaker = side === "hope" ? hope.hope.speaker : avatar.avatar.speaker;
      await speaker.speak({
        chatId: GROUP,
        topic: "старый ошибочный сарказм о корне",
        rootMessageId: original.message!.message_id,
        lines: [
          {
            side: "hope",
            text: "Подтверждённый ответ",
            messageId: 2,
            authorId: 777,
            authorName: "Neiro Misha",
          },
        ],
      });
      expect(codex.mock.calls[0]?.[1]).toContain("исправленная гипотеза о корне");
      expect(codex.mock.calls[0]?.[1]).not.toContain("старый ошибочный сарказм о корне");
    },
  );

  it("preserves RAM replies and debates in other owner-approved groups when connected memory is cleared", async () => {
    const { shared, avatar, avatarStore, avatarSent, hope, store } = setup();
    const other = -1000000000888;
    avatarStore.allowChat(other, "Other synthetic group");
    avatarStore.setEnabled(true);
    store.setRawSetting("chat_reply_enabled", "1");
    const post = message("История вне подключённой группы", {
      chat: { id: other, type: "supergroup", title: "Other synthetic group" },
      is_automatic_forward: true,
      sender_chat: { id: -100555, type: "channel", title: "Other channel" },
    });
    await avatar.bot.handleUpdate(post);
    await avatar.bot.handleUpdate(
      message("/memory clear", {
        entities: [{ type: "bot_command", offset: 0, length: 7 }],
        chat: { id: OWNER, type: "private", first_name: "Owner" },
        from: { id: OWNER, is_bot: false, first_name: "Owner" },
      }),
    );
    codex.mockResolvedValue({ action: "reply", text: "Ответ вне подключённой группы" });
    const question = message("@avatar_bot что думаешь?", {
      chat: { id: other, type: "supergroup", title: "Other synthetic group" },
      entities: [{ type: "mention", offset: 0, length: 11 }],
      reply_to_message: {
        message_id: post.message!.message_id,
        date: 10,
        chat: post.message!.chat,
        from: avatar.bot.botInfo,
        text: "Текст родителя без вложенного корня",
      },
    });
    await avatar.bot.handleUpdate(question);
    await vi.waitFor(() => expect(avatarSent).toHaveLength(2));
    expect(codex.mock.calls[0]?.[1]).toContain("История вне подключённой группы");
    expect(codex.mock.calls[0]?.[1]).not.toContain("Память группы:");
    expect(avatarSent.at(-1)?.reply_parameters).toEqual({
      message_id: post.message!.message_id,
      allow_sending_without_reply: false,
    });
    expect(shared.status(GROUP).messages).toBe(0);
    const debate = {
      chatId: other,
      rootMessageId: post.message!.message_id,
      topic: "Other conversation",
      lines: [
        {
          side: "avatar" as const,
          text: "Other opener",
          messageId: 2,
          authorId: 999,
          authorName: "neuro_misha",
        },
      ],
    };
    expect(await hope.hope.speaker.speak(debate)).not.toBeNull();
    expect(await avatar.avatar.speaker.speak(debate)).not.toBeNull();
    expect(shared.status(GROUP).messages).toBe(0);
  });

  it("does not retain avatar RAM when the legacy clear write fails after persistent clear", async () => {
    const { shared, store, avatarStore, avatar, avatarSent } = setup();
    avatarStore.setEnabled(true);
    const original = message("старый текст из RAM");
    await avatar.bot.handleUpdate(original);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(store, "setRawSetting").mockImplementationOnce(() => {
      throw new Error("synthetic private database detail");
    });
    await avatar.bot.handleUpdate(
      message("/memory clear", {
        entities: [{ type: "bot_command", offset: 0, length: 7 }],
        chat: { id: OWNER, type: "private", first_name: "Owner" },
        from: { id: OWNER, is_bot: false, first_name: "Owner" },
      }),
    );
    expect(shared.status(GROUP).messages).toBe(0);
    expect(avatarSent.at(-1)?.text).toContain("Не удалось");
    codex.mockResolvedValue({ action: "reply", text: "Новая реплика" });
    await avatar.bot.handleUpdate(
      message("@avatar_bot новое обращение", {
        entities: [{ type: "mention", offset: 0, length: 11 }],
      }),
    );
    await vi.waitFor(() => expect(codex).toHaveBeenCalledOnce());
    expect(codex.mock.calls[0]?.[1]).not.toContain("старый текст из RAM");
    expect(JSON.stringify(warn.mock.calls)).not.toContain("synthetic private database detail");
  });
});
