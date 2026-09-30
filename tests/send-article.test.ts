import { it, vi, expect, describe, afterEach } from "vitest";

const { sendRichMessage, deliverArticle } = await import("../src/channelDigest/sendArticle.js");

import type { Article } from "../src/channelDigest/types.js";

const ARTICLE: Article = {
  html: '<img src="tg://photo?id=cover"/>\n<h3>AI за утро · 1 октября</h3>',
  photos: [
    { id: "cover", blob: new Blob([new Uint8Array([1])], { type: "image/png" }) },
    { id: "p0", blob: new Blob([new Uint8Array([2])], { type: "image/jpeg" }) },
  ],
  items: [],
};

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
const methodOf = (url: string) => url.split("/").pop();

afterEach(() => vi.unstubAllGlobals());

describe("sendRichMessage", () => {
  it("posts chat_id, rich_message and every photo as a file under its id", async () => {
    const fetchMock = stub(ok(77));

    await expect(sendRichMessage(123, ARTICLE)).resolves.toBe(77);

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(methodOf(url)).toBe("sendRichMessage");
    const form = init!.body as FormData;
    expect(form.get("chat_id")).toBe("123");
    expect(JSON.parse(String(form.get("rich_message")))).toEqual({
      html: ARTICLE.html,
      media: [
        { id: "cover", media: { type: "photo", media: "attach://cover" } },
        { id: "p0", media: { type: "photo", media: "attach://p0" } },
      ],
    });
    expect((form.get("cover") as File).name).toBe("cover.png");
    expect((form.get("p0") as File).name).toBe("p0.jpeg");
  });
});

describe("deliverArticle", () => {
  it("sends the text fallback when Telegram rejects the rich message", async () => {
    const fetchMock = stub(
      tg(400, { ok: false, description: "Bad Request: RICH_MESSAGE_INVALID" }),
      ok(78),
    );

    await expect(deliverArticle("@ch", ARTICLE, "<b>текст</b>")).resolves.toEqual({
      messageId: 78,
      rejected: "Bad Request: RICH_MESSAGE_INVALID",
    });

    const [url, init] = fetchMock.mock.calls[1]!;
    expect(methodOf(url)).toBe("sendMessage");
    expect(JSON.parse(String(init!.body))).toMatchObject({
      chat_id: "@ch",
      text: "<b>текст</b>",
      parse_mode: "HTML",
    });
  });

  it.each([429, 403])(
    "does not fall back on %i: the text would fail the same way",
    async (status) => {
      const fetchMock = stub(tg(status, { ok: false, description: "nope" }));
      await expect(deliverArticle("@ch", ARTICLE, "t")).rejects.toMatchObject({
        status,
        maybePosted: false,
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    },
  );

  it("treats a 5xx or a network error as maybe posted", async () => {
    stub(tg(502, { ok: false, description: "Bad Gateway" }));
    await expect(deliverArticle("@ch", ARTICLE, "t")).rejects.toMatchObject({ maybePosted: true });
    stub(new TypeError("fetch failed"));
    await expect(deliverArticle("@ch", ARTICLE, "t")).rejects.toMatchObject({ maybePosted: true });
  });
});
