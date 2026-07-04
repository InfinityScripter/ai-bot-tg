/**
 * Guarantees a post ends with the canonical source-attribution line, regardless
 * of what the model returned. Lives in its own module so rewriteToPost.ts stays
 * under the per-file size budget.
 */

/** Matches a well-formed source line: `Источник: [label](url)` (label/url captured). */
const SOURCE_LINE_RE = /^Источник:\s*\[([^\]]*)\]\(([^)]+)\)\s*$/;

/** Builds the one canonical attribution line for a feed item. */
function canonicalSourceLine(feedTitle: string, url: string): string {
  return `Источник: [${feedTitle || "оригинал"}](${url})`;
}

/**
 * Deterministic self-heal: ensures `content` ends with the canonical source
 * line. If the last non-empty line is already a well-formed `Источник: [..](..)`
 * line, it's replaced with the canonical one (normalizing a stale label/url);
 * otherwise the canonical line is appended after a blank line. Never throws —
 * missing/malformed attribution is repaired, not rejected.
 */
export function ensureSourceLine(content: string, feedTitle: string, url: string): string {
  const canonical = canonicalSourceLine(feedTitle, url);
  const body = content.trimEnd();
  const lines = body.split("\n");
  const lastIdx = lines.reduce((acc, line, i) => (line.trim() ? i : acc), -1);
  if (lastIdx >= 0 && SOURCE_LINE_RE.test(lines[lastIdx]!.trim())) {
    lines[lastIdx] = canonical;
    return lines.slice(0, lastIdx + 1).join("\n");
  }
  return body ? `${body}\n\n${canonical}` : canonical;
}
