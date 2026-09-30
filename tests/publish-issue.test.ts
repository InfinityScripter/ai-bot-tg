import { it, vi, expect, describe, afterEach, beforeEach } from "vitest";

vi.stubEnv("TELEGRAM_CHANNEL_ID", "@ai_first_news");
const { publishIssue } = await import("../src/channelDigest/publishIssue.js");
const { CandidateStore } = await import("../src/store/index.js");
import { CandidateKind, ChannelRubric, CandidateState } from "../src/enums.js";

import type { AssembledIssue } from "../src/channelDigest/types.js";

const SLOT = { key: "2026-10-01/morning", title: "AI за утро · 1 октября" };

let store: InstanceType<typeof CandidateStore>;
let notes: string[];
const notify = async (text: string) => {
  notes.push(text);
};

beforeEach(() => {
  store = new CandidateStore(":memory:");
  notes = [];
});

afterEach(() => {
  store.close();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function queued(n: number): number {
  return store.channelQueue.add(
    {
      dedupKey: `tg:a/${n}`,
      url: `https://t.me/a/${n}`,
      title: "t",
      snippet: "s",
      html: "s",
      feedTitle: "@a",
      imageUrl: null,
      imageUrls: [],
      publishedAt: Date.now(),
      kind: CandidateKind.Channel,
    },
    1,
  )!;
}

function issue(ids: number[]): AssembledIssue {
  const items = ids.map((candidateId) => ({
    candidateId,
    channel: "@a",
    emoji: "🔥",
    rubric: ChannelRubric.Model,
    title: `Новость ${candidateId}`,
    html: "Текст.",
    photos: [],
    linkKeys: [`link:https://ex.com/${candidateId}`],
  }));
  return {
    slot: SLOT,
    article: { html: "<h3>AI за утро · 1 октября</h3>", photos: [], items },
    fallbackText: "<b>AI за утро · 1 октября</b>",
  };
}

function tg(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), { status });
}
const ok = (id: number) => tg(200, { ok: true, result: { message_id: id } });

