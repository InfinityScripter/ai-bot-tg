import { pingModel, PROVIDERS, CONTROL_PROVIDERS } from "../llm/index.js";

import type { ProviderName } from "../enums.js";

/**
 * One model's reachability result, for the admin panel's model-health table.
 * `ms` is the round-trip of the ping; `error` is set only when `ok` is false.
 */
export interface ModelProbe {
  provider: string;
  /** Provider's human label (e.g. "GLM"), so the UI need not re-derive it. */
  label: string;
  model: string;
  ok: boolean;
  ms: number;
  error?: string;
}

/** Aggregate result: every probe plus a single rollup flag. */
export interface ModelsHealthReport {
  /** True only when every probed model is ok. */
  healthy: boolean;
  checks: ModelProbe[];
}

export interface ProbeModelsDeps {
  /** Active-model probe; defaults to the real pingModel (injected in tests). */
  pingFn?: typeof pingModel;
}

/** Pings one provider's default model, timing the round-trip. Never throws. */
async function probeOne(provider: ProviderName, pingFn: typeof pingModel): Promise<ModelProbe> {
  const spec = PROVIDERS[provider];
  const { defaultModel: model } = spec;
  const started = Date.now();
  let ok = false;
  let error: string | undefined;
  try {
    const result = await pingFn(provider, model);
    ({ ok } = result);
    if (!result.ok) ({ error } = result);
  } catch (err) {
    // pingModel is contract-bound never to throw, but isolate anyway so one bad
    // provider can't reject the whole batch.
    error = String(err);
  }
  const probe: ModelProbe = { provider, label: spec.label, model, ok, ms: Date.now() - started };
  if (error !== undefined) probe.error = error;
  return probe;
}

/**
 * Pings the default model of every admin-controllable provider (CONTROL_PROVIDERS)
 * so the panel can show which models actually work right now. This is the
 * full-matrix check — distinct from collectHealth's active-only LLM probe, which
 * stays fast for the Telegram /health command. Probes run concurrently; each
 * pingModel already carries its own 8s timeout, so the batch is bounded.
 */
export async function probeAllModels(deps: ProbeModelsDeps = {}): Promise<ModelsHealthReport> {
  const pingFn = deps.pingFn ?? pingModel;
  const checks = await Promise.all(CONTROL_PROVIDERS.map((p) => probeOne(p, pingFn)));
  return { healthy: checks.every((c) => c.ok), checks };
}
