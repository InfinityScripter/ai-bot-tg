import { rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { it, vi, expect, afterEach } from "vitest";

import { CandidateState } from "../src/enums.js";
import { CandidateStore } from "../src/store/index.js";
import { runWhenResetWatch } from "../src/server/runWhenResetWatch.js";

const event = {
  id: "old",
  date: "2026-10-09",
  ts: "2026-10-09T00:00:00Z",
  type: "reset",
  kind: "regular",
  scope: "all",
  url: "https://x.com/OpenAIDevs/status/1",
  summary: "Reset announced",
  page: "https://whenreset.app/codex/2026-10-09/",
};
const snapshot = (events = [event]) => ({
  schema: "whenreset/v1",
  generated_at: "2026-10-11T00:00:00Z",
  products: {
    codex: { events, stats: { total: events.length, banked_count: 0 } },
    claude: { events: [], stats: { total: 0, banked_count: 0 } },
  },
});
afterEach(() => vi.unstubAllGlobals());

it("baselines all history without posting then publishes new events oldest first and dedups across restart", async () => {
  const path = `/private/tmp/whenreset-test-${randomUUID()}.db`;
  let store = new CandidateStore(path);
  const processed: string[] = [];
  const process = vi.fn(async (candidate: { id: number; dedupKey: string }) => {
    processed.push(candidate.dedupKey);
    store.setPublished(candidate.id, "preview");
  });
  let events = [event];
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify(snapshot(events)))),
  );
  try {
    expect(await runWhenResetWatch(store, process)).toMatchObject({
      baselined: true,
      fetched: 1,
      fresh: 0,
    });
    expect(process).not.toHaveBeenCalled();
    expect(store.isSeen("whenreset:codex:old")).toBe(true);
    store.close();
    store = new CandidateStore(path);
    events = [
      { ...event, id: "newest", ts: "2026-10-11T02:00:00Z" },
      event,
      { ...event, id: "new", ts: "2026-10-11T01:00:00Z" },
    ];
    expect(await runWhenResetWatch(store, process)).toMatchObject({ baselined: false, fresh: 2 });
    expect(processed).toEqual(["whenreset:codex:new", "whenreset:codex:newest"]);
    store.close();
    store = new CandidateStore(path);
    events.reverse();
    await runWhenResetWatch(store, process);
    expect(process).toHaveBeenCalledTimes(2);
  } finally {
    store.close();
    rmSync(path, { force: true });
  }
});

it("invalid initial sync never completes the baseline", async () => {
  const store = new CandidateStore(":memory:");
  const process = vi.fn(async () => {});
  const fetchMock = vi
    .fn()
    .mockResolvedValueOnce(new Response("{}"))
    .mockResolvedValueOnce(new Response(JSON.stringify(snapshot())));
  vi.stubGlobal("fetch", fetchMock);
  try {
    await expect(runWhenResetWatch(store, process)).rejects.toThrow("WhenReset");
    expect(await runWhenResetWatch(store, process)).toMatchObject({ baselined: true });
    expect(process).not.toHaveBeenCalled();
  } finally {
    store.close();
  }
});

it("recovers only automatic collected WhenReset rows; uncertain publishes stay untouched", async () => {
  const store = new CandidateStore(":memory:");
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify(snapshot()))),
  );
  try {
    await runWhenResetWatch(store, async () => {});
    const item = {
      dedupKey: "whenreset:codex:recovered",
      url: event.page,
      title: "Source",
      snippet: "Text",
      feedTitle: "WhenReset",
      imageUrl: null,
      imageUrls: [],
      publishedAt: null,
    };
    const recovered = store.insertCollected(item, true)!;
    const manual = store.insertCollected({ ...item, dedupKey: "whenreset:codex:manual" })!;
    const other = store.insertCollected({ ...item, dedupKey: "rss:other" }, true)!;
    const uncertain = store.insertCollected(
      { ...item, dedupKey: "whenreset:codex:uncertain" },
      true,
    )!;
    store.setState(uncertain, CandidateState.NeedsVerification);
    const process = vi.fn(async (candidate: { id: number }) =>
      store.setPublished(candidate.id, "preview"),
    );
    expect(await runWhenResetWatch(store, process)).toMatchObject({ recovered: 1 });
    expect(process).toHaveBeenCalledWith(expect.objectContaining({ id: recovered }));
    expect(store.get(manual)?.state).toBe(CandidateState.Collected);
    expect(store.get(other)?.state).toBe(CandidateState.Collected);
    expect(store.get(uncertain)?.state).toBe(CandidateState.NeedsVerification);
  } finally {
    store.close();
  }
});

