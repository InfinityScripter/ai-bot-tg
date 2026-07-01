import { it, vi, expect, describe, afterEach } from "vitest";

import { toReleaseBody, publishRelease } from "../src/blog/publishRelease.js";

import type { ReleaseResult } from "../src/types.js";

const RELEASE: ReleaseResult = {
  vendor: "OpenAI",
  model: "GPT",
  version: "5",
  releasedAt: "2026-06-01",
  sourceUrl: "https://example.com/release",
  contextTokens: 400000,
  priceIn: 1.25,
  priceOut: 10,
  changes: ["Longer context", "Cheaper output"],
  sourceName: "TechCrunch",
};

const NULLY: ReleaseResult = {
  ...RELEASE,
  contextTokens: null,
  priceIn: null,
  priceOut: null,
  sourceName: null,
  changes: [],
};

/** A 201 with the ok() envelope { success, data: { release: { id } } }. */
function created(id: string): Response {
  return new Response(JSON.stringify({ success: true, data: { release: { id } } }), {
    status: 201,
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("toReleaseBody", () => {
  it("maps a release to the exact CreateReleasePayload, carrying values through", () => {
    expect(toReleaseBody(RELEASE)).toEqual({
      vendor: "OpenAI",
      model: "GPT",
      version: "5",
      releasedAt: "2026-06-01",
      sourceUrl: "https://example.com/release",
      contextTokens: 400000,
      priceIn: 1.25,
      priceOut: 10,
      changes: ["Longer context", "Cheaper output"],
      sourceName: "TechCrunch",
    });
  });

  it("carries null price/context/date THROUGH as null (never coerced to 0)", () => {
    const body = toReleaseBody(NULLY);
    expect(body.priceIn).toBeNull();
    expect(body.priceOut).toBeNull();
    expect(body.contextTokens).toBeNull();
    expect(body.sourceName).toBeNull();
  });

  it("does not send a verdict (bot drafts have no owner verdict)", () => {
    expect(toReleaseBody(RELEASE)).not.toHaveProperty("verdict");
  });
});

describe("publishRelease", () => {
  it("POSTs to /api/changelog/new and reads the id from data.data.release.id on 201", async () => {
    const fetchMock = vi.fn(async () => created("rel-42"));
    vi.stubGlobal("fetch", fetchMock);

    const id = await publishRelease(RELEASE);
    expect(id).toBe("rel-42");

    const call = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(String(call[0])).toBe("http://localhost:7272/api/changelog/new");
    expect(call[1].method).toBe("POST");
    const headers = call[1].headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer test-bot-api-token-value");
    // The body is exactly the CreateReleasePayload.
    expect(JSON.parse(String(call[1].body))).toEqual(toReleaseBody(RELEASE));
  });

  it("sends an Idempotency-Key header when a dedup key is given", async () => {
    const fetchMock = vi.fn(async () => created("rel-1"));
    vi.stubGlobal("fetch", fetchMock);

    await publishRelease(RELEASE, "https://example.com/release");
    const call = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const headers = call[1].headers as Record<string, string>;
    expect(headers["Idempotency-Key"]).toBe("https://example.com/release");
  });

  it("throws PublishError(maybePosted=false) on a 4xx", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("bad", { status: 400 })),
    );
    await expect(publishRelease(RELEASE)).rejects.toMatchObject({
      name: "PublishError",
      maybePosted: false,
    });
  });

  it("throws PublishError(maybePosted=true) on a 5xx (may have committed)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("oops", { status: 502 })),
    );
    await expect(publishRelease(RELEASE)).rejects.toMatchObject({ maybePosted: true });
  });

  it("throws PublishError(maybePosted=true) on a 201 with an unreadable body", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("not json", { status: 201 })),
    );
    await expect(publishRelease(RELEASE)).rejects.toMatchObject({ maybePosted: true });
  });

  it("throws when the 201 envelope has no release id", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ success: true, data: {} }), { status: 201 })),
    );
    await expect(publishRelease(RELEASE)).rejects.toThrow(/id/i);
  });

  it("throws PublishError(maybePosted=false) when it cannot connect", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("ECONNREFUSED");
      }),
    );
    await expect(publishRelease(RELEASE)).rejects.toMatchObject({ maybePosted: false });
  });
});
