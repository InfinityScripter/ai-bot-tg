import { it, vi, expect, describe, afterEach } from "vitest";

const { CONFIG } = await import("../src/config.js");
const { AvatarStore } = await import("../src/avatar/avatarStore.js");
const { chunkPost, plainText } = await import("../src/avatar/chunkPost.js");
const { indexBlog, fetchPostBody } = await import("../src/avatar/indexBlog.js");

import type { IndexDeps } from "../src/avatar/indexBlog.js";

afterEach(() => vi.unstubAllGlobals());

describe("plainText", () => {
  it("drops tags, image and link syntax and keeps paragraphs", () => {
    expect(
      plainText("<p>Первый <b>абзац</b></p><p>![кот](x.png) [ссылка](https://a) &amp; всё</p>"),
    ).toBe("Первый абзац\n\nссылка & всё");
  });
});

describe("chunkPost", () => {
  it("packs short paragraphs together and keeps title and url on every chunk", () => {
    const chunks = chunkPost({ title: "T", url: "U", content: "<p>один</p><p>два</p>" });
    expect(chunks).toEqual([{ title: "T", url: "U", body: "один\n\nдва" }]);
  });

  it("never makes a chunk longer than 1200 characters", () => {
    const long = `${"слово ".repeat(500)}`;
    const chunks = chunkPost({ title: "T", url: "U", content: `<p>${long}</p><p>${long}</p>` });
    expect(chunks.length).toBeGreaterThan(2);
    for (const c of chunks) expect(c.body.length).toBeLessThanOrEqual(1200);
  });
});

describe("indexBlog", () => {
  const post = (id: string, title: string) => ({ id, title, createdAt: "2026-10-01" });

  it("indexes every post body, skips a failed one and pauses between requests", async () => {
    const store = new AvatarStore(":memory:");
    const pause = vi.fn(async () => undefined);
    const deps: IndexDeps = {
      listPosts: async () => [post("1", "Агенты"), post("2", "Сломанный")],
      fetchBody: async (id) => {
        if (id === "2") throw new Error("500");
        return "<p>Про нейроагентов</p>";
      },
      pause,
    };
    await expect(indexBlog(store, deps)).resolves.toEqual({ posts: 2, chunks: 1, failed: 1 });
    expect(pause).toHaveBeenCalledTimes(1);
    const [hit] = store.search('"нейроа"*', 5);
    expect(hit?.url).toBe(`${CONFIG.BLOG_PUBLIC_URL.replace(/\/$/, "")}/post/1`);
  });

  it("keeps the old index when the new crawl produced nothing", async () => {
    const store = new AvatarStore(":memory:");
    store.replaceChunks([{ title: "old", url: "u", body: "старое" }]);
    const deps: IndexDeps = {
      listPosts: async () => [post("1", "x")],
      fetchBody: async () => {
        throw new Error("down");
      },
      pause: async () => undefined,
    };
    await expect(indexBlog(store, deps)).rejects.toThrow("пуст");
    expect(store.chunkCount()).toBe(1);
  });
});

describe("indexBlog guards", () => {
  const post = (id: string) => ({ id, title: `T${id}`, createdAt: "2026-10-01" });
  const deps = (bodies: Record<string, string | Error>): IndexDeps => ({
    listPosts: async () => Object.keys(bodies).map(post),
    fetchBody: async (id) => {
      const body = bodies[id];
      if (body instanceof Error) throw body;
      return body ?? "";
    },
    pause: async () => undefined,
  });

  it("counts a post with an empty body as failed", async () => {
    const store = new AvatarStore(":memory:");
    await expect(indexBlog(store, deps({ "1": "<p>текст</p>", "2": "" }))).resolves.toEqual({
      posts: 2,
      chunks: 1,
      failed: 1,
    });
  });

  it("keeps a full old index when more than a fifth of the posts failed", async () => {
    const store = new AvatarStore(":memory:");
    store.replaceChunks([{ title: "old", url: "u", body: "старое" }]);
    const down = new Error("429");
    await expect(
      indexBlog(store, deps({ "1": "<p>a</p>", "2": down, "3": down, "4": "<p>b</p>" })),
    ).rejects.toThrow("старый индекс");
    expect(store.search('"старое"*', 5)).toHaveLength(1);
  });
});

describe("fetchPostBody", () => {
  it("reads post.content from the details endpoint", async () => {
    const fetchSpy = vi.fn(
      async (_url: string) => new Response(JSON.stringify({ post: { content: "<p>x</p>" } })),
    );
    vi.stubGlobal("fetch", fetchSpy);
    await expect(fetchPostBody("abc")).resolves.toBe("<p>x</p>");
    expect(String(fetchSpy.mock.calls[0]?.[0])).toContain("/api/post/details?id=abc");
  });

  it("throws on a non-OK response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("", { status: 404 })),
    );
    await expect(fetchPostBody("abc")).rejects.toThrow("404");
  });
});
