import { CONFIG } from './config.js';
import type { RelevanceDecision, RelevanceMode } from './relevance.js';

/**
 * Mirrors each relevance decision into the backend audit log so the owner can
 * review them in /dashboard/admin/audit-logs. Strictly fire-and-forget and
 * fail-silent: a backend hiccup (network error, non-2xx, auth) must NEVER block
 * or fail a collection run, so every path here swallows errors.
 *
 * Backend contract (deployed, do not change):
 *   POST `${BLOG_API_URL}/api/admin/audit/ingest`
 *   Authorization: Bearer ${BOT_API_TOKEN}, Content-Type: application/json
 *   Body: { action, targetType?, targetId?, metadata? }
 *     - action ∈ { 'bot.relevance_dropped', 'bot.relevance_shadow_dropped',
 *                  'bot.relevance_kept' } — anything else → 400.
 *     - metadata JSON length must stay <= 4000 chars.
 */

/** The exact action literals the backend accepts; anything else → 400. */
export type RelevanceAuditAction =
  | 'bot.relevance_dropped'
  | 'bot.relevance_shadow_dropped'
  | 'bot.relevance_kept';

/** Injectable deps so tests never touch the real network; defaults to global fetch. */
export interface EmitDeps {
  fetchFn?: typeof fetch;
}

/** Keep the metadata title short so the JSON body stays well under the 4000-char cap. */
const MAX_TITLE_LEN = 200;

/** Truncates a string to `max` chars (no ellipsis — the cap is a hard byte budget). */
function truncate(value: string, max: number): string {
  return value.length <= max ? value : value.slice(0, max);
}

/**
 * Maps a decision + the active mode to the backend action literal:
 *   - kept === true                       → 'bot.relevance_kept'
 *   - kept === false && mode === 'shadow' → 'bot.relevance_shadow_dropped'
 *   - kept === false && mode === 'on'     → 'bot.relevance_dropped'
 * Mode 'off' produces no decisions, so it is never passed here.
 */
export function relevanceActionFor(decision: RelevanceDecision, mode: RelevanceMode): RelevanceAuditAction {
  if (decision.kept) return 'bot.relevance_kept';
  return mode === 'shadow' ? 'bot.relevance_shadow_dropped' : 'bot.relevance_dropped';
}

/**
 * Volume guard. A big run can produce dozens of decisions; flooding the audit
 * log with cheap keyword fast-accepts is noise. We emit the SIGNAL only:
 *   - ALL drops/shadow-drops (kept === false), whatever stage.
 *   - KEEPS only when the LLM decided them (stage 'llm') or we failed open
 *     (stage 'failopen' — worth seeing that the classifier was unavailable).
 * Skipped: keyword 'accept' keeps (obvious AI/tech, pure noise). 'blocklist'
 * is always a drop, so it's covered by the kept === false branch.
 */
function isInteresting(decision: RelevanceDecision): boolean {
  return decision.kept === false || decision.stage === 'llm' || decision.stage === 'failopen';
}

/**
 * Emits ONE decision to the ingest route. Fire-and-forget: wraps everything in
 * try/catch and resolves on any failure (network, non-2xx) after a console.warn —
 * it never throws, so a backend outage cannot break a collection run.
 */
export async function emitRelevanceDecision(
  decision: RelevanceDecision,
  mode: RelevanceMode,
  deps: EmitDeps = {}
): Promise<void> {
  const fetchFn = deps.fetchFn ?? fetch;
  const url = `${CONFIG.BLOG_API_URL.replace(/\/$/, '')}/api/admin/audit/ingest`;
  const body = JSON.stringify({
    action: relevanceActionFor(decision, mode),
    targetType: 'post',
    targetId: decision.url,
    metadata: {
      title: truncate(decision.title, MAX_TITLE_LEN),
      score: decision.score,
      stage: decision.stage,
      reason: decision.reason,
    },
  });

  try {
    const response = await fetchFn(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${CONFIG.BOT_API_TOKEN}`,
      },
      body,
    });
    if (!response.ok) {
      // eslint-disable-next-line no-console
      console.warn(`[audit-emit] ingest returned ${response.status} for url=${decision.url}`);
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(`[audit-emit] ingest failed for url=${decision.url}: ${String(err)}`);
  }
}

/**
 * Emits the interesting subset of `decisions` concurrently. Uses
 * Promise.allSettled so one failure can't stop the others, and awaits the whole
 * batch but NEVER throws (each emit is already fail-silent). Returns when all
 * have settled, so the collector can finish its log line in order.
 */
export async function emitRelevanceDecisions(
  decisions: RelevanceDecision[],
  mode: RelevanceMode,
  deps: EmitDeps = {}
): Promise<void> {
  const interesting = decisions.filter(isInteresting);
  await Promise.allSettled(interesting.map((d) => emitRelevanceDecision(d, mode, deps)));
}
