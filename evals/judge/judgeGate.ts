import { fail } from "../checks/types.js";

import type { Finding } from "../checks/types.js";
import type { JudgeVerdict } from "./runJudge.js";

/** Parses the semantic quality floor and rejects fail-open configurations. */
export function parseJudgeFloor(value: string | undefined): number {
  const floor = Number(value ?? "80");
  if (!Number.isFinite(floor) || floor < 0 || floor > 100) {
    throw new Error(`EVAL_JUDGE_FLOOR must be a finite number from 0 to 100, got "${value}"`);
  }
  return floor;
}

/** Converts a judge verdict into deterministic findings; unavailable is a failure. */
export function judgeGate(verdict: JudgeVerdict | null, floor: number): Finding[] {
  if (!verdict) return [fail("judge.unavailable", "error", "judge reply is unavailable")];
  if (verdict.score < floor) {
    return [fail("judge.floor", "error", `judge ${verdict.score} < floor ${floor}`)];
  }
  return [];
}
