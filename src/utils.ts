/** Query params dropped when canonicalizing a URL for dedup. */
const TRACKING_PARAMS = [
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_term',
  'utm_content',
  'utm_reader',
  'fbclid',
  'gclid',
  'yclid',
  'igshid',
  'ref',
];

/**
 * Canonicalizes a guid/link into a stable dedup key: lowercase host, drop
 * tracking params and fragment, strip a trailing slash. Falls back to a
 * lowercased trim of the raw string when it isn't a parseable URL (some feeds
 * use non-URL guids).
 */
export function canonicalizeUrl(raw: string): string {
  const value = (raw ?? '').trim();
  if (!value) return '';

  try {
    const url = new URL(value);
    url.hostname = url.hostname.toLowerCase();
    url.hash = '';
    for (const param of TRACKING_PARAMS) {
      url.searchParams.delete(param);
    }
    // Sort remaining params so the same article with differently-ordered query
    // strings collapses to one dedup key. URLSearchParams preserves insertion
    // order, so we rebuild it sorted. Empty query drops the dangling '?'.
    const sorted = new URLSearchParams(
      [...url.searchParams.entries()].sort(([a], [b]) => a.localeCompare(b))
    ).toString();
    url.search = sorted ? `?${sorted}` : '';
    let out = url.toString();
    if (out.endsWith('/')) out = out.slice(0, -1);
    return out.toLowerCase();
  } catch {
    return value.toLowerCase();
  }
}

/**
 * Builds the dedup key from a feed item, preferring a stable guid and falling
 * back to the link. Returns '' when neither is usable (caller should skip).
 */
export function dedupKeyFor(guid: string | undefined, link: string | undefined): string {
  return canonicalizeUrl(guid || link || '');
}

/** Strips HTML tags and collapses whitespace — defensive for feeds that put markup in snippets. */
export function stripHtml(input: string): string {
  return (input ?? '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Truncates a string to `max` chars on a word boundary, adding an ellipsis. */
export function truncate(input: string, max: number): string {
  if (input.length <= max) return input;
  const cut = input.slice(0, max);
  const lastSpace = cut.lastIndexOf(' ');
  return `${(lastSpace > 0 ? cut.slice(0, lastSpace) : cut).trim()}…`;
}

/**
 * Escapes Telegram legacy-Markdown special characters so feed/LLM content
 * embedded in a `parse_mode: 'Markdown'` message can't break or hijack the
 * formatting. Covers the legacy-Markdown set: \ * _ ` [. The backslash is
 * escaped FIRST so it can't combine with a following escape (a lone `\` before
 * a special char in LLM output — regex, paths — would otherwise re-open an
 * entity and trigger a "can't parse entities" 400).
 */
export function escapeMarkdown(input: string): string {
  return (input ?? '').replace(/\\/g, '\\\\').replace(/([_*[\]`])/g, '\\$1');
}
