import { it, vi, expect, afterEach } from "vitest";

import type { FeedItem, BlogPostBody } from "../src/types.js";

vi.stubEnv("TELEGRAM_CHANNEL_ID", "@local-whenreset-preview");
const enrichment = vi.fn(async (item: FeedItem) => item);
vi.mock("../src/feeds/index.js", async (original) => ({
  ...(await original<typeof import("../src/feeds/index.js")>()),
  enrichItemBody: (item: FeedItem) => enrichment(item),
}));
const completion = vi.fn();
vi.mock("../src/llm/chatCompletion.js", async (original) => ({
  ...(await original<typeof import("../src/llm/chatCompletion.js")>()),
  completeChatJson: (...args: unknown[]) => completion(...args),
}));
const { readWhenReset } = await import("../src/whenreset/readWhenReset.js");
const { createProcessCandidate } = await import("../src/server/createProcessCandidate.js");
const { CandidateStore } = await import("../src/store/index.js");
const { createBot } = await import("../src/bot/index.js");
const { CandidateState } = await import("../src/enums.js");
const nativeFetch = globalThis.fetch;
const snapshot = {
  schema: "whenreset/v1",
  generated_at: "2026-10-07T16:15:44Z",
  products: {
    codex: {
      stats: { total: 1, banked_count: 0 },
      events: [
        {
          id: "2107676072871600470",
          date: "2026-10-07",
          ts: "2026-10-07T03:35:09Z",
          type: "reset",
          kind: "regular",
          scope: "all",
          url: "https://x.com/thsottiaux/status/2107676072871600470",
          summary:
            "We shipped four things that were deemed good to great and some math proofs, but the vote is clear and the community demands a reset. I did calibrate it and it *seems* that the game is rigged in reset's favor, but such are the rules at the moment. Therefore ... the reset has been ",
          page: "https://whenreset.app/codex/2026-10-07/",
        },
      ],
    },
    claude: { events: [], stats: { total: 0, banked_count: 0 } },
  },
};
afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

it("previews actual API mapper → candidate → real rewrite finalizer/gate → one blog POST and one channel card", async () => {
  const posts: BlogPostBody[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url === "https://whenreset.app/api/v1/resets.json") {
        return process.env.WHENRESET_LIVE === "1"
          ? nativeFetch(input, init)
          : new Response(JSON.stringify(snapshot));
      }
      if (url.endsWith("/api/admin/settings"))
        return new Response(JSON.stringify({ data: { flags: { autoPublishNews: true } } }));
      if (url.endsWith("/api/post/new")) {
        posts.push(JSON.parse(String(init?.body)) as BlogPostBody);
        return new Response(JSON.stringify({ post: { id: "local-preview" } }), { status: 201 });
      }
      throw new Error("Unexpected outbound request in preview");
    }),
  );
  const items = await readWhenReset();
  const item = items[items.length - 1]!;
  const official = item.snippet.match(/Официальное сообщение: (https:\/\/\S+)/)![1]!;
  completion.mockResolvedValue(
    JSON.stringify({
      title: item.title,
      description:
        "WhenReset добавил сообщение; восстановление конкретного аккаунта не подтверждено.",
      content: `${item.snippet}\n\n[Официальное сообщение](${official})\n\n[Архив](https://${item.dedupKey.includes(":codex:") ? "codex" : "claude"}-resets.com)`,
      tags: ["новости"],
      metaTitle: item.title,
      metaDescription: "Сообщение WhenReset о лимитах.",
    }),
  );
  const store = new CandidateStore(":memory:");
  const bot = createBot(store, async () => {});
  const telegram: Array<{
    method: string;
    payload: { chat_id?: string; caption?: string; text?: string };
  }> = [];
  bot.bot.api.config.use((_previous, method, payload) => {
    telegram.push({ method, payload: payload as never });
    return Promise.resolve({ ok: true, result: { message_id: 42 } } as never);
  });
  try {
    const id = store.insertCollected(item, true)!;
    const processCandidate = await createProcessCandidate(
      store,
      { autoPublish: bot.autoPublishCandidate, sendRawCard: bot.sendRawCard },
      true,
    );
    await processCandidate(store.get(id)!);
    expect(enrichment).not.toHaveBeenCalled();
    expect(posts).toHaveLength(1);
    expect(posts[0]?.content).toContain(`](${official})`);
    expect(posts[0]?.content).toMatch(/-resets\.com\/?\)/);
    expect(posts[0]?.content).toContain(`](${item.url})`);
    expect(store.get(id)?.state).toBe(CandidateState.Published);
    expect(store.listDigestQueue()).toHaveLength(0);
    const channel = telegram.filter(
      ({ payload }) => payload.chat_id === "@local-whenreset-preview",
    );
    expect(channel).toHaveLength(1);
    expect(channel[0]?.payload.caption ?? channel[0]?.payload.text).toContain(
      "/post/local-preview",
    );
    if (process.env.WHENRESET_LIVE === "1") {
      console.log(
        `[whenreset-preview] ${JSON.stringify({ source: item.url, post: posts[0], channel: channel[0]?.payload.caption ?? channel[0]?.payload.text })}`,
      );
    }
  } finally {
    await bot.drain();
    store.close();
  }
});
