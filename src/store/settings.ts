/**
 * Settings persistence for the candidate store: the runtime provider/model and
 * mock ("без LLM") overrides live in the `settings` key/value table. Free
 * functions taking the better-sqlite3 handle; `CandidateStore` delegates to
 * them so the store class stays focused on the candidate lifecycle.
 */

import type Database from "better-sqlite3";

import { MOCK_OVERRIDE_KEY, MODEL_OVERRIDE_KEY } from "./schema.js";

import type { MockOverride, ModelOverride } from "./schema.js";

/** Low-level setter for a settings key. */
export function setRawSetting(db: Database.Database, key: string, value: string): void {
  db.prepare(
    `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`,
  ).run(key, value);
}

/** Low-level getter for a settings key, or null if absent. */
export function getRawSetting(db: Database.Database, key: string): string | null {
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as
    | { value: string }
    | undefined;
  return row?.value ?? null;
}

/**
 * The active provider/model override, or null if none is set. A corrupt row
 * (e.g. hand-edited, or a shape change) returns null rather than throwing, so
 * the rewriter cleanly falls back to the env default.
 */
export function getModelOverride(db: Database.Database): ModelOverride | null {
  const raw = getRawSetting(db, MODEL_OVERRIDE_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<ModelOverride>;
    if (typeof parsed.provider === "string" && typeof parsed.model === "string") {
      return { provider: parsed.provider, model: parsed.model };
    }
    return null;
  } catch {
    return null;
  }
}

/** Sets (upserts) the active provider/model override. */
export function setModelOverride(db: Database.Database, provider: string, model: string): void {
  setRawSetting(db, MODEL_OVERRIDE_KEY, JSON.stringify({ provider, model }));
}

/** Clears the override; the rewriter then uses the env default. */
export function clearModelOverride(db: Database.Database): void {
  db.prepare("DELETE FROM settings WHERE key = ?").run(MODEL_OVERRIDE_KEY);
}

/**
 * The active mock override, or null if none is set. When set, it is strictly
 * authoritative over the env REWRITE_MOCK (so an admin toggling mock OFF in
 * the panel truly disables it even if REWRITE_MOCK=1). A corrupt row returns
 * null rather than throwing, so resolution cleanly falls back to env.
 */
export function getMockOverride(db: Database.Database): MockOverride | null {
  const raw = getRawSetting(db, MOCK_OVERRIDE_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<MockOverride>;
    if (typeof parsed.enabled === "boolean") {
      return { enabled: parsed.enabled };
    }
    return null;
  } catch {
    return null;
  }
}

/** Sets (upserts) the mock override. */
export function setMockOverride(db: Database.Database, enabled: boolean): void {
  setRawSetting(db, MOCK_OVERRIDE_KEY, JSON.stringify({ enabled }));
}

/** Clears the mock override; resolution then falls back to env REWRITE_MOCK. */
export function clearMockOverride(db: Database.Database): void {
  db.prepare("DELETE FROM settings WHERE key = ?").run(MOCK_OVERRIDE_KEY);
}
