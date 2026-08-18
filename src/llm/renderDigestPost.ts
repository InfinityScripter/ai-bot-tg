import { NEWS_TAG } from "../blog/normalizeTags.js";
import { countDigestEntries } from "./buildDigestPost.js";

import type { RewriteResult } from "../types.js";
import type { DigestPost, DigestEntry } from "../schemas/digestPostSchema.js";

/**
 * Deterministic Markdown renderer for the daily digest post. The LLM returns
 * data only (see digestPostSchema); every header, bullet and link is emitted
 * here, so the published body always matches the owner's digest format and a
 * malformed model answer can break validation but never the layout.
 */

/** Section headers, in publish order, matching the owner's reference post. */
const SECTIONS: { key: keyof DigestPost["sections"]; header: string }[] = [
  { key: "hot", header: "🔥 Hot:" },
  { key: "news", header: "➡️ Новости:" },
  { key: "materials", header: "➡️ Полезные материалы:" },
  { key: "cases", header: "➡️ Обсуждения и кейсы:" },
];

const FOOTER =
  "📝 Если хотите дополнить список другими новостями и материалами, пишите в комментариях.";

/** One digest line: the linked headline, then the optional takeaway. */
function renderEntry(entry: DigestEntry): string {
  const note = entry.note?.trim();
  return `🔹 [${entry.headline}](${entry.url})${note ? ` — ${note}` : ""}`;
}

/** Renders the full post body (without the title — the blog shows it above). */
export function renderDigestMarkdown(post: DigestPost): string {
  const blocks: string[] = [post.intro];
  for (const { key, header } of SECTIONS) {
    const entries = post.sections[key];
    if (entries.length === 0) continue;
    blocks.push(`**${header}**\n\n${entries.map(renderEntry).join("\n")}`);
  }
  blocks.push(FOOTER);
  return blocks.join("\n\n");
}

/** Clamp for the SEO description (mirrors the rewrite prompt's ~155 target). */
const META_DESCRIPTION_MAX = 155;

/**
 * Wraps a digest into the RewriteResult shape so the existing publish path
 * (publishToBlog → /api/post/new) is reused verbatim. Tags: the mandatory
 * `новости` plus `дайджест` is NOT in the whitelist, so only the news tag is
 * sent — the blog's cover assignment and feeds treat it like any news post.
 */
export function toDigestRewrite(post: DigestPost): RewriteResult {
  return {
    title: post.title,
    description: post.intro,
    content: renderDigestMarkdown(post),
    tags: [NEWS_TAG],
    metaTitle: post.title,
    metaDescription: post.intro.slice(0, META_DESCRIPTION_MAX),
  };
}

/** Short plain-text summary for the owner DM ("N пунктов по секциям"). */
export function digestSummaryLine(post: DigestPost): string {
  const { hot, news, materials, cases } = post.sections;
  return (
    `${countDigestEntries(post)} пунктов: ` +
    `hot ${hot.length}, новости ${news.length}, ` +
    `материалы ${materials.length}, кейсы ${cases.length}`
  );
}
