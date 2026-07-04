/**
 * Shared types for the eval harness's deterministic checks. A "check" is a pure
 * function that inspects one produced artifact (a finalized RewriteResult, or a
 * parsed relevance reply) against the contract the prompt is supposed to honour,
 * and returns a list of findings. Errors fail the case; warnings are reported
 * but tolerated.
 */

/** Severity of a single check finding. `error` fails the case; `warn` does not. */
export type Severity = "error" | "warn";

/** One finding from a check: which rule, whether it held, and why. */
export interface Finding {
  /** Stable id of the rule, e.g. "title.length" — used in the report + tests. */
  id: string;
  /** True when the rule held. */
  ok: boolean;
  severity: Severity;
  /** Human-readable detail (empty when ok). */
  detail: string;
}

/** Convenience: a passing finding. */
export function pass(id: string): Finding {
  return { id, ok: true, severity: "error", detail: "" };
}

/** Convenience: a failing finding at the given severity. */
export function fail(id: string, severity: Severity, detail: string): Finding {
  return { id, ok: false, severity, detail };
}

/** True when a finding list has zero `error`-severity failures. */
export function isCasePassing(findings: Finding[]): boolean {
  return findings.every((f) => f.ok || f.severity !== "error");
}
