import { it, expect, describe } from "vitest";

import { CandidateKind, CandidateState } from "../src/enums.js";
import { GateFailure, assertPublishable } from "../src/llm/qualityGate.js";

import type { Candidate, RewriteResult, ReleaseResult } from "../src/types.js";

function candidate(overrides: Partial<Candidate> = {}): Candidate {
  return {
    id: 1,
    dedupKey: "k",
    sourceUrl: "https://habr.com/ru/articles/1",
    sourceTitle: "T",
    feedTitle: "Feed",
    imageUrl: null,
    snippet: null,
    imageUrls: null,
    kind: CandidateKind.News,
    autoPublish: true,
    state: CandidateState.PendingReview,
    rewriteJson: null,
    tgMessageId: null,
    blogPostId: null,
    error: null,
    createdAt: "2026-01-01",
    updatedAt: "2026-01-01",
    ...overrides,
  };
}

function rewrite(content: string): RewriteResult {
  return {
    title: "Title",
    description: "Description",
    content,
    tags: ["ai"],
    metaTitle: "",
    metaDescription: "",
  };
}

function release(changes: string[]): ReleaseResult {
  return {
    vendor: "OpenAI",
    model: "GPT",
    version: "5",
    releasedAt: "2026-01-01",
    sourceUrl: "https://openai.com/x",
    contextTokens: null,
    priceIn: null,
    priceOut: null,
    changes,
    sourceName: null,
  };
}

const LONG = "a".repeat(400);

describe("assertPublishable — news substance", () => {
  it("passes a news post whose content meets the 400-char floor", () => {
    expect(() => assertPublishable(candidate(), rewrite(LONG))).not.toThrow();
  });

  it("throws on content just under the floor (399 chars)", () => {
    expect(() => assertPublishable(candidate(), rewrite("a".repeat(399)))).toThrow(GateFailure);
  });

  it("counts trimmed length — whitespace padding does not satisfy the floor", () => {
    const padded = `${"  ".repeat(300)}short`; // 605 raw chars, 5 after trim
    expect(() => assertPublishable(candidate(), rewrite(padded))).toThrow(GateFailure);
  });
});

describe("assertPublishable — release substance", () => {
  const releaseCandidate = candidate({ kind: CandidateKind.Release });

  it("passes a release with at least one change", () => {
    expect(() => assertPublishable(releaseCandidate, release(["Faster inference"]))).not.toThrow();
  });

  it("throws on a release with an empty changes list", () => {
    expect(() => assertPublishable(releaseCandidate, release([]))).toThrow(GateFailure);
  });

  it("does not apply the news length floor to releases", () => {
    // A release's own body isn't gated on length; one short change is enough.
    expect(() => assertPublishable(releaseCandidate, release(["x"]))).not.toThrow();
  });
});

describe("assertPublishable — source blocklist", () => {
  it("blocks a link-shortener source", () => {
    expect(() =>
      assertPublishable(candidate({ sourceUrl: "https://bit.ly/abc" }), rewrite(LONG)),
    ).toThrow(GateFailure);
  });

  it("blocks a subdomain of a blocked host (m.reddit.com)", () => {
    expect(() =>
      assertPublishable(candidate({ sourceUrl: "https://m.reddit.com/r/x/1" }), rewrite(LONG)),
    ).toThrow(GateFailure);
  });

  it("does NOT block a lookalike host that merely contains a blocked string", () => {
    // "notbit.lyx.com" contains "bit.ly" as a substring but is a different host.
    expect(() =>
      assertPublishable(candidate({ sourceUrl: "https://notbit.lyx.com/a" }), rewrite(LONG)),
    ).not.toThrow();
  });

  it("allows a normal article host (habr.com)", () => {
    expect(() =>
      assertPublishable(candidate({ sourceUrl: "https://habr.com/ru/articles/1" }), rewrite(LONG)),
    ).not.toThrow();
  });

  it("fails OPEN on an unparseable source URL (substance still gates)", () => {
    // Bad URL → source check is skipped; a long body then passes.
    expect(() =>
      assertPublishable(candidate({ sourceUrl: "not a url" }), rewrite(LONG)),
    ).not.toThrow();
  });

  it("source block takes priority even when substance is fine", () => {
    expect(() =>
      assertPublishable(candidate({ sourceUrl: "https://t.me/channel/1" }), rewrite(LONG)),
    ).toThrow(/источник/);
  });
});
