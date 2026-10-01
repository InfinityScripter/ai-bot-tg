import Database from "better-sqlite3";

import { escapeHtml } from "../src/feeds/index.js";
import { MOCK_OVERRIDE_KEY, MODEL_OVERRIDE_KEY } from "../src/store/candidateSchema.js";

import type { CandidateStore } from "../src/store/index.js";
import type { AssembledIssue } from "../src/channelDigest/index.js";

export const TRIAL_PREFIX = "[проба] ";

/** The chat the dry run may write to: the owner's private chat, never the channel. */
export function dryRunTarget(ownerId: number, channelId: string | undefined): number {
  if (!(ownerId > 0) || String(ownerId) === channelId?.trim()) {
    throw new Error(`проба шлёт только владельцу, а не в канал (chat ${ownerId})`);
  }
  return ownerId;
}

/**
 * Copies the runtime model and mock overrides from the production ledger into
 * the in-memory store. The ledger is opened read-only and closed at once;
 * a missing file throws, so a wrong path never silently falls back to the env model.
 */
export function copyRuntimeOverrides(store: CandidateStore, ledgerPath: string): number {
  const ledger = new Database(ledgerPath, { readonly: true, fileMustExist: true });
  try {
    const rows = ledger
      .prepare("SELECT key, value FROM settings WHERE key IN (?, ?)")
      .all(MODEL_OVERRIDE_KEY, MOCK_OVERRIDE_KEY) as { key: string; value: string }[];
    for (const { key, value } of rows) store.setRawSetting(key, value);
    return rows.length;
  } finally {
    ledger.close();
  }
}

/**
 * Puts «[проба]» in front of the title of the article and of its text
 * fallback, so the owner can tell the trial from a real issue. The cover and
 * the slot keep the real title. Throws when the title is not found.
 */
export function markAsTrial({ slot, article, fallbackText }: AssembledIssue): AssembledIssue {
  const title = escapeHtml(slot.title);
  const marked = `${TRIAL_PREFIX}${title}`;
  const head = `<h3>${title}</h3>`;
  const textHead = `<b>${title}</b>`;
  if (!article.html.includes(head) || !fallbackText.includes(textHead)) {
    throw new Error("в выпуске не нашёлся заголовок, пометить пробу нечем");
  }
  return {
    slot,
    article: { ...article, html: article.html.replace(head, `<h3>${marked}</h3>`) },
    fallbackText: fallbackText.replace(textHead, `<b>${marked}</b>`),
  };
}
