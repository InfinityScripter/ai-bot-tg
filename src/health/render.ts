import { CandidateState } from "../enums.js";
import { escapeMarkdown } from "../utils.js";

import type { HealthReport } from "./types.js";

/** The queue states worth surfacing first (need owner attention). */
const ATTENTION_STATES: CandidateState[] = [
  CandidateState.NeedsVerification,
  CandidateState.PendingReview,
  CandidateState.RewriteFailed,
];

/** Renders a HealthReport as a Telegram-Markdown DM. */
export function renderHealth(report: HealthReport): string {
  const head = report.healthy ? "✅ *Всё ОК*" : "⚠️ *Есть проблемы*";
  const lines = report.checks.map(
    (c) => `${c.ok ? "✅" : "❌"} *${escapeMarkdown(c.name)}*: ${escapeMarkdown(c.detail)}`,
  );

  const total = Object.values(report.queue).reduce((a, b) => a + b, 0);
  const attention = ATTENTION_STATES.filter((s) => (report.queue[s] ?? 0) > 0).map(
    (s) => `${s}=${report.queue[s]}`,
  );
  const queueLine = total
    ? `🗂 Очередь: всего ${total}${attention.length ? ` (внимание: ${attention.join(", ")})` : ""}`
    : "🗂 Очередь пуста";

  return [head, "", ...lines, "", escapeMarkdown(queueLine)].join("\n");
}
