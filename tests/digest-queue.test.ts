import { it, expect, describe, afterEach, beforeEach } from "vitest";

import { CandidateState } from "../src/enums.js";
import { CandidateStore } from "../src/store/index.js";

import type { FeedItem } from "../src/types.js";

let store: CandidateStore;
let seq = 0;

function insert(overrides: Partial<FeedItem> = {}): number {
  seq += 1;
  const url = `https://ex.com/${seq}`;
  const item: FeedItem = {
    dedupKey: url,
    url,
    title: `T${seq}`,
    snippet: "s",
    feedTitle: "Feed",
    imageUrl: null,
    imageUrls: [],
    publishedAt: null,
    ...overrides,
  };
  return store.insertCollected(item, true)!;
}

beforeEach(() => {
  store = new CandidateStore(":memory:");
});

afterEach(() => store.close());

describe("digest queue lifecycle", () => {
  it("queueForDigest: collected → digest_queued and clears auto_publish", () => {
    const id = insert();
    expect(store.queueForDigest(id)).toBe(true);
    const row = store.get(id)!;
    expect(row.state).toBe(CandidateState.DigestQueued);
    // Cleared so crash-recovery (listRecoveredAutomatic) can't resurrect it.
    expect(row.autoPublish).toBe(false);
    expect(store.listRecoveredAutomatic()).toHaveLength(0);
  });

  it("queueForDigest is a no-op on a non-collected row (double call, acted-on row)", () => {
    const id = insert();
    store.queueForDigest(id);
    expect(store.queueForDigest(id)).toBe(false);
    store.setState(id, CandidateState.Skipped);
    expect(store.queueForDigest(id)).toBe(false);
  });

  it("listDigestQueue returns queued rows newest first", () => {
    const a = insert();
    const b = insert();
    store.queueForDigest(a);
    store.queueForDigest(b);
    expect(store.listDigestQueue().map((c) => c.id)).toEqual([b, a]);
  });

  it("claimDigestBatch claims only still-queued rows and reports the count", () => {
    const a = insert();
    const b = insert();
    store.queueForDigest(a);
    store.queueForDigest(b);
    // One row leaves the queue before the claim (owner skipped it).
    store.setState(b, CandidateState.Skipped);
    expect(store.claimDigestBatch([a, b])).toBe(1);
    expect(store.get(a)!.state).toBe(CandidateState.Publishing);
    expect(store.get(b)!.state).toBe(CandidateState.Skipped);
  });

  it("requeueDigestBatch returns claimed rows to the queue (clear 4xx failure)", () => {
    const a = insert();
    store.queueForDigest(a);
    store.claimDigestBatch([a]);
    store.requeueDigestBatch([a]);
    expect(store.get(a)!.state).toBe(CandidateState.DigestQueued);
  });

  it("expireDigestQueue skips only rows older than the window", () => {
    const fresh = insert();
    store.queueForDigest(fresh);
    expect(store.expireDigestQueue(48)).toBe(0);
    expect(store.get(fresh)!.state).toBe(CandidateState.DigestQueued);
    // 0-hour window floors to 1h; a just-queued row still survives it.
    expect(store.expireDigestQueue(1)).toBe(0);
  });

  it("digest last-date guard round-trips through settings", () => {
    expect(store.getDigestLastDate()).toBeNull();
    store.setDigestLastDate("2026-08-18");
    expect(store.getDigestLastDate()).toBe("2026-08-18");
    store.setDigestLastDate("2026-08-19");
    expect(store.getDigestLastDate()).toBe("2026-08-19");
  });
});
