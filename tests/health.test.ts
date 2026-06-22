import { it, vi, expect, describe } from "vitest";

import { CandidateState } from "../src/enums.js";
import { CandidateStore } from "../src/store/index.js";
import { renderHealth, collectHealth } from "../src/health/index.js";

/** A store with a couple of candidates so the queue summary has content. */
function seededStore(): CandidateStore {
  const store = new CandidateStore(":memory:");
  const id = store.insertCollected({
    dedupKey: "k1",
    url: "https://ex.com/1",
    title: "T",
    snippet: "s",
    feedTitle: "F",
    imageUrl: null,
    imageUrls: [],
    publishedAt: null,
  })!;
  store.setState(id, CandidateState.NeedsVerification);
  return store;
}

const okPing = vi.fn(async () => ({ ok: true as const }));
const okFetch = vi.fn(async () => ({ status: 200 }) as Response);
const nextRun = () => new Date("2026-07-01T09:00:00.000Z");

describe("collectHealth", () => {
  it("reports healthy when the provider pings and the blog answers", async () => {
    const store = seededStore();
    const report = await collectHealth(store, {
      pingFn: okPing,
      fetchFn: okFetch,
      nextRun,
      uptimeSec: () => 3661,
    });

    expect(report.healthy).toBe(true);
    const byName = new Map(report.checks.map((c) => [c.name, c]));
    expect(byName.get("Процесс")!.ok).toBe(true);
    expect(byName.get("Расписание")!.detail).toContain("2026-07-01");
    expect(byName.get("LLM")!.ok).toBe(true);
    expect(byName.get("Блог API")!.ok).toBe(true);
    expect(report.queue[CandidateState.NeedsVerification]).toBe(1);
    store.close();
  });

  it("is unhealthy when the provider ping fails", async () => {
    const store = new CandidateStore(":memory:");
    const report = await collectHealth(store, {
      pingFn: vi.fn(async () => ({ ok: false as const, error: "no key" })),
      fetchFn: okFetch,
      nextRun,
    });
    expect(report.healthy).toBe(false);
    expect(report.checks.find((c) => c.name === "LLM")!.ok).toBe(false);
    store.close();
  });

  it("is unhealthy when the blog API is unreachable", async () => {
    const store = new CandidateStore(":memory:");
    const report = await collectHealth(store, {
      pingFn: okPing,
      fetchFn: vi.fn(async () => {
        throw new Error("ECONNREFUSED");
      }),
      nextRun,
    });
    expect(report.healthy).toBe(false);
    expect(report.checks.find((c) => c.name === "Блог API")!.ok).toBe(false);
    store.close();
  });

  it("never lets one failing probe abort the others", async () => {
    const store = new CandidateStore(":memory:");
    const report = await collectHealth(store, {
      pingFn: vi.fn(async () => {
        throw new Error("boom");
      }),
      fetchFn: okFetch,
      nextRun,
    });
    // A throwing pingFn is caught inside checkProvider, so the report still
    // resolves: LLM is marked not-ok and the blog probe still ran.
    expect(report.checks.find((c) => c.name === "LLM")!.ok).toBe(false);
    expect(report.checks.find((c) => c.name === "Блог API")!.ok).toBe(true);
    expect(report.healthy).toBe(false);
    store.close();
  });
});

describe("renderHealth", () => {
  it("leads with ✅ Всё ОК when healthy and lists each check", () => {
    const text = renderHealth({
      healthy: true,
      checks: [
        { name: "Процесс", ok: true, detail: "аптайм 1ч" },
        { name: "LLM", ok: true, detail: "Claude/haiku" },
      ],
      queue: {},
    });
    expect(text).toContain("✅ *Всё ОК*");
    expect(text).toContain("Процесс");
    expect(text).toContain("LLM");
    expect(text).toContain("Очередь пуста");
  });

  it("leads with ⚠️ when any check failed and shows the attention queue", () => {
    const text = renderHealth({
      healthy: false,
      checks: [{ name: "Блог API", ok: false, detail: "down" }],
      queue: { [CandidateState.NeedsVerification]: 2, [CandidateState.Published]: 5 },
    });
    expect(text).toContain("⚠️ *Есть проблемы*");
    expect(text).toContain("❌");
    expect(text).toContain("внимание");
    // The queue line is Markdown-escaped, so the underscore is backslash-escaped.
    expect(text).toContain("needs\\_verification=2");
  });
});
