import { it, vi, expect, describe, afterEach, beforeEach } from "vitest";

const writeDigestItem = vi.fn();
vi.mock("../src/llm/writeDigestItem.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/llm/writeDigestItem.js")>();
  return { ...actual, writeDigestItem: (...a: unknown[]) => writeDigestItem(...a) };
});
const downloadImage = vi.fn(
  async (_url: string): Promise<Blob | null> =>
    new Blob([new Uint8Array(3)], { type: "image/jpeg" }),
);
vi.mock("../src/blog/downloadImage.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/blog/downloadImage.js")>();
  return { ...actual, downloadImage: (url: string) => downloadImage(url) };
});
const tryRenderCover = vi.fn((): Uint8Array | null => new Uint8Array([1, 2, 3]));
vi.mock("../src/blog/renderCover.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/blog/renderCover.js")>();
  return { ...actual, tryRenderCover: () => tryRenderCover() };
});

const { assembleIssue } = await import("../src/channelDigest/assembleIssue.js");
const { CandidateStore } = await import("../src/store/index.js");
import { CandidateKind, ChannelRubric, CandidateState } from "../src/enums.js";

const NOW = Date.parse("2026-10-01T08:00:00Z");
const HOUR = 3_600_000;
const SLOT = { key: "2026-10-01/morning", title: "AI за утро · 1 октября" };

let store: InstanceType<typeof CandidateStore>;

beforeEach(() => {
  store = new CandidateStore(":memory:");
});

afterEach(() => {
  store.close();
  vi.useRealTimers();
  writeDigestItem.mockReset();
  downloadImage.mockClear();
  tryRenderCover.mockClear();
});

function queue(channel: string, over: { publishedAt?: number; imageUrls?: string[] } = {}): number {
  return store.channelQueue.add(
    {
      dedupKey: `tg:${channel}/1`,
      url: `https://t.me/${channel}/1`,
      title: `Пост ${channel}`,
      snippet: `Текст поста ${channel}.`,
      html: `Текст поста ${channel}. <a href="https://ex.com/${channel}">статья</a>`,
      feedTitle: `@${channel}`,
      imageUrl: null,
      imageUrls: over.imageUrls ?? [],
      publishedAt: over.publishedAt ?? NOW - 3 * HOUR,
      kind: CandidateKind.Channel,
    },
    1,
  )!;
}

const card = (title: string) => ({
  emoji: "🔥",
  rubric: ChannelRubric.Model,
  title,
  html: `${title}: текст.`,
});

