import { it, vi, expect, describe, afterEach } from "vitest";

import { autoRetry } from "../src/auto-retry.js";

// The transformer calls setTimeout for backoff/retry-after; fake timers keep the
// test instant while still asserting the retry happened.
afterEach(() => {
  vi.useRealTimers();
});

/** A `prev` transformer stub that returns the queued results in order. */
function prevReturning(results: unknown[]) {
  let i = 0;
  return vi.fn(async () => results[Math.min(i++, results.length - 1)]);
}

async function runWithFakeTimers<T>(fn: () => Promise<T>): Promise<T> {
  vi.useFakeTimers();
  const p = fn();
  // Flush all pending timers (the pauses) until the promise settles.
  await vi.runAllTimersAsync();
  return p;
}

describe("autoRetry transformer", () => {
  it("passes a successful result straight through (no retry)", async () => {
    const ok = { ok: true, result: "done" };
    const prev = prevReturning([ok]);
    const t = autoRetry();
    const res = await t(prev as never, "sendMessage", {} as never, undefined);
    expect(res).toBe(ok);
    expect(prev).toHaveBeenCalledTimes(1);
  });

  it("waits out a 429 retry_after and resubmits", async () => {
    const limited = { ok: false, error_code: 429, parameters: { retry_after: 2 } };
    const ok = { ok: true, result: "sent" };
    const prev = prevReturning([limited, ok]);
    const t = autoRetry();

    const res = await runWithFakeTimers(() =>
      t(prev as never, "sendMessage", {} as never, undefined),
    );
    expect(res).toBe(ok);
    expect(prev).toHaveBeenCalledTimes(2); // first 429, then success
  });

  it("retries a 5xx with backoff, then succeeds", async () => {
    const server = { ok: false, error_code: 502, description: "bad gateway" };
    const ok = { ok: true, result: "sent" };
    const prev = prevReturning([server, ok]);
    const t = autoRetry();

    const res = await runWithFakeTimers(() =>
      t(prev as never, "sendMessage", {} as never, undefined),
    );
    expect(res).toBe(ok);
    expect(prev).toHaveBeenCalledTimes(2);
  });

  it("does not retry a 4xx (e.g. 400) — returns it as-is", async () => {
    const bad = { ok: false, error_code: 400, description: "bad request" };
    const prev = prevReturning([bad]);
    const t = autoRetry();
    const res = await t(prev as never, "editMessageText", {} as never, undefined);
    expect(res).toBe(bad);
    expect(prev).toHaveBeenCalledTimes(1);
  });
});
