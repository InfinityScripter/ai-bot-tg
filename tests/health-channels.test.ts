import { it, expect, describe } from "vitest";

import { describeChannelWatch } from "../src/health/probeChecks.js";

import type { ChannelWatchSummary } from "../src/server/types.js";

const summary = (over: Partial<ChannelWatchSummary>): ChannelWatchSummary => ({
  pages: 12,
  failed: [],
  eligible: 5,
  kept: 3,
  picked: null,
  ...over,
});
const last = (over: {
  summary?: ChannelWatchSummary | null;
  error?: string | null;
}): Parameters<typeof describeChannelWatch>[0] => ({
  at: 0,
  summary: summary({}),
  error: null,
  ...over,
});

describe("describeChannelWatch", () => {
  it("is ok before the first sweep", () => {
    expect(describeChannelWatch(null)).toMatchObject({ ok: true, detail: "ещё не запускалось" });
  });

  it("is not ok when the last sweep failed", () => {
    expect(describeChannelWatch(last({ error: "boom" }))).toMatchObject({
      ok: false,
      detail: "boom",
    });
  });

  it("reports the daily limit as ok", () => {
    const s = summary({ skipped: "limit" });
    expect(describeChannelWatch(last({ summary: s }))).toMatchObject({
      ok: true,
      detail: "дневной лимит выбран",
    });
  });

  it("is ok with no failed pages", () => {
    expect(describeChannelWatch(last({}))).toMatchObject({
      ok: true,
      detail: "страниц 12, подходящих 5",
    });
  });

  it("stays ok but lists the pages when 1 of 12 failed", () => {
    const s = summary({ pages: 11, failed: ["abc"] });
    const check = describeChannelWatch(last({ summary: s }));
    expect(check.ok).toBe(true);
    expect(check.detail).toContain("не прочитались: abc");
  });

  it("is not ok when half of the pages failed", () => {
    const s = summary({ pages: 6, failed: ["a", "b", "c", "d", "e", "f"] });
    const check = describeChannelWatch(last({ summary: s }));
    expect(check.ok).toBe(false);
    expect(check.detail).toContain("не прочитались: a, b, c, d, e, f");
  });
});
