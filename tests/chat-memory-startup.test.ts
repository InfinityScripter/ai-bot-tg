import type Database from "better-sqlite3";

import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync, mkdtempSync } from "node:fs";
import { it, vi, expect, describe, afterEach, beforeEach } from "vitest";

const fixture = vi.hoisted(() => ({
  failure: "",
  connections: [] as Database.Database[],
  createBot: vi.fn(),
  startAvatarSide: vi.fn(),
  notifyOwner: vi.fn(async (_text: string) => undefined),
  botStart: vi.fn<(options: { onStart: (info: { username: string }) => void }) => Promise<void>>(),
  config: {
    CHAT_REPLY_CHAT_ID: -1000000000777 as number | undefined,
    AVATAR_SQLITE_PATH: ":memory:",
    AVATAR_BOT_TOKEN: "",
    CRON_TZ: "Europe/Moscow",
  },
}));

vi.mock("../src/config.js", () => ({ CONFIG: fixture.config }));
vi.mock("../src/bot/index.js", () => ({ createBot: fixture.createBot }));
vi.mock("../src/avatar/index.js", () => ({ startAvatarSide: fixture.startAvatarSide }));
vi.mock("../src/store/index.js", () => ({
  CandidateStore: vi.fn(() => ({ close: vi.fn() })),
}));
vi.mock("../src/catalog/index.js", () => ({ importCatalog: vi.fn() }));
vi.mock("../src/server/index.js", () => ({
  runCollection: vi.fn(),
  runReleaseWatch: vi.fn(),
  startControlServer: vi.fn(),
  createProcessCandidate: vi.fn(),
  scheduleDaily: vi.fn(() => ({ nextRun: () => null, stop: vi.fn() })),
  scheduleChannelWatch: vi.fn(() => ({ stop: vi.fn(), idle: vi.fn() })),
  scheduleWhenResetWatch: vi.fn(() => ({ stop: vi.fn(), idle: vi.fn() })),
}));
vi.mock("../src/avatar/indexBlog.js", () => ({
  refreshBlogIndex: vi.fn(async () => ({ posts: 0, chunks: 0, failed: 0 })),
}));
vi.mock("better-sqlite3", async (importOriginal) => {
  const { default: NativeDatabase } = await importOriginal<{ default: typeof Database }>();
  return {
    default: vi.fn((path: string) => {
      const db = new NativeDatabase(path);
      fixture.connections.push(db);
      if (fixture.failure === "memory schema" && fixture.connections.length === 2) {
        vi.spyOn(db, "exec").mockImplementationOnce(() => {
          throw new Error("synthetic-private-detail");
        });
      }
      if (fixture.failure === "avatar pragma" && fixture.connections.length === 1) {
        vi.spyOn(db, "pragma").mockImplementationOnce(() => {
          throw new Error("synthetic-private-detail");
        });
      }
      return db;
    }),
  };
});

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  fixture.failure = "";
  fixture.config.CHAT_REPLY_CHAT_ID = -1000000000777;
  fixture.config.AVATAR_SQLITE_PATH = ":memory:";
  fixture.startAvatarSide.mockReturnValue(null);
  fixture.botStart.mockImplementation(async (options) => {
    options.onStart({ username: "synthetic_bot" });
  });
  fixture.createBot.mockReturnValue({
    bot: { start: fixture.botStart, stop: vi.fn(async () => undefined) },
    hope: {},
    notifyOwner: fixture.notifyOwner,
    sendRawCard: vi.fn(),
    runDigestPost: vi.fn(),
    runChannelIssue: vi.fn(),
    autoPublishCandidate: vi.fn(),
    notifyAutomaticFailures: vi.fn(),
    notifyNeedsVerification: vi.fn(),
    drain: vi.fn(),
  });
});

afterEach(() => {
  for (const db of fixture.connections.splice(0)) {
    if (db.open) db.close();
  }
  vi.restoreAllMocks();
});

describe("conversation memory startup failures", () => {
  it("disables unavailable memory and closes both opened connections when its schema fails", async () => {
    fixture.failure = "memory schema";
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { startConversationMemory } =
      await import("../src/chatMemory/startConversationMemory.js");
    let failed = false;
    let conversation: unknown;
    try {
      conversation = startConversationMemory();
    } catch {
      failed = true;
    }
    expect(failed).toBe(false);
    expect(conversation).toBeNull();
    expect(fixture.connections).toHaveLength(2);
    expect(fixture.connections.map((db) => db.open)).toEqual([false, false]);
    expect(warn.mock.calls.flat()).toEqual([expect.stringContaining("[chatMemory]")]);
    expect(JSON.stringify(warn.mock.calls)).not.toContain("synthetic-private-detail");
  });

  it("closes the initial connection when the avatar reader cannot enable its SQLite pragmas", async () => {
    fixture.failure = "avatar pragma";
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { startConversationMemory } =
      await import("../src/chatMemory/startConversationMemory.js");
    expect(startConversationMemory()).toBeNull();
    expect(fixture.connections).toHaveLength(1);
    expect(fixture.connections[0]?.open).toBe(false);
    expect(warn.mock.calls.flat()).toEqual([expect.stringContaining("[chatMemory]")]);
    expect(JSON.stringify(warn.mock.calls)).not.toContain("synthetic-private-detail");
  });

  it.each(["memory schema", "avatar pragma", "sqlite directory"])(
    "keeps the main bot polling and tells its owner safely after %s fails, without starting the avatar",
    async (failure) => {
      fixture.failure = failure;
      const directory =
        failure === "sqlite directory" ? mkdtempSync(join(tmpdir(), "memory-startup-")) : null;
      if (directory) fixture.config.AVATAR_SQLITE_PATH = directory;
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const error = vi.spyOn(console, "error").mockImplementation(() => {});
      vi.spyOn(console, "log").mockImplementation(() => {});
      vi.spyOn(process, "once").mockImplementation(() => process);
      vi.spyOn(process, "on").mockImplementation(() => process);
      const exit = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
      try {
        await import("../src/index.js");
        await vi.waitFor(() => expect(fixture.botStart).toHaveBeenCalledOnce());
        expect(fixture.createBot).toHaveBeenCalledOnce();
        expect(fixture.notifyOwner).toHaveBeenCalledOnce();
        expect(fixture.notifyOwner.mock.calls[0]?.[0]).toMatch(/Память.*недоступны/);
        expect(fixture.notifyOwner.mock.calls[0]?.[0]).toContain("аватар");
        expect(fixture.notifyOwner.mock.calls[0]?.[0]).toContain("Основной бот работает");
        expect(fixture.startAvatarSide).not.toHaveBeenCalled();
        expect(fixture.connections.every((db) => !db.open)).toBe(true);
        expect(exit).not.toHaveBeenCalled();
        expect(error).not.toHaveBeenCalled();
        const diagnostics = [
          ...warn.mock.calls.flat(),
          ...error.mock.calls.flat(),
          ...fixture.notifyOwner.mock.calls.flat(),
        ];
        expect(diagnostics.every((value) => typeof value === "string")).toBe(true);
        expect(diagnostics.join(" ")).not.toContain("synthetic-private-detail");
        if (directory) expect(diagnostics.join(" ")).not.toContain(directory);
      } finally {
        if (directory) rmSync(directory, { recursive: true, force: true });
      }
    },
  );
});
