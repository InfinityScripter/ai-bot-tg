// Matches src="..." / src='...' inside an <img …> tag. Global for matchAll sweeps.
export const IMG_SRC_RE = /<img\b[^>]*?\bsrc\s*=\s*["']([^"']+)["'][^>]*>/gi;

/**
 * Collects every usable image URL for an article: the cover first, then every
 * <img src> found in `html`, de-duplicated and order-preserved. Only absolute
 * http(s) URLs are kept — relative/data: URIs are dropped so what goes
 * downstream is always a real, fetchable image. Shared by the RSS mapper and
 * the manual-ingest page scraper so both produce the same `imageUrls` shape.
 */
export function collectImageUrls(cover: string | null, html: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (url: string | null | undefined) => {
    if (!url) return;
    const u = url.trim();
    if (!/^https?:\/\//i.test(u)) return; // skip relative / data: URIs
    if (seen.has(u)) return;
    seen.add(u);
    out.push(u);
  };

  push(cover);
  for (const m of html.matchAll(IMG_SRC_RE)) {
    push(m[1]);
  }
  return out;
}
