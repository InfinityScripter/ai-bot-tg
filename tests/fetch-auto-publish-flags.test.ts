import { it, vi, expect, describe, afterEach } from "vitest";

import { fetchAutoPublishFlags } from "../src/blog/index.js";

/** A 200 response wrapping the backend ok() envelope { data: { flags } }. */
function settingsResponse(flags: Record<string, unknown>): Response {
  return new Response(JSON.stringify({ success: true, data: { flags } }), { status: 200 });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("fetchAutoPublishFlags", () => {
  it("reads the two flags from data.data.flags (NOT the top level)", async () => {
    const fetchMock = vi.fn(async () =>
      settingsResponse({
        pdCollection: false,
        dogsBooking: true,
        autoPublishReleases: true,
        autoPublishNews: false,
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const flags = await fetchAutoPublishFlags();
    expect(flags).toEqual({ releases: true, news: false });

    // Hits the admin settings route with the service token.
    const call = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(String(call[0])).toBe("http://localhost:7272/api/admin/settings");
    const headers = call[1].headers as Record<string, string>;
    expect(headers.Authorization).toMatch(/^Bearer /);
  });

  it("treats a top-level (mis-nested) flags shape as off — guards the envelope bug", async () => {
    // If the parser wrongly read `data.flags`, it would see these and turn ON.
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({ flags: { autoPublishReleases: true, autoPublishNews: true } }),
            { status: 200 },
          ),
      ),
    );
    await expect(fetchAutoPublishFlags()).resolves.toEqual({ releases: false, news: false });
  });

  it("only an explicit boolean true enables (truthy non-true stays off)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => settingsResponse({ autoPublishReleases: "true", autoPublishNews: 1 })),
    );
    await expect(fetchAutoPublishFlags()).resolves.toEqual({ releases: false, news: false });
  });

  it("fails closed (off) on a non-2xx response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("nope", { status: 500 })),
    );
    await expect(fetchAutoPublishFlags()).resolves.toEqual({ releases: false, news: false });
  });

  it("fails closed (off) when fetch throws (network/timeout)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network down");
      }),
    );
    await expect(fetchAutoPublishFlags()).resolves.toEqual({ releases: false, news: false });
  });

  it("fails closed (off) on an unreadable body", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("not json", { status: 200 })),
    );
    await expect(fetchAutoPublishFlags()).resolves.toEqual({ releases: false, news: false });
  });

  it("missing flag keys (older backend) stay off", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => settingsResponse({ pdCollection: false, dogsBooking: true })),
    );
    await expect(fetchAutoPublishFlags()).resolves.toEqual({ releases: false, news: false });
  });
});
