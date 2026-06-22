import { ProviderKind } from "../enums.js";
import { pingModel, PROVIDERS, providerNames } from "../llm/index.js";

import type { ProviderName, ProviderSpec } from "../llm/index.js";

/**
 * Diagnostic CLI (`npm run test:models`): for every provider, reports whether
 * its model endpoint is reachable FROM THE HOST THIS RUNS ON. Run it on the VPS
 * to see the real reason a provider is dead — the daily run only surfaces the
 * active provider's failure (e.g. "Не удалось связаться с GLM: fetch failed").
 *
 * It calls fetch directly (not listModels, which swallows errors into the static
 * fallback list) so a network/geo failure is shown verbatim. Exit code is always
 * 0 — this is a report, never a CI gate.
 */

const TIMEOUT_MS = 8_000;
const KEY_ENV: Partial<Record<ProviderName, string>> = {
  anthropic: "ANTHROPIC_API_KEY",
  gemini: "GEMINI_API_KEY",
  glm: "GLM_API_KEY",
  deepseek: "DEEPSEEK_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
};

interface ModelsListResponse {
  data?: { id?: string }[];
}

/** GETs {baseUrl}/models with the key; returns a one-line status string. */
async function probeOpenAICompat(spec: ProviderSpec, key: string): Promise<string> {
  let response: Response;
  try {
    response = await fetch(`${spec.baseUrl}/models`, {
      method: "GET",
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    const timedOut = err instanceof Error && err.name === "TimeoutError";
    return timedOut ? "❌ timeout" : `❌ fetch failed: ${String(err)}`;
  }
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    return `❌ HTTP ${response.status}: ${text.slice(0, 120)}`;
  }
  let data: ModelsListResponse;
  try {
    data = (await response.json()) as ModelsListResponse;
  } catch {
    return "❌ ответ не JSON";
  }
  const ids = (data.data ?? [])
    .map((m) => m.id)
    .filter((id): id is string => typeof id === "string" && id.length > 0);
  const sample = ids.slice(0, 10).join(", ");
  return `✅ OK (${ids.length} моделей)${sample ? ` — ${sample}` : ""}`;
}

/** Anthropic has no OpenAI-shape /models list; do a key + chat-ping check. */
async function probeAnthropic(spec: ProviderSpec): Promise<string> {
  const ping = await pingModel("anthropic" as ProviderName, spec.defaultModel);
  return ping.ok ? `✅ ключ задан, ping ${spec.defaultModel}: ok` : `❌ ${ping.error}`;
}

async function probeProvider(name: ProviderName): Promise<string> {
  const spec = PROVIDERS[name];
  if (spec.kind === ProviderKind.Mock) return "➖ mock (без сети)";

  const key = spec.apiKey();
  if (!key) return `⚠ SKIP — нет ${KEY_ENV[name] ?? "ключа"}`;

  if (spec.kind === ProviderKind.Anthropic) return probeAnthropic(spec);
  return probeOpenAICompat(spec, key);
}

async function main(): Promise<void> {
  const log = (s: string) => process.stdout.write(`${s}\n`);
  log("Проверка провайдеров (reachability с этого хоста):\n");
  for (const name of providerNames()) {
    const spec = PROVIDERS[name];
    // eslint-disable-next-line no-await-in-loop -- sequential keeps output ordered + readable
    const status = await probeProvider(name);
    log(`  ${spec.label.padEnd(16)} ${status}`);
  }
  log("\nГотово. Провайдеры со статусом ❌/⚠ недоступны с этого хоста.");
  process.exit(0);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("[test-models] fatal:", err);
  process.exit(0);
});
