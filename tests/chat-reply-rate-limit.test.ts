import { it, expect, describe } from "vitest";

import { createRateLimit } from "../src/chatReply/rateLimit.js";

describe("createRateLimit", () => {
  it("allows maxPerHour calls, refuses the next, and frees a slot after an hour", () => {
    let now = 0;
    const limit = createRateLimit(20, () => now);
    for (let i = 0; i < 20; i += 1) expect(limit.tryTake()).toBe(true);
    expect(limit.tryTake()).toBe(false);
    expect(limit.used()).toBe(20);
    now = 60 * 60 * 1000 + 1;
    expect(limit.tryTake()).toBe(true);
    expect(limit.used()).toBe(1);
  });
});
