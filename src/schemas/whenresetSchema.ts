import { z } from "zod";

// Reject a partial history rather than baseline it and later publish its archive.
const publicHttpsUrl = z
  .string()
  .url()
  .refine((value) => {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password;
  });
const eventSchema = z.object({
  id: z.string().min(1).max(200),
  date: z.string().date(),
  ts: z.string().datetime({ offset: true }).nullable(),
  type: z.string(),
  kind: z.string(),
  scope: z.string().max(500),
  url: publicHttpsUrl,
  summary: z.string().min(1).max(20_000),
  page: publicHttpsUrl,
  delivered_at: z.string().datetime({ offset: true }).nullish(),
  delivered_source_url: publicHttpsUrl.nullish(),
  delivery_note_en: z.string().max(2000).nullish(),
});
const productSchema = z
  .object({
    events: z.array(eventSchema).max(10_000),
    stats: z.object({
      total: z.number().int().nonnegative(),
      banked_count: z.number().int().nonnegative(),
    }),
  })
  // Stats describe reset history only. Future types/kinds stay excluded by the
  // reader and cannot stand in for a missing regular or banked reset.
  .refine(
    ({ events, stats }) =>
      events.filter((event) => event.type === "reset" && event.kind === "regular").length ===
        stats.total &&
      events.filter((event) => event.type === "reset" && event.kind === "banked").length ===
        stats.banked_count,
  );
export const WhenResetSchema = z
  .object({
    schema: z.literal("whenreset/v1"),
    generated_at: z.string().datetime({ offset: true }),
    products: z.object({ codex: productSchema, claude: productSchema }),
  })
  .refine((data) => data.products.codex.events.length + data.products.claude.events.length > 0);
