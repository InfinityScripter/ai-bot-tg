import { it, vi, expect, describe, afterEach } from "vitest";

import { sendDigest } from "../src/blog/sendDigest.js";

const SUBJECT = "Еженедельный AI-дайджест";
const HTML = "<h2>Дайджест</h2><p>{{ВЕРДИКТ}}</p>";

/** A 200 with the ok() envelope { success, data: { sent, failed } }. */
function sentResponse(sent: number, failed: number): Response {
  return new Response(JSON.stringify({ success: true, data: { sent, failed } }), {
    status: 200,
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("sendDigest", () => {
  it("POSTs to /api/newsletter/send with Bearer + body {subject,html} and reads data.data.sent", async () => {
    const fetchMock = vi.fn(async () => sentResponse(12, 1));
    vi.stubGlobal("fetch", fetchMock);

    const result = await sendDigest(SUBJECT, HTML);
    expect(result).toEqual({ sent: 12, failed: 1 });

    const call = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(String(call[0])).toBe("http://localhost:7272/api/newsletter/send");
    expect(call[1].method).toBe("POST");
    const headers = call[1].headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer test-bot-api-token-value");
    expect(JSON.parse(String(call[1].body))).toEqual({ subject: SUBJECT, html: HTML });
  });

  it("defaults counts to 0 when the envelope omits sent/failed", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ success: true, data: {} }), { status: 200 })),
    );
    await expect(sendDigest(SUBJECT, HTML)).resolves.toEqual({ sent: 0, failed: 0 });
  });

  it("sends an Idempotency-Key header when a dedup key is given", async () => {
    const fetchMock = vi.fn(async () => sentResponse(1, 0));
    vi.stubGlobal("fetch", fetchMock);

    await sendDigest(SUBJECT, HTML, "digest-2026-06-30");
    const call = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const headers = call[1].headers as Record<string, string>;
    expect(headers["Idempotency-Key"]).toBe("digest-2026-06-30");
  });

  it("throws PublishError(maybePosted=false) on a 4xx (nothing sent)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("bad", { status: 400 })),
    );
    await expect(sendDigest(SUBJECT, HTML)).rejects.toMatchObject({
      name: "PublishError",
      maybePosted: false,
    });
  });

  it("throws PublishError(maybePosted=true) on a 5xx (may have partially sent)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("oops", { status: 502 })),
    );
    await expect(sendDigest(SUBJECT, HTML)).rejects.toMatchObject({ maybePosted: true });
  });

  it("throws PublishError(maybePosted=true) on a 200 with an unreadable body", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("not json", { status: 200 })),
    );
    await expect(sendDigest(SUBJECT, HTML)).rejects.toMatchObject({ maybePosted: true });
  });

  it("throws PublishError(maybePosted=false) when it cannot connect", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("ECONNREFUSED");
      }),
    );
    await expect(sendDigest(SUBJECT, HTML)).rejects.toMatchObject({ maybePosted: false });
  });
});
