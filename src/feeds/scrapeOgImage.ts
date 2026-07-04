import { fetchHtml } from "./fetchHtml.js";

/** Matches og:image / twitter:image (property/name before content). */
export const OG_IMAGE_RE =
  /<meta[^>]+(?:property|name)=["'](?:og:image|og:image:url|twitter:image)["'][^>]+content=["']([^"']+)["']/i;
/** Same, content before property/name (attribute order varies). */
export const OG_IMAGE_RE_ALT =
  /<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["'](?:og:image|og:image:url|twitter:image)["']/i;

/**
 * Fetches an article page and extracts its og:image (or twitter:image) URL.
 * Single GET, 8s timeout, reads only the first 64KB of HTML. Tolerant: any
 * failure (network, non-HTML, no tag) resolves to null — a missing cover must
 * never fail a collection run.
 */
export async function fetchOgImage(url: string): Promise<string | null> {
  if (!url || !/^https?:\/\//i.test(url)) return null;
  try {
    const html = await fetchHtml(url, 64_000);
    const match = OG_IMAGE_RE.exec(html) ?? OG_IMAGE_RE_ALT.exec(html);
    const found = match?.[1]?.trim();
    if (found && /^https?:\/\//i.test(found)) return found;
    return null;
  } catch {
    return null;
  }
}
