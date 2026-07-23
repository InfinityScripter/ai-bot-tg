import { CandidateKind } from "../enums.js";
import { fetchAutoPublishFlags } from "../blog/index.js";

import type { Candidate } from "../types.js";
import type { ProcessCandidate } from "./types.js";
import type { CandidateStore } from "../store/index.js";
import type { AutoPublishFlags } from "../blog/index.js";

/** The two collector actions a deciding processCandidate routes between. */
interface ProcessDeps {
  /** Automatic rewrite + publish (production autoPublishCandidate from the bot). */
  autoPublish: (candidate: Candidate) => Promise<void>;
  /** Sends the owner a RAW approval card (production sendRawCard from the bot). */
  sendRawCard: (candidate: Candidate) => Promise<void>;
}

/**
 * Builds the collector's per-candidate action, gating it on the blog's two
 * auto-publish master switches. The flags are read ONCE here (not per candidate)
 * so a whole collection run uses a single consistent snapshot: the daily cron
 * runs once and /fetch is manual, so a mid-run flip is neither expected nor
 * wanted, and the backend's own 10s flag cache is irrelevant at this cadence.
 *
 * Reading before returning also means crash-recovery obeys the same snapshot:
 * runCollection resumes recovered automatic rows through THIS callback before it
 * touches feeds, so a recovered row is diverted too when its switch is off.
 *
 * Per candidate: kind 'release' consults flags.releases, 'news' flags.news. When
 * on → autoPublish (its quality gate may still throw, which the bot catches and
 * turns into a manual card — escalation is free). When off → divert to manual:
 * DM the owner a RAW card, THEN clear auto_publish.
 *
 * Order matters. The card send goes first and the flag is cleared only after it
 * succeeds, so the two steps are effectively atomic for recovery: if sendRawCard
 * throws (Telegram 4xx/network/blocked), the row is left at auto_publish=1,
 * state=collected — exactly what listRecoveredAutomatic scans — so the next run
 * re-diverts it. Clearing first would strand it: auto_publish=0 + collected is
 * invisible to every recovery/failure query and its dedup key is already seen, so
 * it would never resurface (a silent drop). The flag is cleared on success only to
 * stop a *successful* divert from being re-diverted forever by crash-recovery.
 *
 * fetchAutoPublishFlags is fail-closed: a blog outage yields {false,false}, so
 * everything diverts to manual and nothing is auto-published against an intended
 * "off". Nothing is lost — the owner still gets every item as a manual card.
 */
export async function createProcessCandidate(
  store: CandidateStore,
  deps: ProcessDeps,
): Promise<ProcessCandidate> {
  const flags: AutoPublishFlags = await fetchAutoPublishFlags();

  const divertToManual = async (candidate: Candidate): Promise<void> => {
    await deps.sendRawCard(candidate);
    store.clearAutoPublish(candidate.id);
  };

  return async (candidate: Candidate): Promise<void> => {
    const wantAuto = candidate.kind === CandidateKind.Release ? flags.releases : flags.news;
    if (wantAuto) {
      await deps.autoPublish(candidate);
      return;
    }
    await divertToManual(candidate);
  };
}
