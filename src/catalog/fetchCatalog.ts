import { z } from "zod";

/**
 * Model catalogs used as the "what shipped" signal for the changelog import.
 *
 * Artificial Analysis is the primary source: it carries a release date for every
 * model it tracks, so a daily sweep sees new releases without guessing from
 * search results. OpenRouter is secondary and keyless — it supplies the context
 * window, which the AA free tier does not return.
 *
 * NEITHER catalog is treated as the truth ABOUT a model. Their metadata is
 * regularly wrong (AA listed the open-weights Ling-3.0-flash as closed and dated
 * it twelve days late). Only four fields are imported: creator, name, release
 * date and price. Everything descriptive — what changed, why it matters — stays
 * with the curated timeline, which a human writes.
 */

const AA_MODELS_URL = "https://artificialanalysis.ai/api/v2/data/llms/models";
const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models";
const CATALOG_TIMEOUT_MS = 30_000;

/** Model page on Artificial Analysis — also the attribution their free API requires. */
const AA_MODEL_PAGE = "https://artificialanalysis.ai/models";

const aaPricingSchema = z
  .object({
    price_1m_input_tokens: z.number().nullish(),
    price_1m_output_tokens: z.number().nullish(),
  })
  .nullish();

const aaModelSchema = z.object({
  name: z.string().trim().min(1),
  slug: z.string().trim().min(1),
  release_date: z.string().trim().nullish(),
  model_creator: z.object({ name: z.string().trim().min(1) }),
  pricing: aaPricingSchema,
});

const aaResponseSchema = z.object({ data: z.array(aaModelSchema) });

const openRouterModelSchema = z.object({
  name: z.string(),
  context_length: z.number().nullish(),
});

const openRouterResponseSchema = z.object({ data: z.array(openRouterModelSchema) });

/** One model as the catalogs describe it, before it becomes a changelog record. */
export interface CatalogModel {
  vendor: string;
  name: string;
  slug: string;
  /** ISO calendar day, `YYYY-MM-DD`. */
  releaseDate: string;
  priceIn: number | null;
  priceOut: number | null;
  sourceUrl: string;
}

/**
 * Comparison key for a model name across catalogs: lowercase, letters and digits
 * only. "Ling 3.0 Tiny", "Ling-3.0-tiny" and "inclusionAI: Ling 3.0 Tiny (free)"
 * (after the prefix/suffix strip below) all collapse to `ling30tiny`. Same rule
 * the blog frontend uses to match a release against a curated entry.
 */
export function nameKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

/**
 * A price of 0 in the catalog means "no paid tier is tracked" — a promo window,
 * a preview, or a model served free by one provider. Recording it as $0 would
 * read on the site as "this model is free", which stops being true the week the
 * promo ends. Unknown → null, per the never-invent rule the backend records.
 */
function price(value: number | null | undefined): number | null {
  return typeof value === "number" && value > 0 ? value : null;
}

async function getJson(url: string, headers: Record<string, string> = {}): Promise<unknown> {
  const res = await fetch(url, {
    headers,
    signal: AbortSignal.timeout(CATALOG_TIMEOUT_MS),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`${url} responded ${res.status}: ${text.slice(0, 200)}`);
  }
  return res.json();
}

/**
 * Every model Artificial Analysis tracks, with a usable release date. Models
 * without one are dropped: a changelog record has to be datable, and the backend
 * requires `releasedAt`.
 */
export async function fetchArtificialAnalysis(apiKey: string): Promise<CatalogModel[]> {
  const raw = await getJson(AA_MODELS_URL, { "x-api-key": apiKey });
  const parsed = aaResponseSchema.parse(raw);
  return parsed.data
    .filter((model) => /^\d{4}-\d{2}-\d{2}$/.test(model.release_date ?? ""))
    .map((model) => ({
      vendor: model.model_creator.name,
      name: model.name,
      slug: model.slug,
      releaseDate: model.release_date as string,
      priceIn: price(model.pricing?.price_1m_input_tokens),
      priceOut: price(model.pricing?.price_1m_output_tokens),
      sourceUrl: `${AA_MODEL_PAGE}/${model.slug}`,
    }));
}

/**
 * Context window per model name, from the keyless OpenRouter catalog. Their
 * names carry a vendor prefix and a tier suffix ("inclusionAI: Ling 3.0 Tiny
 * (free)"), both stripped before keying. A model listed twice keeps the largest
 * window — variants of one model differ in price, not in context.
 */
export async function fetchOpenRouterContexts(): Promise<Map<string, number>> {
  const raw = await getJson(OPENROUTER_MODELS_URL);
  const parsed = openRouterResponseSchema.parse(raw);
  const contexts = new Map<string, number>();
  for (const model of parsed.data) {
    if (!model.context_length) continue;
    const bare = model.name.replace(/^[^:]+:\s*/, "").replace(/\s*\([^)]*\)\s*$/, "");
    const key = nameKey(bare);
    if (!key) continue;
    const known = contexts.get(key);
    if (known === undefined || model.context_length > known) {
      contexts.set(key, model.context_length);
    }
  }
  return contexts;
}
