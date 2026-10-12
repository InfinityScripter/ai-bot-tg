import { it, vi, expect, describe, afterEach } from "vitest";

const runCodex = vi.fn();
vi.mock("../src/llm/runCodex.js", () => ({
  runCodex: (...args: unknown[]) => runCodex(...args),
}));
const completeChatJson = vi.fn();
vi.mock("../src/llm/chatCompletion.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/llm/chatCompletion.js")>();
  return { ...actual, completeChatJson: (...args: unknown[]) => completeChatJson(...args) };
});

const { CONFIG } = await import("../src/config.js");
const { CandidateStore } = await import("../src/store/index.js");
const { createAvatarBot } = await import("../src/avatar/index.js");
const { AvatarStore } = await import("../src/avatar/avatarStore.js");

const GROUP = -100777;
const ME = { id: 999, is_bot: true, first_name: "Аватар", username: "misha_avatar_bot" };

afterEach(() => {
  runCodex.mockReset();
  completeChatJson.mockReset();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("the avatar's default generator", () => {
  it.each(["mention", "unasked", "debate"] as const)(
    "never uses a paid fallback when Codex fails (%s)",
    async (mode) => {
      vi.useFakeTimers();
      vi.spyOn(console, "log").mockImplementation(() => {});
      vi.spyOn(console, "warn").mockImplementation(() => {});
      runCodex.mockRejectedValue(new Error("Codex unavailable"));
      completeChatJson.mockResolvedValue('{"action":"reply","text":"Платный ответ"}');
      const store = new CandidateStore(":memory:");
      const avatarStore = new AvatarStore(":memory:");
      avatarStore.allowChat(GROUP, "AI-чат");
      const { bot, avatar } = createAvatarBot("test:avatar", store, {
        fallbackNotify: vi.fn(async () => undefined),
        avatar: { avatarStore, index: async () => ({ posts: 1, chunks: 1, failed: 0 }) },
      });
      bot.botInfo = {
        ...ME,
        can_join_groups: true,
        can_read_all_group_messages: true,
        supports_inline_queries: false,
      } as typeof bot.botInfo;
      const sent = vi.fn();
      bot.api.config.use((_prev, method, payload) => {
        if (method === "sendMessage") sent(payload);
        return Promise.resolve({
          ok: true,
          result: { message_id: 4242, date: 0, chat: { id: GROUP, type: "supergroup" } },
        } as never);
      });
      try {
        if (mode === "debate") {
          expect(
            await avatar.speaker.speak({
              chatId: GROUP,
              topic: "Агенты пишут тесты сами",
              lines: [{ side: "hope", text: "Это хайп", messageId: 77 }],
            }),
          ).toBeNull();
        } else {
          await bot.handleUpdate({
            update_id: 1,
            message: {
              message_id: 1,
              date: Math.floor(Date.now() / 1000),
              text: mode === "mention" ? `@${ME.username} что думаешь?` : "Агенты пишут тесты сами",
              ...(mode === "mention" && {
                entities: [{ type: "mention", offset: 0, length: ME.username.length + 1 }],
              }),
              from: { id: 555, is_bot: false, first_name: "Аня" },
              chat: { id: GROUP, type: "supergroup", title: "AI-чат" },
            },
          });
          await vi.advanceTimersByTimeAsync(mode === "unasked" ? CONFIG.AVATAR_QUIET_MS : 0);
        }
        expect(runCodex).toHaveBeenCalledOnce();
        expect(completeChatJson).not.toHaveBeenCalled();
        expect(sent).not.toHaveBeenCalled();
        expect(avatarStore.callsOn(GROUP, new Date().toISOString().slice(0, 10))).toBe(0);
        await bot.handleUpdate({
          update_id: 2,
          message: {
            message_id: 2,
            date: 0,
            text: "/avatar",
            entities: [{ type: "bot_command", offset: 0, length: 7 }],
            from: { id: CONFIG.OWNER_TELEGRAM_ID, is_bot: false, first_name: "Миша" },
            chat: { id: CONFIG.OWNER_TELEGRAM_ID, type: "private", first_name: "Миша" },
          },
        });
        const status = String(sent.mock.calls[0]?.[0].text);
        expect(status).toContain("Codex не ответил");
        expect(status).not.toContain("запасн");
      } finally {
        await avatar.drainAndClose();
        store.close();
      }
    },
  );
});
