/**
 * Guarantees a post ends with the canonical source-attribution line, regardless
 * of what the model returned. Lives in its own module so rewriteToPost.ts stays
 * under the per-file size budget.
 */

import { normalizeHttpUrl } from "./safeUrl.js";

/** Matches a well-formed source line: `Источник: [label](url)` (label/url captured). */
const SOURCE_LINE_RE = /^Источник:\s*\[([^\]]*)\]\(([^)]+)\)\s*$/;

const TRAILING_SOURCE_RE = /(?:^|\n\n?)Источник:\s*\[[^\]]*\]\([^\n]*\)\s*$/;

function escapeMarkdownLabel(value: string): string {
  const printable = [...value]
    .map((char) => {
      const code = char.charCodeAt(0);
      return code <= 31 || code === 127 ? " " : char;
    })
    .join("");
  return printable
    .replace(/https?:\/\/[^\s\]]+/gi, "ссылка удалена")
    .replace(/[\\[\]()]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Builds the one canonical attribution line for a feed item. */
function canonicalSourceLine(feedTitle: string, url: string): string {
  return `Источник: [${escapeMarkdownLabel(feedTitle) || "оригинал"}](${url})`;
}

/**
 * Deterministic self-heal: ensures `content` ends with the canonical source
 * line. If the last non-empty line is already a well-formed `Источник: [..](..)`
 * line, it's replaced with the canonical one (normalizing a stale label/url);
 * otherwise the canonical line is appended after a blank line. Never throws —
 * missing/malformed attribution is repaired, not rejected.
 */
export function ensureSourceLine(content: string, feedTitle: string, url: string): string {
  const body = content.trimEnd();
  const lines = body.split("\n");
  const lastIdx = lines.reduce((acc, line, i) => (line.trim() ? i : acc), -1);
  const safeUrl = normalizeHttpUrl(url);
  if (!safeUrl) return body.replace(TRAILING_SOURCE_RE, "").trimEnd();
  const canonical = canonicalSourceLine(feedTitle, safeUrl);
  if (lastIdx >= 0 && SOURCE_LINE_RE.test(lines[lastIdx]!.trim())) {
    lines[lastIdx] = canonical;
    return lines.slice(0, lastIdx + 1).join("\n");
  }
  return body ? `${body}\n\n${canonical}` : canonical;
}
