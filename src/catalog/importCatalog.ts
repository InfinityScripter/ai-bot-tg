import { CONFIG } from "../config.js";
import { fetchAutoPublishFlags } from "../blog/index.js";
import { nameKey, fetchArtificialAnalysis, fetchOpenRouterContexts } from "./fetchCatalog.js";

import type { CatalogModel } from "./fetchCatalog.js";
import type { CreateReleasePayload } from "../types.js";

/**
 * Daily catalog import: turns "a model appeared in Artificial Analysis" into a
 * changelog record on the blog, with no LLM and no human in the loop.
 *
 * This is the FACTS half of the changelog. The curated timeline in the frontend
 * repo stays the editorial half — description, highlight, fun fact — and the
 * site joins the two by vendor + name + date. Importing a model that already has
 * a curated entry is therefore harmless: the page shows one card, not two.
 */

const PUBLISH_TIMEOUT_MS = 20_000;

/**
 * Artificial Analysis spells some creators differently from the curated
 * timeline, and the site matches a record to its editorial text by vendor name.
 * Left as the catalog writes it → the same model would show up twice. Only
 * verified divergences are listed; an unknown creator passes through verbatim.
 *
 * ("Z AI" is absent on purpose: the frontend already aliases it to Zhipu AI.)
 */
const VENDOR_SPELLING: Readonly<Record<string, string>> = {
  inclusionai: "Ant Group",
  "thinking machines": "Thinking Machines Lab",
  mistral: "Mistral AI",
  // AA files Moonshot's models under the product name.
  kimi: "Moonshot AI",
};

export interface CatalogImportSummary {
  /** Models in the catalog with a usable release date. */
  scanned: number;
  /** Of those, released inside the window and collapsed to one row per model. */
  fresh: number;
  created: number;
  /** Already on the blog — the backend rejects a repeated slug with 409. */
  duplicate: number;
  failed: number;
  /** Set when the run stopped before publishing anything. */
  skipped?: string;
}

function vendorSpelling(creator: string): string {
  return VENDOR_SPELLING[creator.trim().toLowerCase()] ?? creator.trim();
}

/** `YYYY-MM-DD` of the day `days` before now, in UTC. */
function windowStart(days: number, now: Date): string {
  const edge = new Date(now.getTime() - days * 86_400_000);
  return edge.toISOString().slice(0, 10);
}

/**
 * One model is listed several times when it has effort modes — "Claude Opus 5
 * (Adaptive Reasoning, Xhigh Effort)" next to "Claude Opus 5". They are one
 * release, so the trailing parenthetical is dropped and the shortest name wins;
 * importing them separately would put near-identical cards on the page.
 */
export function collapseVariants(models: CatalogModel[]): CatalogModel[] {
  const byModel = new Map<string, CatalogModel>();
  for (const model of models) {
    const base = model.name.replace(/\s*\([^)]*\)\s*$/, "").trim() || model.name;
    // nameKey keeps only latin letters and digits, so a fully non-latin name
    // reduces to an empty string — without the fallback every such model would
    // land under one key and all but one would silently vanish from the import.
    const key = `${vendorSpelling(model.vendor).toLowerCase()}:${nameKey(base) || base.toLowerCase()}`;
    const known = byModel.get(key);
    if (!known || base.length < known.name.length) {
      byModel.set(key, { ...model, name: base });
    }
  }
  return [...byModel.values()];
}

/**
 * The changelog body. `version` carries the release day: the field is required
 * by the backend, the catalog has no separate version, and the frontend
 * deliberately does not append a date-like version to the displayed name. The
 * explicit `slug` keeps the URL readable (`ling-3-0-tiny`) and makes the record
 * idempotent — a second import of the same model is rejected as a duplicate.
 */
export function toReleasePayload(
  model: CatalogModel,
  contextTokens: number | null,
): CreateReleasePayload {
  return {
    vendor: vendorSpelling(model.vendor),
    model: model.name,
    version: model.releaseDate,
    releasedAt: `${model.releaseDate}T00:00:00Z`,
    sourceUrl: model.sourceUrl,
    slug: model.slug,
    contextTokens,
    priceIn: model.priceIn,
    priceOut: model.priceOut,
    changes: [],
    sourceName: "Artificial Analysis",
  };
}

type PublishOutcome = "created" | "duplicate" | "failed";

/**
 * Publishes one record. A 409 is the normal outcome for anything imported on an
 * earlier run — the backend derives the slug and rejects a repeat — so it is
 * counted, not thrown. Everything else is logged and counted as failed: one bad
 * record must not abort the rest of the sweep.
 */
async function publish(payload: CreateReleasePayload): Promise<PublishOutcome> {
  const url = `${CONFIG.BLOG_API_URL.replace(/\/$/, "")}/api/changelog/new`;
  try {
    const res = await fetch(url, {
      method: "POST",
      signal: AbortSignal.timeout(PUBLISH_TIMEOUT_MS),
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${CONFIG.BOT_API_TOKEN}`,
        "Idempotency-Key": `catalog:${payload.slug}`,
      },
      body: JSON.stringify(payload),
    });
    if (res.status === 201) return "created";
    if (res.status === 409) return "duplicate";
    const text = await res.text().catch(() => "");
    console.warn(`[catalog] ${payload.slug}: blog responded ${res.status}: ${text.slice(0, 200)}`);
    return "failed";
  } catch (err) {
    console.warn(`[catalog] ${payload.slug}: publish failed: ${String(err)}`);
    return "failed";
  }
}

/**
 * One import sweep. Gated on the same `autoPublishReleases` switch the RSS
 * pipeline uses, which fails closed: no key, flag off, or an unreadable settings
 * response and nothing is published. A missing OpenRouter response is NOT fatal
 * — it only costs the context window, which is recorded as unknown.
 */
export async function importCatalog(
  options: { days?: number; now?: Date } = {},
): Promise<CatalogImportSummary> {
  const days = options.days ?? CONFIG.CATALOG_IMPORT_DAYS;
  const empty = { scanned: 0, fresh: 0, created: 0, duplicate: 0, failed: 0 };

  if (!CONFIG.AA_API_KEY) {
    return { ...empty, skipped: "AA_API_KEY unset" };
  }
  const flags = await fetchAutoPublishFlags();
  if (!flags.releases) {
    return { ...empty, skipped: "autoPublishReleases is off" };
  }

  const models = await fetchArtificialAnalysis(CONFIG.AA_API_KEY);
  const contexts = await fetchOpenRouterContexts().catch((err) => {
    console.warn(`[catalog] OpenRouter unavailable, context stays unknown: ${String(err)}`);
    return new Map<string, number>();
  });

  const since = windowStart(days, options.now ?? new Date());
  const fresh = collapseVariants(models.filter((model) => model.releaseDate >= since));

  const summary: CatalogImportSummary = { ...empty, scanned: models.length, fresh: fresh.length };
  for (const model of fresh) {
    const payload = toReleasePayload(model, contexts.get(nameKey(model.name)) ?? null);
    const outcome = await publish(payload);
    summary[outcome] += 1;
  }
  return summary;
}
