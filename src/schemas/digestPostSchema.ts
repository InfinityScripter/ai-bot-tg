import { z } from "zod";

/**
 * Zod schema for the daily digest post the LLM assembles from the queued news
 * candidates. The model returns ONLY structured data — title, intro and four
 * sections of {url, headline, note} entries; the Markdown body (section
 * headers, 🔹 bullets, link syntax) is rendered deterministically in code
 * (renderDigestPost.ts), so the model can never emit a malformed or invented
 * link. buildDigestPost additionally drops any entry whose url is not among
 * the source items (allow-list), mirroring finalizeRewrite's link policy.
 */

const DigestEntrySchema = z.object({
  /** Source URL, must be copied verbatim from one of the input items. */
  url: z.string().url(),
  /** The linked phrase of the bullet (what the reader clicks), RU, specific. */
  headline: z.string().trim().min(1).max(200),
  /** Optional continuation after the link: the one-line takeaway. */
  note: z.string().trim().max(500).optional(),
});

const SECTION_LIMIT = 12;

export const DigestPostSchema = z.object({
  /** Post title. The renderer clamps to 100 chars as a final safety net. */
  title: z.string().trim().min(1).max(160),
  /** 1–2 sentence lead under the title. */
  intro: z.string().trim().min(1).max(500),
  sections: z.object({
    /** The 1–3 biggest stories of the day. */
    hot: z.array(DigestEntrySchema).max(SECTION_LIMIT),
    /** Product/company news. */
    news: z.array(DigestEntrySchema).max(SECTION_LIMIT),
    /** Research, guides, long reads. */
    materials: z.array(DigestEntrySchema).max(SECTION_LIMIT),
    /** Discussions, case studies, community findings. */
    cases: z.array(DigestEntrySchema).max(SECTION_LIMIT),
  }),
});

export type DigestEntry = z.infer<typeof DigestEntrySchema>;
export type DigestPost = z.infer<typeof DigestPostSchema>;
