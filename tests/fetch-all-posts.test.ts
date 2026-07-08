import { it, vi, expect, describe, afterEach } from "vitest";

import { fetchAllPosts } from "../src/blog/fetchAllPosts.js";

import type { RecentPost } from "../src/blog/types.js";

function post(over: Partial<RecentPost>): RecentPost {
  return { id: "x", title: "T", createdAt: "2026-01-01T00:00:00Z", publish: "published", ...over };
}

function page(posts: RecentPost[], hasMore: boolean): Response {
  return new Response(JSON.stringify({ posts, total: posts.length, hasMore }), { status: 200 });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("fetchAllPosts", () => {
  it("walks every page until hasMore is false and flattens the result", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(page([post({ id: "1" }), post({ id: "2" })], true))
      .mockResolvedValueOnce(page([post({ id: "3" })], false));
    vi.stubGlobal("fetch", fetchMock);

    const all = await fetchAllPosts();
    expect(all.map((p) => p.id)).toEqual(["1", "2", "3"]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    // page numbers are 1-based and increment.
    expect(fetchMock).toHaveBeenNthCalledWith(1, expect.stringContaining("page=1"), expect.anything());
    expect(fetchMock).toHaveBeenNthCalledWith(2, expect.stringContaining("page=2"), expect.anything());
  });

  it("returns posts oldest-first by createdAt", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      page(
        [
          post({ id: "new", createdAt: "2026-03-01T00:00:00Z" }),
          post({ id: "old", createdAt: "2026-01-01T00:00:00Z" }),
          post({ id: "mid", createdAt: "2026-02-01T00:00:00Z" }),
        ],
        false,
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const all = await fetchAllPosts();
    expect(all.map((p) => p.id)).toEqual(["old", "mid", "new"]);
  });

  it("skips unpublished (draft) posts", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        page([post({ id: "pub" }), post({ id: "draft", publish: "draft" })], false),
      );
    vi.stubGlobal("fetch", fetchMock);

    const all = await fetchAllPosts();
    expect(all.map((p) => p.id)).toEqual(["pub"]);
  });

  it("throws on a non-2xx page instead of returning a partial set", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response("nope", { status: 500 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchAllPosts()).rejects.toThrow(/500/);
  });
});
