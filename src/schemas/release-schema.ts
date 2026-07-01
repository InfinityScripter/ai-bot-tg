import { z } from "zod";

/**
 * Zod schema for the release entity — the structured output of the LLM release
 * extraction. Validated on the way out of every provider; the changelog publish
 * body (CreateReleasePayload) is derived directly from these fields. Kept in
 * src/schemas/ (one schema file per entity) so validation lives apart from the
 * plain interfaces in src/types.ts.
 *
 * Nullable price/context/date fields are DELIBERATE: the extraction prompt
 * instructs the model to return null for anything it cannot verify from the
 * source (never guess a number), so a null here means "unknown", not "zero".
 */
export const ReleaseSchema = z.object({
  vendor: z.string().min(1),
  model: z.string().min(1),
  version: z.string().min(1),
  /** ISO date the model was released, as reported by the source. */
  releasedAt: z.string().min(1),
  sourceUrl: z.string().min(1),
  /** Context window in tokens, or null when the source doesn't state it. */
  contextTokens: z.number().nullable(),
  /** Input price $/1M tokens, or null when unknown. NEVER invented. */
  priceIn: z.number().nullable(),
  /** Output price $/1M tokens, or null when unknown. NEVER invented. */
  priceOut: z.number().nullable(),
  /** Highlighted changes/features; defaults to [] when the source lists none. */
  changes: z.array(z.string()).default([]),
  /** Human-readable source name, or null. */
  sourceName: z.string().nullable(),
});

/** The validated release result, inferred from {@link ReleaseSchema}. */
export type ReleaseResult = z.infer<typeof ReleaseSchema>;
