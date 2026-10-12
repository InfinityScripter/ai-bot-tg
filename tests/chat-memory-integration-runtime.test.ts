import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync, mkdtempSync } from "node:fs";
import { it, vi, expect, afterEach } from "vitest";

import { AvatarStore } from "../src/avatar/avatarStore.js";
import { startConversationMemory } from "../src/chatMemory/startConversationMemory.js";

import type { RecentPost } from "../src/blog/types.js";

const GROUP = -1000000000777;
const cleanup: (() => Promise<unknown> | void)[] = [];
afterEach(async () => {
  for (const dispose of cleanup.splice(0)) await dispose();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it("refreshes only missing published bodies at startup and coalesces new posts without blocking recall", async () => {
  const dir = mkdtempSync(join(tmpdir(), "memory-bootstrap-"));
  const path = join(dir, "avatar.sqlite");
  cleanup.unshift(() => rmSync(dir, { recursive: true, force: true }));
  const store = new AvatarStore(path);
  store.replaceChunks([
    { title: "Старая статья", url: "https://aifirst.us.com/post/old", body: "кофейник старый" },
  ]);
  let posts = [
    { id: "old", title: "Старая статья" },
    { id: "new", title: "Кофейник новый" },
  ] as RecentPost[];
  const listPosts = vi.fn(async () => posts);
  const fetchBody = vi.fn(async (id: string) => `Материал про кофейник ${id}`);
  const runtime = startConversationMemory({
    path,
    chatId: GROUP,
    indexDeps: { listPosts, fetchBody, pause: async () => {} },
  });
  if (!runtime) throw new Error("Memory runtime did not start");
  cleanup.unshift(async () => {
    await runtime.drain();
    store.close();
  });
  await vi.waitFor(() => expect(fetchBody).toHaveBeenCalledWith("new"));
  expect(fetchBody).not.toHaveBeenCalledWith("old");
  expect(runtime.memory.context(GROUP, "hope", "кофейник")).toContain("Материал про кофейник new");
  expect(runtime.memory.context(GROUP, "avatar", "кофейник")).toContain(
    "Материал про кофейник new",
  );
  posts = [...posts, { id: "later", title: "Кофейник поздний" } as RecentPost];
  let release: (text: string) => void = () => {};
  fetchBody.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  runtime.refreshMaterials();
  await vi.waitFor(() => expect(fetchBody).toHaveBeenCalledWith("later"));
  runtime.refreshMaterials();
  runtime.refreshMaterials();
  expect(runtime.memory.context(GROUP, "hope", "кофейник")).toContain("Старая статья");
  release("Материал про кофейник later");
  await vi.waitFor(() => expect(store.indexedUrls().size).toBe(3));
  await vi.waitFor(() => expect(listPosts).toHaveBeenCalledTimes(3));
  expect(fetchBody.mock.calls.map(([id]) => id)).toEqual(["new", "later"]);
  listPosts.mockRejectedValueOnce(new Error("synthetic private error"));
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  runtime.refreshMaterials();
  await vi.waitFor(() => expect(runtime.memoryError()).toContain("блог"));
  expect(store.indexedUrls().size).toBe(3);
  expect(JSON.stringify(warn.mock.calls)).not.toContain("synthetic private error");
});

it("bounds shutdown while a blog list is stalled and retains its reader until the late refresh settles", async () => {
  vi.useFakeTimers();
  const dir = mkdtempSync(join(tmpdir(), "memory-shutdown-"));
  const path = join(dir, "avatar.sqlite");
  let release: (posts: RecentPost[]) => void = () => {};
  const listPosts = vi.fn(
    () =>
      new Promise<RecentPost[]>((resolve) => {
        release = resolve;
      }),
  );
  const fetchBody = vi.fn(async () => "Кофейник после остановки");
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const runtime = startConversationMemory({
    path,
    chatId: GROUP,
    indexDeps: { listPosts, fetchBody, pause: async () => {} },
  });
  if (!runtime) throw new Error("Memory runtime did not start");
  cleanup.unshift(async () => {
    await runtime.drain();
    rmSync(dir, { recursive: true, force: true });
  });
  const draining = runtime.drain();
  await vi.advanceTimersByTimeAsync(2000);
  await draining;
  expect(runtime.memory.status(GROUP).epoch).toBe(-1);
  runtime.refreshMaterials();
  expect(listPosts).toHaveBeenCalledOnce();
  release([
    { id: "late", title: "Поздний кофейник", createdAt: "2026-10-12", publish: "published" },
  ]);
  await vi.advanceTimersByTimeAsync(0);
  const reopened = new AvatarStore(path);
  expect(reopened.indexedUrls()).toEqual(new Set(["https://aifirst.us.com/post/late"]));
  reopened.close();
  expect(warn).not.toHaveBeenCalled();
});
