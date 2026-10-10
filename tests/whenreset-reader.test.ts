import { it, vi, expect, afterEach } from "vitest";

import { readWhenReset } from "../src/whenreset/readWhenReset.js";

const event = {
  id: "official-1",
  date: "2026-10-11",
  ts: null,
  type: "reset",
  kind: "regular",
  scope: "all",
  url: "https://x.com/OpenAIDevs/status/123",
  summary: "We might reset tomorrow.",
  page: "https://whenreset.app/codex/2026-10-11/",
};
const snapshot = {
  schema: "whenreset/v1",
  generated_at: "2026-10-11T00:00:00Z",
  products: {
    codex: { events: [event], stats: { total: 1, banked_count: 0 } },
    claude: {
      stats: { total: 0, banked_count: 1 },
      events: [{ ...event, kind: "banked", page: "https://whenreset.app/claude/2026-10-11/" }],
    },
  },
};

afterEach(() => vi.unstubAllGlobals());

it("reads the full API with timeout and preserves cautious, attributed input for both kinds", async () => {
  const body = {
    ...snapshot,
    products: {
      ...snapshot.products,
      codex: {
        ...snapshot.products.codex,
        events: [
          event,
          { ...event, id: "future-type", type: "forecast" },
          { ...event, id: "future-kind", kind: "unknown" },
        ],
      },
    },
  };
  const fetchMock = vi.fn(async () => new Response(JSON.stringify(body)));
  vi.stubGlobal("fetch", fetchMock);
  const items = await readWhenReset();
  expect(fetchMock).toHaveBeenCalledWith(
    "https://whenreset.app/api/v1/resets.json",
    expect.objectContaining({ signal: expect.any(AbortSignal), redirect: "error" }),
  );
  expect(items.map((i) => i.dedupKey)).toEqual([
    "whenreset:codex:official-1",
    "whenreset:claude:official-1",
  ]);
  expect(items[0]).toMatchObject({
    url: event.page,
    title: "Codex: сообщение о сбросе лимитов",
    kind: "news",
  });
  expect(items[0]?.snippet).toContain(event.summary);
  expect(items[0]?.snippet).toContain(event.url);
  expect(items[0]?.snippet).toContain("https://codex-resets.com");
  expect(items[0]?.snippet).toContain("не подтверждает восстановление лимита конкретного аккаунта");
  expect(items[1]?.title).toContain("резервном сбросе");
  expect(items[1]?.snippet).toContain("https://claude-resets.com");
});

it.each([
  { ...snapshot, schema: "whenreset/v2" },
  { ...snapshot, products: { codex: { events: [event] } } },
  {
    ...snapshot,
    products: {
      ...snapshot.products,
      codex: { ...snapshot.products.codex, events: [{ ...event, date: "2026-99-99" }] },
    },
  },
  {
    ...snapshot,
    products: {
      ...snapshot.products,
      codex: {
        ...snapshot.products.codex,
        events: [{ ...event, page: "https://example.com/stolen" }],
      },
    },
  },
])("rejects incomplete or invalid snapshots without ingesting a partial baseline", async (body) => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify(body))),
  );
  await expect(readWhenReset()).rejects.toThrow("WhenReset");
});

it("rejects status failures and redacts untrusted network errors", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response("private details", { status: 503 })),
  );
  await expect(readWhenReset()).rejects.toThrow("HTTP 503");
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      throw new Error("https://private.test/token?key=do-not-repeat");
    }),
  );
  await expect(readWhenReset()).rejects.toThrow(
    /^WhenReset: API недоступен или ответ не прошёл проверку\.$/,
  );
});

it.each([
  ["codex", "regular"],
  ["codex", "banked"],
  ["claude", "regular"],
  ["claude", "banked"],
] as const)(
  "rejects missing %s %s history against preserved product stats",
  async (product, kind) => {
    const body = structuredClone(snapshot);
    body.products[product].stats = { total: 1, banked_count: 1 };
    body.products[product].events = [
      {
        ...event,
        kind: kind === "regular" ? "banked" : "regular",
        page: `https://whenreset.app/${product}/2026-10-11/`,
      },
    ];
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify(body))),
    );
    await expect(readWhenReset()).rejects.toThrow("WhenReset");
  },
);
