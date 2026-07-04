import { z } from "zod";

/**
 * Zod schema for the rewrite entity — the structured output of the LLM rewrite.
 * Validated on the way out of every provider; the blog publish body is derived
 * directly from these fields. Kept in src/schemas/ (one schema file per entity)
 * so validation lives apart from the plain interfaces in src/types.ts.
 */
export const RewriteSchema = z.object({
  title: z.string().min(1),
  description: z.string().min(1),
  content: z.string().min(1),
  tags: z.array(z.string()).max(8),
  metaTitle: z.string(),
  metaDescription: z.string(),
});

/** The validated rewrite result, inferred from {@link RewriteSchema}. */
export type RewriteResult = z.infer<typeof RewriteSchema>;
