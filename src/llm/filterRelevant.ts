import { CONFIG } from "../config.js";
import { classifyRelevance } from "./classifyRelevance.js";
import { RelevanceMode, RelevanceStage } from "../enums.js";
import { ON_TOPIC_MARKERS, OFF_TOPIC_MARKERS } from "./relevanceMarkers.js";

import type { FeedItem } from "../types.js";
import type { CandidateStore } from "../store/index.js";
import type { ClassifyFn, FilterOptions, RelevanceDecision } from "./types.js";

/** Lowercased title + snippet — the text every stage reads. */
function haystack(item: FeedItem): string {
  return `${item.title} ${item.snippet}`.toLowerCase();
}

/** True if title+snippet contains any of the (already-lowercased) markers. */
function hasMarker(item: FeedItem, markers: string[]): boolean {
  const hay = haystack(item);
  return markers.some((m) => hay.includes(m));
}

/** Computes the decision for one item (stages A then B). Pure aside from classify. */
async function decide(
  item: FeedItem,
  store: CandidateStore,
  classify: ClassifyFn,
  threshold: number,
): Promise<RelevanceDecision> {
  const base = { url: item.url, title: item.title };
  // Stage A — hard blocklist: unambiguously off-topic, drop for free.
  if (hasMarker(item, OFF_TOPIC_MARKERS)) {
    return {
      ...base,
      kept: false,
      stage: RelevanceStage.Blocklist,
      score: null,
      reason: "off-topic marker",
    };
  }
  // Stage A — on-topic fast-accept: obvious AI/tech, keep without an LLM call.
  if (hasMarker(item, ON_TOPIC_MARKERS)) {
    return {
      ...base,
      kept: true,
      stage: RelevanceStage.Accept,
      score: null,
      reason: "on-topic marker",
    };
  }
  // Stage B — single LLM classify. null (mock/error/unparsable) → fail open.
  // Guard the call too: an injected classifier that THROWS must also fail open
  // (the real classifyRelevance never throws, but a custom one might).
  let score: number | null;
  try {
    score = await classify(item, store);
  } catch {
    score = null;
  }
  if (score === null) {
    return {
      ...base,
      kept: true,
      stage: RelevanceStage.FailOpen,
      score: null,
      reason: "classify unavailable",
    };
  }
  const kept = score >= threshold;
  return {
    ...base,
    kept,
    stage: RelevanceStage.Llm,
    score,
    reason: `score=${score} threshold=${threshold}`,
  };
}

/** Logs one decision. Would-drops in shadow mode are prefixed 'SHADOW-DROP'. */
function logDecision(d: RelevanceDecision, shadow: boolean): void {
  const verb = d.kept ? "KEEP" : shadow ? "SHADOW-DROP" : "DROP";
  // eslint-disable-next-line no-console
  console.log(
    `[relevance] ${verb} score=${d.score ?? "-"} stage=${d.stage} reason=${d.reason} url=${d.url}`,
  );
}

/**
 * The orchestrator. For each item: stage A blocklist → drop; on-topic marker →
 * accept (no LLM); else LLM classify (fail open on null). Returns the decisions
 * for every item plus the `kept` slice the caller should actually insert:
 *   - 'off'    → no work; kept === items, decisions === [].
 *   - 'shadow' → compute + log all decisions, but kept === ALL input (never
 *                drops in prod; the 2-week calibration window).
 *   - 'on'     → kept === items whose decision.kept === true.
 * mode/threshold default from CONFIG when not passed.
 */
export async function filterRelevant(
  items: FeedItem[],
  store: CandidateStore,
  opts: FilterOptions = {},
): Promise<{ kept: FeedItem[]; decisions: RelevanceDecision[] }> {
  const mode = opts.mode ?? CONFIG.RELEVANCE_MODE;
  const threshold = opts.threshold ?? CONFIG.RELEVANCE_THRESHOLD;
  const classify = opts.classify ?? classifyRelevance;

  // 'off' — current behavior: no filtering, no decisions, no LLM work.
  if (mode === RelevanceMode.Off) {
    return { kept: items, decisions: [] };
  }

  const shadow = mode === RelevanceMode.Shadow;
  const decisions: RelevanceDecision[] = [];
  for (const item of items) {
    const d = await decide(item, store, classify, threshold);
    decisions.push(d);
    logDecision(d, shadow);
  }

  // shadow never drops (kept = all input); 'on' keeps only decision.kept items.
  const kept = shadow ? items : items.filter((_, i) => decisions[i]!.kept);
  return { kept, decisions };
}
