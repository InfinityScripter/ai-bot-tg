import { decodeEntityRefs } from "./ingestArticle.js";

/**
 * The subset of Telegram Bot API HTML the channel posts keep. Aliases collapse
 * to one name so two HTML strings can be compared by their tag multiset.
 */
const TAGS: Record<string, string> = {
  b: "b",
  strong: "b",
  i: "i",
  em: "i",
  u: "u",
  ins: "u",
  s: "s",
  strike: "s",
  del: "s",
  a: "a",
  code: "code",
  pre: "pre",
  blockquote: "blockquote",
};

/** t.me/s renders emoji as an image around the emoji character; keep the character. */
const EMOJI_RE = /<i\s+class="emoji"[^>]*>([\s\S]*?)<\/i>/gi;
const TOKEN_RE = /<!--[\s\S]*?-->|<(\/?)([a-z][a-z0-9-]*)\b([^>]*)>/gi;
const HREF_ATTR_RE = /(?:^|\s)href\s*=\s*(?:"([^"]*)"|'([^']*)')/i;

export interface SanitizeOptions {
  /** When set, an <a> survives only if its href is in this list (trailing slash ignored). */
  allowedHrefs?: Iterable<string>;
}

interface Open {
  name: string;
  emitted: boolean;
}

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function normalizeHref(href: string): string {
  return href.trim().replace(/\/+$/, "");
}

function linkTarget(attrs: string, allowed: Set<string> | null): string | null {
  const m = HREF_ATTR_RE.exec(attrs);
  const href = decodeEntityRefs(m?.[1] ?? m?.[2] ?? "").trim();
  if (!/^https?:\/\/\S+$/i.test(href)) return null;
  return !allowed || allowed.has(normalizeHref(href)) ? href : null;
}

/** Bot API nesting rules: nothing inside code/pre, code/pre only at top level or in a quote, no quote in a link, no nested links or quotes. */
function canOpen(name: string, stack: Open[]): boolean {
  const verbatim = name === "code" || name === "pre";
  return !stack.some(
    (open) =>
      open.emitted &&
      (open.name === "code" ||
        open.name === "pre" ||
        (verbatim && open.name !== "blockquote") ||
        (name === "blockquote" && open.name === "a") ||
        (open.name === name && (name === "a" || name === "blockquote"))),
  );
}

/**
 * Reduces any HTML to balanced Telegram HTML: allowed tags only (no attributes
 * but an absolute a[href]), <br> as a newline, text entity-escaped. Telegram
 * answers 400 "can't parse entities" to broken markup, so the output must be
 * well-formed whatever the input was: unclosed tags are closed, stray closers
 * dropped, crossed tags closed at the outer closer.
 */
export function sanitizeTelegramHtml(html: string, opts: SanitizeOptions = {}): string {
  const allowed = opts.allowedHrefs ? new Set([...opts.allowedHrefs].map(normalizeHref)) : null;
  const source = html.replace(EMOJI_RE, (_, inner: string) => inner.replace(/<[^>]*>/g, ""));
  const out: string[] = [];
  const stack: Open[] = [];
  const closeTo = (depth: number) => {
    while (stack.length > depth) {
      const open = stack.pop();
      if (open?.emitted) out.push(`</${open.name}>`);
    }
  };
  let last = 0;
  for (const m of source.matchAll(TOKEN_RE)) {
    out.push(escapeHtml(decodeEntityRefs(source.slice(last, m.index))));
    last = m.index + m[0].length;
    const raw = (m[2] ?? "").toLowerCase();
    if (raw === "br") out.push("\n");
    const name = TAGS[raw];
    if (!name) continue;
    if (m[1]) {
      const at = stack.map((open) => open.name).lastIndexOf(name);
      if (at >= 0) closeTo(at);
      continue;
    }
    const href = name === "a" ? linkTarget(m[3] ?? "", allowed) : null;
    const emitted = canOpen(name, stack) && (name !== "a" || href !== null);
    stack.push({ name, emitted });
    if (emitted) out.push(href === null ? `<${name}>` : `<a href="${escapeHtml(href)}">`);
  }
  out.push(escapeHtml(decodeEntityRefs(source.slice(last))));
  closeTo(0);
  return out
    .join("")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** What the reader sees: tags removed, entities decoded. For sanitized HTML. */
export function visibleText(html: string): string {
  return decodeEntityRefs(html.replace(/<[^>]*>/g, ""));
}

/** The link targets of sanitized HTML, decoded, in order. */
export function hrefsOf(html: string): string[] {
  return [...html.matchAll(/<a href="([^"]*)">/g)].map((m) => decodeEntityRefs(m[1] ?? ""));
}

/** Sorted opening tag names of sanitized HTML: equal lists mean the same markup. */
export function tagNamesOf(html: string): string[] {
  return [...html.matchAll(/<([a-z]+)[\s>]/g)].map((m) => m[1] ?? "").sort();
}