it("keeps failed RAW cards recoverable and continues other new events", async () => {
  const store = new CandidateStore(":memory:");
  let events = [event];
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify(snapshot(events)))),
  );
  try {
    await runWhenResetWatch(store, async () => {});
    events = [event, { ...event, id: "a" }, { ...event, id: "b" }];
    const process = vi
      .fn()
      .mockRejectedValueOnce(new Error("owner offline"))
      .mockImplementation(async (candidate: { id: number }) =>
        store.clearAutoPublish(candidate.id),
      );
    expect(await runWhenResetWatch(store, process)).toMatchObject({ fresh: 2, failed: 1 });
    expect(store.listRecoveredAutomatic()).toHaveLength(1);
    await runWhenResetWatch(store, process);
    expect(process).toHaveBeenCalledTimes(3);
    expect(store.listRecoveredAutomatic()).toHaveLength(0);
  } finally {
    store.close();
  }
});

it("rejects partial 73-event history without recording baseline or later publishing its archive", async () => {
  const store = new CandidateStore(":memory:");
  const process = vi.fn(async () => {});
  const full = {
    ...snapshot(),
    products: {
      codex: {
        stats: { total: 52, banked_count: 7 },
        events: Array.from({ length: 59 }, (_, i) => ({
          ...event,
          id: `codex-${i}`,
          kind: i < 52 ? "regular" : "banked",
        })),
      },
      claude: {
        stats: { total: 13, banked_count: 1 },
        events: Array.from({ length: 14 }, (_, i) => ({
          ...event,
          id: `claude-${i}`,
          kind: i < 13 ? "regular" : "banked",
          page: "https://whenreset.app/claude/2026-10-09/",
        })),
      },
    },
  };
  const partial = structuredClone(full);
  partial.products.codex.events = [full.products.codex.events[0]!];
  partial.products.claude.events = [];
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(partial)))
      .mockImplementation(async () => new Response(JSON.stringify(full))),
  );
  try {
    await expect(runWhenResetWatch(store, process)).rejects.toThrow("WhenReset");
    expect(store.getRawSetting("whenreset:baseline:v1")).toBeNull();
    expect(store.isSeen("whenreset:codex:codex-0")).toBe(false);
    expect(await runWhenResetWatch(store, process)).toMatchObject({
      baselined: true,
      fetched: 73,
      fresh: 0,
    });
    await runWhenResetWatch(store, process);
    expect(process).not.toHaveBeenCalled();
  } finally {
    store.close();
  }
});

it("recovers saved automatic rows before failed GET and never retries uncertain or published rows", async () => {
  const store = new CandidateStore(":memory:");
  const fetchMock = vi.fn(async () => new Response("unavailable", { status: 503 }));
  vi.stubGlobal("fetch", fetchMock);
  try {
    store.setRawSetting("whenreset:baseline:v1", "1");
    store.markSeenKeys(["whenreset:codex:old"]);
    const item = {
      dedupKey: "whenreset:codex:recovered",
      url: event.page,
      title: "Source",
      snippet: "Text",
      feedTitle: "WhenReset",
      imageUrl: null,
      imageUrls: [],
      publishedAt: null,
    };
    const recovered = store.insertCollected(item, true)!;
    const manual = store.insertCollected({ ...item, dedupKey: "whenreset:codex:manual" })!;
    const other = store.insertCollected({ ...item, dedupKey: "rss:other" }, true)!;
    const uncertain = store.insertCollected(
      { ...item, dedupKey: "whenreset:codex:uncertain" },
      true,
    )!;
    store.setState(uncertain, CandidateState.NeedsVerification);
    const process = vi.fn(async (candidate: { id: number }) => {
      expect(fetchMock).not.toHaveBeenCalled();
      store.setPublished(candidate.id, "preview");
    });
    await expect(runWhenResetWatch(store, process)).rejects.toThrow("HTTP 503");
    expect(process).toHaveBeenCalledWith(expect.objectContaining({ id: recovered }));
    await expect(runWhenResetWatch(store, process)).rejects.toThrow("HTTP 503");
    fetchMock.mockImplementation(async () => new Response(JSON.stringify(snapshot())));
    expect(await runWhenResetWatch(store, process)).toMatchObject({ recovered: 0, fresh: 0 });
    expect(process).toHaveBeenCalledTimes(1);
    expect(store.get(manual)?.state).toBe(CandidateState.Collected);
    expect(store.get(other)?.state).toBe(CandidateState.Collected);
    expect(store.get(uncertain)?.state).toBe(CandidateState.NeedsVerification);
  } finally {
    store.close();
  }
});
