import { it, expect, describe } from "vitest";

import { issueSlot, newsCount, isPastSlot } from "../src/channelDigest/issueSlot.js";

describe("issueSlot", () => {
  it("names the 11:00 Moscow issue the morning one", () => {
    expect(issueSlot(Date.parse("2026-10-01T08:00:00Z"))).toEqual({
      key: "2026-10-01/morning",
      title: "AI за утро · 1 октября",
    });
  });

  it("names the 19:00 Moscow issue the evening one", () => {
    expect(issueSlot(Date.parse("2026-10-01T16:00:00Z"))).toEqual({
      key: "2026-10-01/evening",
      title: "AI за вечер · 1 октября",
    });
  });

  it("takes the date in CRON_TZ, not UTC", () => {
    expect(issueSlot(Date.parse("2026-10-01T21:30:00Z")).key).toBe("2026-10-02/morning");
  });
});

describe("isPastSlot", () => {
  const MORNING = Date.parse("2026-10-01T08:00:00Z");
  const EVENING = Date.parse("2026-10-01T16:00:00Z");

  it.each([
    ["2026-10-01/morning", EVENING, true],
    ["2026-09-30/evening", MORNING, true],
    ["2026-10-01/morning", MORNING, false],
    ["2026-10-01/evening", EVENING, false],
    ["2026-10-01/evening", MORNING, false],
  ])("%s at %s is past: %s", (key, now, past) => {
    expect(isPastSlot(key, now)).toBe(past);
  });
});

describe("newsCount", () => {
  it.each([
    [1, "1 новость"],
    [3, "3 новости"],
    [6, "6 новостей"],
    [7, "7 новостей"],
  ])("%i → %s", (n, text) => {
    expect(newsCount(n)).toBe(text);
  });
});
