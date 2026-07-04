import { it, vi, expect, describe, afterEach } from "vitest";

import { fetchRecentPosts } from "../src/blog/index.js";

import type { RecentPost } from "../src/blog/index.js";

/** An ISO string `days` before now. */
function daysAgo(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString();
}

/** A 200 JSON response wrapping a `{ posts }` list (the /api/post/list shape). */
function listResponse(posts: RecentPost[]): Response {
  return new Response(JSON.stringify({ posts, total: posts.length, hasMore: false }), {
    status: 200,
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("fetchRecentPosts", () => {
  it("GETs /api/post/list?limit=50 and reads the .posts array", async () => {
    const posts: RecentPost[] = [{ id: "1", title: "Fresh", createdAt: daysAgo(1) }];
    const fetchMock = vi.fn(async () => listResponse(posts));
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchRecentPosts();
    expect(result).toHaveLength(1);
    expect(result[0]!.title).toBe("Fresh");

    const call = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(String(call[0])).toBe("http://localhost:7272/api/post/list?limit=50");
  });

  it("keeps only posts within the last 7 days (drops older ones)", async () => {
    const posts: RecentPost[] = [
      { id: "new", title: "Two days old", createdAt: daysAgo(2) },
      { id: "edge", title: "Six days old", createdAt: daysAgo(6) },
      { id: "old", title: "Ten days old", createdAt: daysAgo(10) },
    ];
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => listResponse(posts)),
    );

    const result = await fetchRecentPosts(7);
    const titles = result.map((p) => p.title);
    expect(titles).toEqual(["Two days old", "Six days old"]);
    expect(titles).not.toContain("Ten days old");
  });

  it("honours a custom window (days arg)", async () => {
    const posts: RecentPost[] = [
      { id: "a", title: "One day", createdAt: daysAgo(1) },
      { id: "b", title: "Three days", createdAt: daysAgo(3) },
    ];
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => listResponse(posts)),
    );

    const result = await fetchRecentPosts(2);
    expect(result.map((p) => p.title)).toEqual(["One day"]);
  });

  it("returns [] when the response has no posts array", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({}), { status: 200 })),
    );
    await expect(fetchRecentPosts()).resolves.toEqual([]);
  });

  it("drops posts with an unparseable createdAt (NaN)", async () => {
    const posts: RecentPost[] = [
      { id: "good", title: "Good", createdAt: daysAgo(1) },
      { id: "bad", title: "Bad", createdAt: "not-a-date" },
    ];
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => listResponse(posts)),
    );

    const result = await fetchRecentPosts();
    expect(result.map((p) => p.title)).toEqual(["Good"]);
  });

  it("throws when the blog list responds non-2xx", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("nope", { status: 500 })),
    );
    await expect(fetchRecentPosts()).rejects.toThrow(/500/);
  });
});
