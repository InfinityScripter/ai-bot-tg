import { rmSync } from "node:fs";
import { it, expect, describe, afterEach, beforeEach } from "vitest";

import { CandidateState } from "../src/enums.js";
import { CandidateStore } from "../src/store/index.js";

import type { FeedItem, RewriteResult } from "../src/types.js";

function item(overrides: Partial<FeedItem> = {}): FeedItem {
  return {
    dedupKey: "https://example.com/a",
    url: "https://example.com/a",
    title: "Title A",
    snippet: "snippet",
    feedTitle: "Feed",
    imageUrl: null,
    imageUrls: [],
    publishedAt: null,
    ...overrides,
  };
}

const REWRITE: RewriteResult = {
  title: "New title",
  description: "Summary",
  content: "Body",
  tags: ["t1", "t2"],
  metaTitle: "Meta",
  metaDescription: "Meta desc",
};

describe("CandidateStore", () => {
  let store: CandidateStore;

  beforeEach(() => {
    store = new CandidateStore(":memory:");
  });

  afterEach(() => {
    store.close();
  });

  it("inserts a fresh item as collected and returns its id", () => {
    const id = store.insertCollected(item());
    expect(id).not.toBeNull();
    const c = store.get(id!);
    expect(c?.state).toBe(CandidateState.Collected);
    expect(c?.sourceTitle).toBe("Title A");
  });

  it("dedups: a second insert of the same key returns null and does not duplicate", () => {
    const first = store.insertCollected(item());
    const second = store.insertCollected(item());
    expect(first).not.toBeNull();
    expect(second).toBeNull();
    expect(store.isSeen("https://example.com/a")).toBe(true);
  });

  it("treats distinct keys as separate candidates", () => {
    const a = store.insertCollected(item({ dedupKey: "https://example.com/a" }));
    const b = store.insertCollected(item({ dedupKey: "https://example.com/b" }));
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(a).not.toBe(b);
  });

  it("attaches a rewrite and moves to pending_review", () => {
    const id = store.insertCollected(item())!;
    store.attachRewrite(id, REWRITE);
    const c = store.get(id)!;
    expect(c.state).toBe(CandidateState.PendingReview);
    expect(store.getRewrite(c)).toEqual(REWRITE);
  });

  it("records the telegram message id", () => {
    const id = store.insertCollected(item())!;
    store.setTelegramMessage(id, 555);
    expect(store.get(id)?.tgMessageId).toBe(555);
  });

  it("marks published with the blog post id", () => {
    const id = store.insertCollected(item())!;
    store.attachRewrite(id, REWRITE);
    store.setPublished(id, "post-123");
    const c = store.get(id)!;
    expect(c.state).toBe(CandidateState.Published);
    expect(c.blogPostId).toBe("post-123");
  });

  it("stores an error with a failed state", () => {
    const id = store.insertCollected(item())!;
    store.setState(id, CandidateState.RewriteFailed, "boom");
    const c = store.get(id)!;
    expect(c.state).toBe(CandidateState.RewriteFailed);
    expect(c.error).toBe("boom");
  });

  describe("raw feed item persistence (for deferred rewrite)", () => {
    it("persists snippet + imageUrls and round-trips them via getFeedItem", () => {
      const it0 = item({
        snippet: "Сырой текст статьи.",
        imageUrl: "https://cdn/cover.jpg",
        imageUrls: ["https://cdn/cover.jpg", "https://cdn/in1.png"],
      });
      const id = store.insertCollected(it0)!;
      const candidate = store.get(id)!;
      const rebuilt = store.getFeedItem(candidate);
      expect(rebuilt.snippet).toBe("Сырой текст статьи.");
      expect(rebuilt.imageUrls).toEqual(["https://cdn/cover.jpg", "https://cdn/in1.png"]);
      expect(rebuilt.imageUrl).toBe("https://cdn/cover.jpg");
      expect(rebuilt.title).toBe("Title A");
      expect(rebuilt.url).toBe("https://example.com/a");
      expect(rebuilt.feedTitle).toBe("Feed");
      expect(rebuilt.dedupKey).toBe("https://example.com/a");
    });

    it("getFeedItem yields empty imageUrls when none were stored", () => {
      const id = store.insertCollected(item({ imageUrls: [] }))!;
      const rebuilt = store.getFeedItem(store.get(id)!);
      expect(rebuilt.imageUrls).toEqual([]);
    });
  });

  describe("model override settings", () => {
    it("returns null when no override is set", () => {
      expect(store.getModelOverride()).toBeNull();
    });

    it("persists and reads back a provider+model override", () => {
      store.setModelOverride("glm", "glm-4.7-flash");
      expect(store.getModelOverride()).toEqual({ provider: "glm", model: "glm-4.7-flash" });
    });

    it("upserts: a second set replaces the first", () => {
      store.setModelOverride("glm", "glm-4.7-flash");
      store.setModelOverride("deepseek", "deepseek-v4-flash");
      expect(store.getModelOverride()).toEqual({
        provider: "deepseek",
        model: "deepseek-v4-flash",
      });
    });

    it("clears the override back to null", () => {
      store.setModelOverride("glm", "glm-4.7-flash");
      store.clearModelOverride();
      expect(store.getModelOverride()).toBeNull();
    });

    it("returns null on a corrupt override row rather than throwing", () => {
      // simulate a hand-corrupted value
      store.setRawSetting("model_override", "not json{");
      expect(store.getModelOverride()).toBeNull();
    });
  });

  describe("claimForRewriting (atomic guard against double-rewrite)", () => {
    it("lets exactly one caller win from a rewritable state", () => {
      const id = store.insertCollected(item())!; // 'collected'
      expect(store.claimForRewriting(id)).toBe(true);
      expect(store.claimForRewriting(id)).toBe(false); // now 'rewriting'
      expect(store.get(id)?.state).toBe(CandidateState.Rewriting);
    });

    it("claims from pending_review and rewrite_failed too (regenerate / retry)", () => {
      const a = store.insertCollected(item({ dedupKey: "a" }))!;
      store.attachRewrite(a, REWRITE); // → pending_review
      expect(store.claimForRewriting(a)).toBe(true);

      const b = store.insertCollected(item({ dedupKey: "b" }))!;
      store.setState(b, CandidateState.RewriteFailed, "boom");
      expect(store.claimForRewriting(b)).toBe(true);
    });
  });

  describe("recoverInFlight (startup reconciliation)", () => {
    it("a reopened store resets stuck rewriting/publishing rows", () => {
      const tmp = `${process.cwd()}/.tmp-recover-${process.pid}.db`;
      rmSync(tmp, { force: true });
      const s1 = new CandidateStore(tmp);
      const id = s1.insertCollected(item())!;
      s1.setState(id, CandidateState.Rewriting); // simulate a crash mid-rewrite
      const pid = s1.insertCollected(item({ dedupKey: "pub" }))!;
      s1.setState(pid, CandidateState.Publishing);
      s1.close();

      const s2 = new CandidateStore(tmp); // constructor runs recoverInFlight
      expect(s2.get(id)?.state).toBe(CandidateState.Collected); // rewriting → collected
      // publishing → needs_verification (NOT pending_review — avoids a silent
      // duplicate post if the POST had already reached the blog).
      expect(s2.get(pid)?.state).toBe(CandidateState.NeedsVerification);
      s2.close();

      for (const suffix of ["", "-wal", "-shm"]) rmSync(`${tmp}${suffix}`, { force: true });
    });
  });

  describe("claimForPublishing (atomic guard against double-publish)", () => {
    it("lets exactly one caller win from pending_review", () => {
      const id = store.insertCollected(item())!;
      store.attachRewrite(id, REWRITE); // → pending_review

      expect(store.claimForPublishing(id)).toBe(true); // first tap wins
      expect(store.claimForPublishing(id)).toBe(false); // second tap loses
      expect(store.get(id)?.state).toBe(CandidateState.Publishing);
    });

    it("does not claim a candidate that is not pending_review", () => {
      const id = store.insertCollected(item())!; // state 'collected'
      expect(store.claimForPublishing(id)).toBe(false);
      expect(store.get(id)?.state).toBe(CandidateState.Collected);
    });

    it("claims a needs_verification row too (owner chose to finish publishing)", () => {
      const id = store.insertCollected(item())!;
      store.setState(id, CandidateState.NeedsVerification);
      expect(store.claimForPublishing(id)).toBe(true);
      expect(store.get(id)?.state).toBe(CandidateState.Publishing);
    });
  });

  describe("pruneOld (retention + dedup preservation)", () => {
    it("deletes old published/skipped rows but keeps them deduped via seen_keys", () => {
      // Insert + publish, then backdate updated_at past the cutoff.
      const id = store.insertCollected(item({ dedupKey: "old-pub" }))!;
      store.attachRewrite(id, REWRITE);
      store.setPublished(id, "p1");
      store.setRawSetting("noop", "noop"); // touch nothing relevant
      // Force updated_at into the past via a direct UPDATE (test-only).
      // @ts-expect-error reach into the private db for the test
      store.db
        .prepare("UPDATE candidates SET updated_at = datetime('now','-200 days') WHERE id = ?")
        .run(id);

      const pruned = store.pruneOld(90);
      expect(pruned).toBe(1);
      expect(store.get(id)).toBeNull(); // row gone
      expect(store.isSeen("old-pub")).toBe(true); // but still deduped
      expect(store.insertCollected(item({ dedupKey: "old-pub" }))).toBeNull(); // not re-collected
    });

    it("keeps recent and non-terminal rows", () => {
      const recent = store.insertCollected(item({ dedupKey: "recent" }))!;
      store.attachRewrite(recent, REWRITE);
      store.setPublished(recent, "p2"); // published but fresh
      const pending = store.insertCollected(item({ dedupKey: "pending" }))!;
      store.attachRewrite(pending, REWRITE); // pending_review (non-terminal)

      expect(store.pruneOld(90)).toBe(0);
      expect(store.get(recent)).not.toBeNull();
      expect(store.get(pending)).not.toBeNull();
    });
  });

  describe("listByState", () => {
    it("returns only candidates in the given state", () => {
      const a = store.insertCollected(item({ dedupKey: "a" }))!;
      store.setState(a, CandidateState.NeedsVerification);
      const b = store.insertCollected(item({ dedupKey: "b" }))!;
      store.setState(b, CandidateState.NeedsVerification);
      store.insertCollected(item({ dedupKey: "c" })); // stays 'collected'

      const rows = store.listByState(CandidateState.NeedsVerification);
      expect(rows.map((r) => r.id).sort()).toEqual([a, b].sort());
    });
  });
});

describe("mock override", () => {
  it("returns null when unset", () => {
    const store = new CandidateStore(":memory:");
    expect(store.getMockOverride()).toBeNull();
    store.close();
  });

  it("round-trips an enabled flag", () => {
    const store = new CandidateStore(":memory:");
    store.setMockOverride(true);
    expect(store.getMockOverride()).toEqual({ enabled: true });
    store.setMockOverride(false);
    expect(store.getMockOverride()).toEqual({ enabled: false });
    store.close();
  });

  it("clears back to null", () => {
    const store = new CandidateStore(":memory:");
    store.setMockOverride(true);
    store.clearMockOverride();
    expect(store.getMockOverride()).toBeNull();
    store.close();
  });

  it("returns null on a corrupt row", () => {
    const store = new CandidateStore(":memory:");
    store.setRawSetting("mock_override", "not json");
    expect(store.getMockOverride()).toBeNull();
    store.close();
  });
});