describe("assembleIssue", () => {
  it("writes the picked posts into one article; not-news is skipped, a failure stays queued", async () => {
    const [a, b, c, d, e] = ["a", "b", "c", "d", "e"].map((ch) => queue(ch));
    writeDigestItem
      .mockResolvedValueOnce(card("Первая"))
      .mockResolvedValueOnce(null)
      .mockRejectedValueOnce(new Error("число 7, которого нет в посте"))
      .mockResolvedValueOnce(card("Четвёртая"))
      .mockResolvedValueOnce(card("Пятая"));

    const { assembled, picked, written } = await assembleIssue(store, SLOT, NOW);

    expect({ picked, written }).toEqual({ picked: 5, written: 3 });
    expect(assembled!.article.items.map((i) => i.candidateId)).toEqual([a, d, e]);
    expect(assembled!.article.items[0]).toMatchObject({
      channel: "@a",
      linkKeys: ["link:https://ex.com/a"],
    });
    expect(assembled!.article.html).toContain("<h3>AI за утро · 1 октября</h3>");
    expect(assembled!.article.photos[0]?.id).toBe("cover");
    expect(assembled!.fallbackText).toContain("<b>🔥 Четвёртая</b>");
    expect(store.get(b!)!.state).toBe(CandidateState.Skipped);
    for (const id of [a, c, d, e]) expect(store.get(id!)!.state).toBe(CandidateState.DigestQueued);
  });

  it("builds nothing when fewer than 3 cards come out, leaves the posts queued", async () => {
    const ids = ["a", "b", "c"].map((ch) => queue(ch));
    writeDigestItem
      .mockResolvedValueOnce(card("Первая"))
      .mockRejectedValueOnce(new Error("boom"))
      .mockRejectedValueOnce(new Error("boom"));

    const result = await assembleIssue(store, SLOT, NOW);

    expect(result).toEqual({ assembled: null, picked: 3, written: 1 });
    for (const id of ids)
      expect(store.get(id)).toMatchObject({ state: CandidateState.DigestQueued });
  });

  it("ages out posts published more than 24 h ago before picking", async () => {
    const old = queue("old", { publishedAt: NOW - 25 * HOUR });
    ["a", "b", "c"].forEach((ch) => queue(ch));
    writeDigestItem.mockImplementation(async () => card("Карточка"));

    const { picked } = await assembleIssue(store, SLOT, NOW);

    expect(picked).toBe(3);
    expect(store.get(old)!.state).toBe(CandidateState.Skipped);
    expect(writeDigestItem).toHaveBeenCalledTimes(3);
  });

  it("measures the 24 h window from the given `now`, not from the clock", async () => {
    vi.useFakeTimers({ now: NOW + 48 * HOUR });
    const fresh = queue("fresh", { publishedAt: NOW - 23 * HOUR });
    ["a", "b"].forEach((ch) => queue(ch));
    writeDigestItem.mockImplementation(async () => card("Карточка"));

    const { picked } = await assembleIssue(store, SLOT, NOW);

    expect(picked).toBe(3);
    expect(store.get(fresh)!.state).toBe(CandidateState.DigestQueued);
  });

  it("keeps the slot it was given even when writing runs past the slot boundary", async () => {
    ["a", "b", "c"].forEach((ch) => queue(ch));
    vi.useFakeTimers({ now: Date.parse("2026-10-01T15:59:00Z") });
    writeDigestItem.mockImplementation(async () => {
      vi.setSystemTime(Date.parse("2026-10-01T16:05:00Z"));
      return card("Карточка");
    });

    const { assembled } = await assembleIssue(store, SLOT, Date.parse("2026-10-01T15:59:00Z"));

    expect(assembled!.slot).toEqual(SLOT);
    expect(assembled!.article.html).toContain("<h3>AI за утро · 1 октября</h3>");
    expect(assembled!.fallbackText).toContain("AI за утро · 1 октября");
  });

  it("does not claim the posts while it writes: they stay digest_queued until the send", async () => {
    const ids = ["a", "b", "c"].map((ch) => queue(ch));
    const seen: CandidateState[][] = [];
    writeDigestItem.mockImplementation(async () => {
      seen.push(ids.map((id) => store.get(id)!.state));
      return card("Карточка");
    });

    await assembleIssue(store, SLOT, NOW);

    for (const states of seen) expect(states).toEqual(ids.map(() => CandidateState.DigestQueued));
    for (const id of ids) expect(store.get(id)!.state).toBe(CandidateState.DigestQueued);
  });

  it("downloads at most 4 photos per post", async () => {
    queue("a", {
      imageUrls: Array.from({ length: 6 }, (_, i) => `https://cdn4.telesco.pe/file/${i}.jpg`),
    });
    queue("b");
    queue("c");
    writeDigestItem.mockImplementation(async () => card("Карточка"));

    const { assembled } = await assembleIssue(store, SLOT, NOW);

    expect(downloadImage).toHaveBeenCalledTimes(4);
    expect(assembled!.article.photos.map((p) => p.id)).toEqual(["cover", "p0", "p1", "p2", "p3"]);
  });

  it("goes on without a photo that failed to download and without a cover that failed to render", async () => {
    queue("a", { imageUrls: ["https://cdn4.telesco.pe/file/0.jpg"] });
    queue("b");
    queue("c");
    writeDigestItem.mockImplementation(async () => card("Карточка"));
    downloadImage.mockResolvedValueOnce(null);
    tryRenderCover.mockReturnValueOnce(null);

    const { assembled } = await assembleIssue(store, SLOT, NOW);

    expect(assembled!.article.photos).toEqual([]);
    expect(assembled!.article.items).toHaveLength(3);
    expect(assembled!.article.html).not.toContain("tg://photo");
  });
});
