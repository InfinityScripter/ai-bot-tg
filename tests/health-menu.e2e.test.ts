import { it, vi, expect, describe, afterEach, beforeEach } from "vitest";

// Mock the model-ping (the only network the /health LLM probe does) so the e2e
// run is deterministic and offline. classify/rewrite are not exercised here.
const pingModel = vi.fn(async (_provider: unknown, _model: unknown) => ({ ok: true as const }));
vi.mock("../src/models.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/models.js")>();
  return { ...actual, pingModel };
});

const { createBot } = await import("../src/bot.js");
const { CandidateStore } = await import("../src/store.js");
const { MENU_CALLBACK } = await import("../src/consts.js");
const { MenuAction } = await import("../src/enums.js");
import type { Update } from "grammy/types";

const OWNER_ID = 123456789; // matches tests/setup.ts OWNER_TELEGRAM_ID

/**
 * Builds a real bot whose outgoing API calls are intercepted (no network). All
 * sendMessage texts and setMyCommands payloads are recorded so the e2e tests can
 * assert on what the owner would actually receive.
 */
function makeBot() {
  const store = new CandidateStore(":memory:");
  const sends: string[] = [];
  const { bot } = createBot(store, async () => "Готово: новых 0.", {
    nextRun: () => new Date("2026-07-01T09:00:00.000Z"),
  });
  bot.api.config.use((_prev, method, payload) => {
    if (method === "sendMessage") sends.push((payload as { text: string }).text);
    return Promise.resolve({ ok: true, result: { message_id: 1 } } as never);
  });
  return { bot, store, sends };
}

/** A text-message update from the owner (a typed command or free text). */
function messageUpdate(text: string): Update {
  return {
    update_id: 1,
    message: {
      message_id: 10,
      date: 0,
      text,
      from: { id: OWNER_ID, is_bot: false, first_name: "Owner" },
      chat: { id: OWNER_ID, type: "private", first_name: "Owner" },
      entities: text.startsWith("/")
        ? [{ type: "bot_command", offset: 0, length: text.split(" ")[0]!.length }]
        : undefined,
    },
  } as Update;
}

/** A callback-query update from the owner tapping an inline button. */
function callbackUpdate(data: string): Update {
  return {
    update_id: 2,
    callback_query: {
      id: "cbq",
      from: { id: OWNER_ID, is_bot: false, first_name: "Owner" },
      chat_instance: "ci",
      data,
      message: {
        message_id: 11,
        date: 0,
        chat: { id: OWNER_ID, type: "private", first_name: "Owner" },
      },
    },
  } as Update;
}

beforeEach(() => {
  // Blog-API HEAD probe → reachable.
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ status: 200 }) as Response),
  );
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  pingModel.mockClear();
});

describe("e2e: command menu + /help", () => {
  it("/help lists every command", async () => {
    const { bot, store, sends } = makeBot();
    await bot.init();
    await bot.handleUpdate(messageUpdate("/help"));
    const help = sends.at(-1)!;
    for (const cmd of ["/fetch", "/model", "/health", "/help", "/ping", "/menu"]) {
      expect(help).toContain(cmd);
    }
    store.close();
  });

  it("/menu and /start show the inline button keyboard (no error)", async () => {
    const { bot, store, sends } = makeBot();
    await bot.init();
    await bot.handleUpdate(messageUpdate("/menu"));
    await bot.handleUpdate(messageUpdate("/start"));
    expect(sends.filter((t) => t.includes("Выберите действие"))).toHaveLength(2);
    store.close();
  });

  it("an unknown /command points the owner at /help", async () => {
    const { bot, store, sends } = makeBot();
    await bot.init();
    await bot.handleUpdate(messageUpdate("/wat"));
    expect(sends.at(-1)).toContain("/help");
    store.close();
  });
});

describe("e2e: /health readiness report", () => {
  it("/health pings the model, probes the blog, and reports ✅ Всё ОК", async () => {
    const { bot, store, sends } = makeBot();
    await bot.init();

    await bot.handleUpdate(messageUpdate("/health"));

    expect(pingModel).toHaveBeenCalledTimes(1); // active model was probed
    const report = sends.at(-1)!;
    expect(report).toContain("✅ *Всё ОК*");
    expect(report).toContain("Процесс");
    expect(report).toContain("LLM");
    expect(report).toContain("Блог API");
    expect(report).toContain("2026-07-01"); // next cron run shown
    store.close();
  });

  it("/health reports ⚠️ when the blog API is unreachable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("ECONNREFUSED");
      }),
    );
    const { bot, store, sends } = makeBot();
    await bot.init();

    await bot.handleUpdate(messageUpdate("/health"));

    const report = sends.at(-1)!;
    expect(report).toContain("⚠️ *Есть проблемы*");
    expect(report).toContain("❌");
    store.close();
  });
});

describe("e2e: menu button taps route to the command action", () => {
  it("the Health button runs the same report as /health", async () => {
    const { bot, store, sends } = makeBot();
    await bot.init();

    await bot.handleUpdate(callbackUpdate(`${MENU_CALLBACK}${MenuAction.Health}`));

    expect(pingModel).toHaveBeenCalledTimes(1);
    expect(sends.some((t) => t.includes("Всё ОК") || t.includes("Есть проблемы"))).toBe(true);
    store.close();
  });

  it("the Help button sends the command list", async () => {
    const { bot, store, sends } = makeBot();
    await bot.init();

    await bot.handleUpdate(callbackUpdate(`${MENU_CALLBACK}${MenuAction.Help}`));

    expect(sends.at(-1)).toContain("/fetch");
    store.close();
  });

  it("the Fetch button runs a collection cycle", async () => {
    const { bot, store, sends } = makeBot();
    await bot.init();

    await bot.handleUpdate(callbackUpdate(`${MENU_CALLBACK}${MenuAction.Fetch}`));

    expect(sends.some((t) => t.includes("Запускаю сбор"))).toBe(true);
    store.close();
  });
});
