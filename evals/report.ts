/**
 * Console reporting for the eval runner: a per-case line, the failing/ warning
 * findings under it, and a final summary. No color deps — plain ASCII so it
 * reads the same in CI logs and a terminal.
 */

import { isCasePassing } from "./checks/types.js";

import type { Finding } from "./checks/types.js";

/** One case's evaluated result, ready to print. */
export interface CaseReport {
  id: string;
  about: string;
  findings: Finding[];
  /** Optional judge line, already formatted (e.g. "judge 84/100"). */
  judgeNote?: string;
  /** True when the case is considered failed (error findings or judge floor). */
  failed: boolean;
}

const CHECK = "✓"; // ✓
const CROSS = "✗"; // ✗
const WARN = "!";

/** Prints one case block and returns nothing. */
export function printCase(report: CaseReport): void {
  const mark = report.failed ? CROSS : CHECK;
  const head = `${mark} ${report.id}  —  ${report.about}`;
  // eslint-disable-next-line no-console
  console.log(head);
  for (const f of report.findings) {
    if (f.ok) continue;
    const sev = f.severity === "error" ? CROSS : WARN;
    // eslint-disable-next-line no-console
    console.log(`    ${sev} [${f.id}] ${f.detail}`);
  }
  if (report.judgeNote) {
    // eslint-disable-next-line no-console
    console.log(`    · ${report.judgeNote}`);
  }
}

/** Aggregate counts for the summary. */
export interface Summary {
  total: number;
  passed: number;
  failed: number;
  warnings: number;
}

/** Computes a summary from a list of case reports. */
export function summarize(reports: CaseReport[]): Summary {
  let warnings = 0;
  let failed = 0;
  for (const r of reports) {
    warnings += r.findings.filter((f) => !f.ok && f.severity === "warn").length;
    if (r.failed) failed += 1;
  }
  return { total: reports.length, passed: reports.length - failed, failed, warnings };
}

/** Prints the final summary line. Returns true when everything passed. */
export function printSummary(title: string, reports: CaseReport[]): boolean {
  const s = summarize(reports);
  // eslint-disable-next-line no-console
  console.log(
    `\n${title}: ${s.passed}/${s.total} passed, ${s.failed} failed, ${s.warnings} warning(s)\n`,
  );
  return s.failed === 0;
}

/** Helper: is this finding list a pass (no error-severity failures)? */
export function findingsPass(findings: Finding[]): boolean {
  return isCasePassing(findings);
}
