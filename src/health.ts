import { CONFIG } from "./config.js";
import { pingModel } from "./models.js";
import { CandidateState } from "./enums.js";
import { escapeMarkdown } from "./utils.js";
import { PROVIDERS, isMockActive, resolveActiveProvider } from "./providers.js";

import type { CandidateStore } from "./store/index.js";

/** One probed subsystem: ok/!ok plus a short human detail. */
export interface HealthCheck {
  name: string;
  ok: boolean;
  detail: string;
}

/** The full readiness report assembled by collectHealth. */
export interface HealthReport {
  /** True only when every check is ok. */
  healthy: boolean;
  checks: HealthCheck[];
  /** Candidate count per state, for the queue summary. */
  queue: Record<string, number>;
}

/** Injectable deps so tests never touch the real network/clock. */
export interface HealthDeps {
  /** Active-model probe; defaults to the real pingModel. */
  pingFn?: typeof pingModel;
  /** HTTP client for the blog-API reachability probe; defaults to global fetch. */
  fetchFn?: typeof fetch;
  /** Next scheduled cron run; null when unknown. */
  nextRun?: () => Date | null;
  /** Process uptime in seconds; defaults to process.uptime. */
  uptimeSec?: () => number;
}

/** Formats a second count as e.g. "2д 3ч 4м" / "5м 12с". */
function formatUptime(totalSec: number): string {
  const s = Math.max(0, Math.floor(totalSec));
  const d = Math.floor(s / 86_400);
  const h = Math.floor((s % 86_400) / 3_600);
  const m = Math.floor((s % 3_600) / 60);
  const sec = s % 60;
  if (d > 0) return `${d}д ${h}ч ${m}м`;
  if (h > 0) return `${h}ч ${m}м`;
  if (m > 0) return `${m}м ${sec}с`;
  return `${sec}с`;
}

/** Probes the active LLM provider/model (or reports mock is on). */
async function checkProvider(
  store: CandidateStore,
  pingFn: typeof pingModel,
): Promise<HealthCheck> {
  const { provider, model } = resolveActiveProvider(store);
  const { label } = PROVIDERS[provider];
  if (isMockActive(store)) {
    return { name: "LLM", ok: true, detail: `mock (без LLM) — ${label}/${model}` };
  }
  const started = Date.now();
  // pingModel never throws by contract, but guard anyway so a misbehaving probe
  // can't reject the whole report — every check must stay isolated.
  let result: Awaited<ReturnType<typeof pingModel>>;
  try {
    result = await pingFn(provider, model);
  } catch (err) {
    return { name: "LLM", ok: false, detail: `${label}/${model}: ${String(err)}` };
  }
  const ms = Date.now() - started;
  return result.ok
    ? { name: "LLM", ok: true, detail: `${label}/${model} (${ms}мс)` }
    : { name: "LLM", ok: false, detail: `${label}/${model}: ${result.error ?? "ошибка"}` };
}

/** Probes that the blog publish API is reachable (HEAD, short timeout). */
async function checkBlog(fetchFn: typeof fetch): Promise<HealthCheck> {
  const url = CONFIG.BLOG_API_URL.replace(/\/$/, "");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5_000);
  try {
    const res = await fetchFn(url, { method: "HEAD", signal: controller.signal });
    // Any HTTP answer (even 404) means the host is up and routing — that is all
    // this check asserts (it does not authenticate the publish path).
    return { name: "Блог API", ok: true, detail: `${url} → ${res.status}` };
  } catch (err) {
    return { name: "Блог API", ok: false, detail: `${url}: ${String(err)}` };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Collects a full readiness report: process uptime, next cron run, the active
 * LLM provider, the blog API, and the queue counts. Every probe is isolated, so
 * one failing subsystem never aborts the others. `healthy` is true only when all
 * checks pass; the queue summary is informational and never flips it.
 */
export async function collectHealth(
  store: CandidateStore,
  deps: HealthDeps = {},
): Promise<HealthReport> {
  const pingFn = deps.pingFn ?? pingModel;
  const fetchFn = deps.fetchFn ?? fetch;
  const uptimeSec = deps.uptimeSec ?? (() => process.uptime());

  const checks: HealthCheck[] = [
    {
      name: "Процесс",
      ok: true,
      detail: `аптайм ${formatUptime(uptimeSec())}, node ${process.version}`,
    },
  ];

  const next = deps.nextRun?.() ?? null;
  checks.push({
    name: "Расписание",
    ok: true,
    detail: next ? `следующий сбор ${next.toISOString()}` : "не запланировано",
  });

  const [provider, blog] = await Promise.all([checkProvider(store, pingFn), checkBlog(fetchFn)]);
  checks.push(provider, blog);

  const queue = store.countsByState();
  const healthy = checks.every((c) => c.ok);
  return { healthy, checks, queue };
}

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
