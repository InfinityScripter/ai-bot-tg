import { CONFIG } from "../config.js";
import { pingModel, isMockActive, resolveActiveProvider, PROVIDERS } from "../llm/index.js";

import type { CandidateStore } from "../store/index.js";
import type { HealthCheck, HealthDeps } from "./types.js";

/** Formats a second count as e.g. "2д 3ч 4м" / "5м 12с". */
export function formatUptime(totalSec: number): string {
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
export async function checkProvider(
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
export async function checkBlog(fetchFn: typeof fetch): Promise<HealthCheck> {
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

export function processCheck(uptimeSec: () => number): HealthCheck {
  return {
    name: "Процесс",
    ok: true,
    detail: `аптайм ${formatUptime(uptimeSec())}, node ${process.version}`,
  };
}

export function scheduleCheck(nextRun: (() => Date | null) | undefined): HealthCheck {
  const next = nextRun?.() ?? null;
  return {
    name: "Расписание",
    ok: true,
    detail: next ? `следующий сбор ${next.toISOString()}` : "не запланировано",
  };
}