function stub(...replies: (Response | Error)[]) {
  const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => {
    const next = replies.shift();
    if (!next) throw new Error("unexpected call");
    if (next instanceof Error) throw next;
    return next;
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

const linkSeen = (id: number) => store.isSeenSince(`link:https://ex.com/${id}`, 3);

describe("publishIssue", () => {
  it("sends the article to the channel, marks the posts published and records the slot", async () => {
    const ids = [queued(1), queued(2), queued(3)];
    const fetchMock = stub(ok(700));

    await expect(publishIssue(store, issue(ids), notify)).resolves.toEqual({
      ok: true,
      outcome: "опубликован (3 новости)",
    });

    expect((fetchMock.mock.calls[0]![1]!.body as FormData).get("chat_id")).toBe("@ai_first_news");
    for (const id of ids) {
      expect(store.get(id)).toMatchObject({
        state: CandidateState.Published,
        blogPostId: "tg:700",
      });
      expect(linkSeen(id)).toBe(true);
    }
    expect(store.channelQueue.lastSlot()).toBe(SLOT.key);
    expect(notes).toEqual([]);
  });

  it("never sends the same slot twice", async () => {
    store.channelQueue.setLastSlot(SLOT.key);
    const ids = [queued(1), queued(2), queued(3)];
    const fetchMock = stub();

    await expect(publishIssue(store, issue(ids), notify)).resolves.toMatchObject({
      outcome: "уже выходил",
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(store.get(ids[0]!)!.state).toBe(CandidateState.DigestQueued);
  });

  it("goes out as text when Telegram rejects the article, and tells the owner", async () => {
    const ids = [queued(1), queued(2), queued(3)];
    stub(tg(400, { ok: false, description: "Bad Request: RICH_MESSAGE_INVALID" }), ok(701));

    const result = await publishIssue(store, issue(ids), notify);

    expect(result.ok).toBe(true);
    expect(store.get(ids[0]!)!.blogPostId).toBe("tg:701");
    expect(linkSeen(ids[0]!)).toBe(true);
    expect(notes[0]).toContain("RICH_MESSAGE_INVALID");
  });

  it("parks the posts in needs_verification and never resends when the outcome is unknown", async () => {
    const ids = [queued(1), queued(2), queued(3)];
    const fetchMock = stub(tg(502, { ok: false, description: "Bad Gateway" }));

    const result = await publishIssue(store, issue(ids), notify);

    expect(result.ok).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    for (const id of ids) {
      expect(store.get(id)!.state).toBe(CandidateState.NeedsVerification);
      expect(linkSeen(id)).toBe(false);
    }
    expect(store.channelQueue.lastSlot()).toBe(SLOT.key);
    expect(notes[0]).toContain("МОГ");
  });

  it("treats a network error like a 5xx: maybe posted, no resend", async () => {
    const ids = [queued(1), queued(2), queued(3)];
    const fetchMock = stub(new TypeError("fetch failed"));

    const result = await publishIssue(store, issue(ids), notify);

    expect(result.ok).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    for (const id of ids) expect(store.get(id)!.state).toBe(CandidateState.NeedsVerification);
    expect(store.channelQueue.lastSlot()).toBe(SLOT.key);
    expect(notes[0]).toContain("МОГ");
  });

  it("parks the posts when the text fallback itself ends in an unknown outcome", async () => {
    const ids = [queued(1), queued(2), queued(3)];
    stub(tg(400, { ok: false, description: "RICH_MESSAGE_INVALID" }), tg(500, { ok: false }));

    const result = await publishIssue(store, issue(ids), notify);

    expect(result.ok).toBe(false);
    for (const id of ids) expect(store.get(id)!.state).toBe(CandidateState.NeedsVerification);
    expect(store.channelQueue.lastSlot()).toBe(SLOT.key);
  });

  it.each([429, 403])("returns the posts to the queue on %i", async (status) => {
    const ids = [queued(1), queued(2), queued(3)];
    stub(tg(status, { ok: false, description: "nope" }));

    const result = await publishIssue(store, issue(ids), notify);

    expect(result.ok).toBe(false);
    for (const id of ids) {
      expect(store.get(id)!.state).toBe(CandidateState.DigestQueued);
      expect(linkSeen(id)).toBe(false);
    }
    expect(store.channelQueue.lastSlot()).toBeNull();
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain("остались в очереди");
  });

  it("sends nothing when a post left the queue after the issue was built", async () => {
    const ids = [queued(1), queued(2), queued(3)];
    store.setState(ids[2]!, CandidateState.Skipped);
    const fetchMock = stub();

    const result = await publishIssue(store, issue(ids), notify);

    expect(result.ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(store.get(ids[0]!)!.state).toBe(CandidateState.DigestQueued);
    expect(store.get(ids[1]!)!.state).toBe(CandidateState.DigestQueued);
    expect(notes).toHaveLength(1);
  });

  it("never puts a sent issue back in the queue when the bookkeeping afterwards fails", async () => {
    const ids = [queued(1), queued(2), queued(3)];
    stub(ok(702));
    vi.spyOn(store, "setPublished").mockImplementation(() => {
      throw new Error("disk I/O error");
    });

    const result = await publishIssue(store, issue(ids), notify);

    expect(result.ok).toBe(true);
    expect(store.channelQueue.lastSlot()).toBe(SLOT.key);
    for (const id of ids) expect(store.get(id)!.state).toBe(CandidateState.Publishing);
  });

  it("keeps the outcome when the owner note cannot be delivered", async () => {
    const ids = [queued(1), queued(2), queued(3)];
    stub(tg(502, { ok: false, description: "Bad Gateway" }));

    const result = await publishIssue(store, issue(ids), async () => {
      throw new Error("owner DM failed");
    });

    expect(result.ok).toBe(false);
    for (const id of ids) expect(store.get(id)!.state).toBe(CandidateState.NeedsVerification);
  });
});
