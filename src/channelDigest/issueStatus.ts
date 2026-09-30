import type { IssueStatus, IssueOutcome } from "./types.js";

let last: IssueStatus | null = null;

/** Keeps the latest issue outcome in memory for the /health «Каналы» row, and logs it. */
export function recordIssue(slot: string, outcome: IssueOutcome, at = Date.now()): void {
  last = { at, slot, ...outcome };
  console.log(`[digest-issue] ${slot}: ${outcome.outcome}`);
}

export function lastChannelIssue(): IssueStatus | null {
  return last;
}
