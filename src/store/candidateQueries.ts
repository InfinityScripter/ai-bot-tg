import type Database from "better-sqlite3";

import { CandidateState } from "../enums.js";
import { mapRow } from "./candidateSchema.js";

import type { Candidate } from "../types.js";
import type { CandidateRow } from "./types.js";

function list(db: Database.Database, sql: string, ...states: CandidateState[]): Candidate[] {
  return (db.prepare(sql).all(...states) as CandidateRow[]).map(mapRow);
}

export function listByState(db: Database.Database, state: CandidateState): Candidate[] {
  return list(db, "SELECT * FROM candidates WHERE state = ? ORDER BY id", state);
}

export function listRecoveredAutomatic(db: Database.Database): Candidate[] {
  return list(
    db,
    "SELECT * FROM candidates WHERE state = ? AND auto_publish = 1 ORDER BY id",
    CandidateState.Collected,
  );
}

export function listAutomaticFailures(db: Database.Database): Candidate[] {
  return list(
    db,
    "SELECT * FROM candidates WHERE auto_publish = 1 AND state IN (?, ?) ORDER BY id",
    CandidateState.RewriteFailed,
    CandidateState.PendingReview,
  );
}
