import { escapeHtml } from "../feeds/index.js";
import { ChannelDressSchema } from "../schemas/channelDressSchema.js";

import type { RewriteResult, ReleaseBundle, ChannelRetell } from "../types.js";

/** Parses the stored rewrite (rewrite_json column), or null. */
export function parseRewrite(json: string | null): RewriteResult | null {
  if (!json) return null;
  try {
    return JSON.parse(json) as RewriteResult;
  } catch {
    return null;
  }
}

/**
 * Parses the stored release bundle, or null. Same column as parseRewrite
 * (rewrite_json), read only for kind='release' candidates. Rows saved before
 * the bundle format hold a bare changelog card with no post; they read as null,
 * so the owner gets a 🔄 rewrite instead of a publish that would have nothing
 * to post.
 */
export function parseReleaseBundle(json: string | null): ReleaseBundle | null {
  if (!json) return null;
  try {
    const parsed = JSON.parse(json) as Partial<ReleaseBundle>;
    return parsed.post ? (parsed as ReleaseBundle) : null;
  } catch {
    return null;
  }
}

/**
 * Parses the stored retelling of a kind='channel' candidate, or null. A dress
 * that no longer validates is dropped: the post then gets a plain cover.
 */
export function parseRetell(json: string | null): ChannelRetell | null {
  if (!json) return null;
  try {
    const parsed = JSON.parse(json) as Partial<ChannelRetell> & { text?: unknown };
    if (typeof parsed.html === "string") {
      const dress = ChannelDressSchema.safeParse(parsed.dress);
      if (parsed.dress !== undefined && !dress.success) {
        console.warn(
          "[store] stored dress no longer validates, the cover falls back to the first line",
        );
      }
      return { html: parsed.html, ...(dress.success ? { dress: dress.data } : {}) };
    }
    // Rows retold before the HTML format stored plain text.
    return typeof parsed.text === "string" ? { html: escapeHtml(parsed.text) } : null;
  } catch {
    return null;
  }
}
