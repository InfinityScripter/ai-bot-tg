import type { Definition, PhrasingContent } from "mdast";

import { unified } from "unified";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { visit } from "unist-util-visit";

import { decodeEntityRefs } from "./feeds/ingestArticle.js";
import { visibleText, sanitizeTelegramHtml } from "./feeds/telegramHtml.js";

import type { SourceLink } from "./types.js";

/** External materials keep their exact input URL; parsing is only for validation and dedup. */
export function isExternalSourceUrl(url: string): boolean {
  if (!/^https?:\/\/\S+$/i.test(url) || url.includes("\\")) return false;
  if ([...url].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)) return false;
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.replace(/\.$/, "");
    return (
      !parsed.username &&
      !parsed.password &&
      !["t.me", "telegram.me", "telegram.dog"].some(
        (domain) => host === domain || host.endsWith(`.${domain}`),
      )
    );
  } catch {
    return false;
  }
}

function collectSourceLinks(links: SourceLink[]): SourceLink[] {
  const seen = new Set<string>();
  const sources: SourceLink[] = [];
  for (const { url, label } of links) {
    if (!isExternalSourceUrl(url)) continue;
    const parsed = new URL(url);
    if (seen.has(parsed.href)) continue;
    seen.add(parsed.href);
    const text = [...label.replace(/\s+/g, " ").trim()]
      .filter((char) => char.charCodeAt(0) >= 32 && char.charCodeAt(0) !== 127)
      .join("");
    sources.push({
      url,
      label: text && text.length <= 80 && !/^https?:\/\//i.test(text) ? text : parsed.hostname,
    });
  }
  return sources;
}

export function sourceLinksFromHtml(html: string): SourceLink[] {
  const links = [...sanitizeTelegramHtml(html).matchAll(/<a href="([^"]*)">([\s\S]*?)<\/a>/g)];
  return collectSourceLinks(
    links.map((match) => ({
      url: decodeEntityRefs(match[1] ?? ""),
      label: visibleText(match[2] ?? ""),
    })),
  );
}

function textOf(nodes: PhrasingContent[]): string {
  return nodes
    .map((node) => {
      if (node.type === "html") return "";
      if ("value" in node) return node.value;
      if ("children" in node) return textOf(node.children);
      if (node.type === "image" || node.type === "imageReference") return node.alt ?? "";
      return "";
    })
    .join("");
}

/** Only linked materials count: image URLs and unused reference definitions do not. */
export function sourceLinksFromMarkdown(markdown: string): SourceLink[] {
  const tree = unified().use(remarkParse).use(remarkGfm).parse(markdown);
  const definitions = new Map<string, string>();
  visit(tree, "definition", (node: Definition) => {
    // CommonMark resolves a reference against its first definition.
    if (!definitions.has(node.identifier)) definitions.set(node.identifier, node.url);
  });
  const links: SourceLink[] = [];
  visit(tree, (node) => {
    if (node.type !== "link" && node.type !== "linkReference") return;
    const url = node.type === "link" ? node.url : definitions.get(node.identifier);
    if (url) links.push({ url, label: textOf(node.children) });
  });
  return collectSourceLinks(links);
}
