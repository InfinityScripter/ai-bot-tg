import { it, vi, expect, describe, afterEach } from "vitest";

import { PublishStatus } from "../src/enums.js";
import { publishToBlog, toBlogPostBody } from "../src/blog/publishPost.js";

import type { RewriteResult } from "../src/types.js";

const REWRITE: RewriteResult = {
  title: "New title",
  description: "Summary",
  content: "Body",
  tags: ["t1", "t2"],
  metaTitle: "Meta",
  metaDescription: "Meta desc",
};

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("toBlogPostBody", () => {
  it("maps a rewrite into the publish body with published status", () => {
    const body = toBlogPostBody(REWRITE);
    expect(body).toMatchObject({
      title: "New title",
      description: "Summary",
      content: "Body",
      tags: ["t1", "t2"],
      metaTitle: "Meta",
      metaDescription: "Meta desc",
      metaKeywords: ["t1", "t2"],
      publish: PublishStatus.Published,
    });
  });

  it("includes the provided coverUrl when the article has its own image", () => {
    const body = toBlogPostBody(REWRITE, "https://cdn.example.com/p.jpg");
    expect(body.coverUrl).toBe("https://cdn.example.com/p.jpg");
  });

  it("omits coverUrl entirely when there is no image, so the blog assigns one", () => {
    // The bot no longer owns a stock pool: sending nothing is what makes the
    // blog hand out a cover no other post uses (see cover-assign.ts there).
    expect("coverUrl" in toBlogPostBody(REWRITE)).toBe(false);
    expect("coverUrl" in toBlogPostBody(REWRITE, null)).toBe(false);
    expect("coverUrl" in toBlogPostBody(REWRITE, "")).toBe(false);
  });
});

describe("publishToBlog", () => {
  it("POSTs with the bearer token and returns the post id on 201", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ success: true, post: { id: "post-9" } }), { status: 201 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const { postId } = await publishToBlog(REWRITE);
    expect(postId).toBe("post-9");

    const call = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(String(call[0])).toBe("http://localhost:7272/api/post/new");
    expect(call[1].method).toBe("POST");
    const headers = call[1].headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer test-bot-api-token-value");
  });

  it("sends an Idempotency-Key header when a dedup key is given", async () => {
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ post: { id: "p" } }), { status: 201 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await publishToBlog(REWRITE, null, "https://example.com/a");
    const call = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const headers = call[1].headers as Record<string, string>;
    expect(headers["Idempotency-Key"]).toBe("https://example.com/a");
  });

  it("omits the Idempotency-Key header when no dedup key is given", async () => {
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ post: { id: "p" } }), { status: 201 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await publishToBlog(REWRITE);
    const call = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const headers = call[1].headers as Record<string, string>;
    expect(headers["Idempotency-Key"]).toBeUndefined();
  });

  it("throws PublishError(maybePosted=false) on a 4xx (clear client rejection)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("bad", { status: 400 })),
    );
    const { PublishError } = await import("../src/blog/publishPost.js");
    await expect(publishToBlog(REWRITE)).rejects.toMatchObject({
      name: "PublishError",
      maybePosted: false,
    });
    expect(PublishError).toBeDefined();
  });

  it("throws PublishError(maybePosted=true) on a 5xx (may have committed)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("oops", { status: 502 })),
    );
    await expect(publishToBlog(REWRITE)).rejects.toMatchObject({ maybePosted: true });
  });

  it("throws PublishError(maybePosted=true) on a 201 with an unreadable body", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("not json", { status: 201 })),
    );
    await expect(publishToBlog(REWRITE)).rejects.toMatchObject({ maybePosted: true });
  });

  it("treats a transport rejection as uncertain because the body may have arrived", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("ECONNREFUSED");
      }),
    );
    await expect(publishToBlog(REWRITE)).rejects.toMatchObject({ maybePosted: true });
  });

  it("accepts a post returned with _id instead of id", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () => new Response(JSON.stringify({ post: { _id: "mongo-id" } }), { status: 201 }),
      ),
    );
    expect((await publishToBlog(REWRITE)).postId).toBe("mongo-id");
  });

  it("reports the cover the blog stored, so the channel card matches the post", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({ post: { id: "p", coverUrl: "/assets/images/cover/cover-7.webp" } }),
            { status: 201 },
          ),
      ),
    );
    expect((await publishToBlog(REWRITE)).coverUrl).toBe("/assets/images/cover/cover-7.webp");
  });

  it("reports a null cover when the blog response carries none", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ post: { id: "p" } }), { status: 201 })),
    );
    expect((await publishToBlog(REWRITE)).coverUrl).toBeNull();
  });

  it("throws on a non-201 response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("Unauthorized", { status: 401 })),
    );
    await expect(publishToBlog(REWRITE)).rejects.toThrow(/401/);
  });

  it("throws when the response has no post id", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ success: true }), { status: 201 })),
    );
    await expect(publishToBlog(REWRITE)).rejects.toThrow(/id/i);
  });

  it("throws a readable error when fetch itself fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("ECONNREFUSED");
      }),
    );
    await expect(publishToBlog(REWRITE)).rejects.toThrow(/связаться с блогом/);
  });

  it("treats a publish timeout as uncertain", async () => {
    const controller = new AbortController();
    vi.spyOn(AbortSignal, "timeout").mockReturnValue(controller.signal);
    vi.stubGlobal(
      "fetch",
      vi.fn((_url, init) => {
        const signal = init?.signal;
        if (!signal) return Promise.reject(new Error("missing timeout signal"));
        return new Promise((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(signal.reason));
        });
      }),
    );

    const result = publishToBlog(REWRITE);
    controller.abort(new DOMException("timed out", "TimeoutError"));

    await expect(result).rejects.toMatchObject({ maybePosted: true });
  });
});
