import { it, vi, expect, describe } from "vitest";

import { RelevanceMode, RelevanceStage, RelevanceAuditAction } from "../src/enums.js";
import {
  relevanceActionFor,
  emitRelevanceDecision,
  emitRelevanceDecisions,
} from "../src/audit-emit.js";

import type { RelevanceDecision } from "../src/relevance.js";

function decision(overrides: Partial<RelevanceDecision> = {}): RelevanceDecision {
  return {
    url: "https://ex.com/post",
    title: "A title",
    kept: false,
    stage: RelevanceStage.Llm,
    score: 1,
    reason: "score=1 threshold=2",
    ...overrides,
  };
}

/** A fake fetch that records the last request and returns a controllable Response-ish. */
function fakeFetch(result: { ok?: boolean; status?: number } = {}) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchFn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return {
      ok: result.ok ?? true,
      status: result.status ?? 200,
      text: async () => "",
      json: async () => ({}),
    } as Response;
  });
  return { fetchFn: fetchFn as unknown as typeof fetch, calls };
}

describe("relevanceActionFor", () => {
  it("kept decision → bot.relevance_kept (any mode)", () => {
    expect(relevanceActionFor(decision({ kept: true }), RelevanceMode.On)).toBe(
      RelevanceAuditAction.Kept,
    );
    expect(relevanceActionFor(decision({ kept: true }), RelevanceMode.Shadow)).toBe(
      RelevanceAuditAction.Kept,
    );
  });

  it("dropped in shadow mode → bot.relevance_shadow_dropped", () => {
    expect(relevanceActionFor(decision({ kept: false }), RelevanceMode.Shadow)).toBe(
      RelevanceAuditAction.ShadowDropped,
    );
  });

  it("dropped in on mode → bot.relevance_dropped", () => {
    expect(relevanceActionFor(decision({ kept: false }), RelevanceMode.On)).toBe(
      RelevanceAuditAction.Dropped,
    );
  });
});

describe("emitRelevanceDecision — request shape", () => {
  it("POSTs to /api/admin/audit/ingest with bearer header and correct body", async () => {
    const { fetchFn, calls } = fakeFetch();
    await emitRelevanceDecision(
      decision({
        url: "https://ex.com/x",
        title: "Hi",
        score: 1,
        stage: RelevanceStage.Llm,
        reason: "why",
      }),
      RelevanceMode.On,
      { fetchFn },
    );

    expect(calls).toHaveLength(1);
    const { url, init } = calls[0]!;
    expect(url.endsWith("/api/admin/audit/ingest")).toBe(true);
    expect(init.method).toBe("POST");

    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toMatch(/^Bearer .+/);
    expect(headers["Content-Type"]).toBe("application/json");

    const body = JSON.parse(String(init.body)) as {
      action: string;
      targetType: string;
      targetId: string;
      metadata: { title: string; score: number | null; stage: string; reason: string };
    };
    expect(body.action).toBe(RelevanceAuditAction.Dropped);
    expect(body.targetType).toBe("post");
    expect(body.targetId).toBe("https://ex.com/x");
    expect(body.metadata).toEqual({
      title: "Hi",
      score: 1,
      stage: RelevanceStage.Llm,
      reason: "why",
    });
  });

  it("truncates title to keep metadata JSON well under 4000 chars", async () => {
    const { fetchFn, calls } = fakeFetch();
    const longTitle = "a".repeat(5000);
    await emitRelevanceDecision(decision({ title: longTitle }), RelevanceMode.On, { fetchFn });

    const body = JSON.parse(String(calls[0]!.init.body)) as { metadata: { title: string } };
    expect(body.metadata.title.length).toBeLessThanOrEqual(200);
    expect(JSON.stringify(body.metadata).length).toBeLessThanOrEqual(4000);
  });
});

describe("emitRelevanceDecision — fail-silent", () => {
  it("resolves (never throws) when fetch rejects", async () => {
    const fetchFn = vi.fn(async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;
    await expect(
      emitRelevanceDecision(decision(), RelevanceMode.On, { fetchFn }),
    ).resolves.toBeUndefined();
  });

  it("resolves (never throws) on a non-2xx response", async () => {
    const { fetchFn } = fakeFetch({ ok: false, status: 400 });
    await expect(
      emitRelevanceDecision(decision(), RelevanceMode.On, { fetchFn }),
    ).resolves.toBeUndefined();
  });
});

describe("emitRelevanceDecisions — volume guard", () => {
  it('emits all drops + llm/failopen keeps, skips keyword "accept" keeps', async () => {
    const { fetchFn, calls } = fakeFetch();
    const decisions: RelevanceDecision[] = [
      // Drops — all emitted regardless of stage.
      decision({
        url: "https://ex/drop-block",
        kept: false,
        stage: RelevanceStage.Blocklist,
        score: null,
      }),
      decision({ url: "https://ex/drop-llm", kept: false, stage: RelevanceStage.Llm, score: 0 }),
      // Keeps — only llm + failopen are emitted.
      decision({
        url: "https://ex/keep-accept",
        kept: true,
        stage: RelevanceStage.Accept,
        score: null,
      }), // SKIP
      decision({ url: "https://ex/keep-llm", kept: true, stage: RelevanceStage.Llm, score: 4 }),
      decision({
        url: "https://ex/keep-failopen",
        kept: true,
        stage: RelevanceStage.FailOpen,
        score: null,
      }),
    ];

    await emitRelevanceDecisions(decisions, RelevanceMode.On, { fetchFn });

    const targetIds = calls.map((c) => JSON.parse(String(c.init.body)).targetId as string);
    expect(targetIds).toEqual(
      expect.arrayContaining([
        "https://ex/drop-block",
        "https://ex/drop-llm",
        "https://ex/keep-llm",
        "https://ex/keep-failopen",
      ]),
    );
    expect(targetIds).not.toContain("https://ex/keep-accept");
    expect(calls).toHaveLength(4);
  });

  it("never throws even if one emit fails (Promise.allSettled)", async () => {
    let n = 0;
    const fetchFn = vi.fn(async () => {
      n += 1;
      if (n === 1) throw new Error("boom");
      return { ok: true, status: 200, text: async () => "", json: async () => ({}) } as Response;
    }) as unknown as typeof fetch;

    const decisions = [
      decision({ url: "https://ex/a", kept: false, stage: RelevanceStage.Llm }),
      decision({ url: "https://ex/b", kept: false, stage: RelevanceStage.Llm }),
    ];
    await expect(
      emitRelevanceDecisions(decisions, RelevanceMode.On, { fetchFn }),
    ).resolves.toBeUndefined();
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });
});
