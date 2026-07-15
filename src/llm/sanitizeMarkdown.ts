import type { Node, Parent } from "unist";
import type {
  Root,
  Link,
  Image,
  Definition,
  LinkReference,
  ImageReference,
  PhrasingContent,
} from "mdast";

import { unified } from "unified";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { visit } from "unist-util-visit";
import remarkStringify from "remark-stringify";

import { normalizeHttpUrl } from "./safeUrl.js";

interface MarkdownAllowList {
  links: string[];
  images: string[];
}

/** Extracts normalized http(s) targets using the same GFM parser as sanitization. */
export function extractHttpUrls(content: string): string[] {
  const tree = unified().use(remarkParse).use(remarkGfm).parse(content);
  const urls = new Set<string>();
  const collect = (value: string) => {
    const normalized = normalizeHttpUrl(value);
    if (normalized) urls.add(normalized);
  };
  visit(tree, "link", (node: Link) => collect(node.url));
  visit(tree, "image", (node: Image) => collect(node.url));
  visit(tree, "definition", (node: Definition) => collect(node.url));
  return [...urls];
}

function normalizedSet(values: string[]): Set<string> {
  return new Set(values.map(normalizeHttpUrl).filter((url): url is string => url !== null));
}

function textOf(nodes: PhrasingContent[]): string {
  return nodes
    .map((node) => {
      if ("value" in node && typeof node.value === "string") return node.value;
      if ("children" in node) return textOf(node.children as PhrasingContent[]);
      if (node.type === "image") return node.alt ?? "";
      return "";
    })
    .join("");
}

function plainLinkLabel(nodes: PhrasingContent[]): PhrasingContent[] {
  const label = textOf(nodes);
  // A URL left as text is auto-linked again by remark-gfm on render. Drop it;
  // ordinary link labels remain readable as plain text.
  return normalizeHttpUrl(label) || /\S+@\S+\.\S+/.test(label)
    ? []
    : [{ type: "text", value: label }];
}

function replaceNode(parent: Parent, index: number, replacements: Node[]): void {
  parent.children.splice(index, 1, ...replacements);
}

/**
 * Parses model-produced Markdown and allows only source-owned http(s) links and
 * images. Raw HTML is removed. Reference links, GFM autolinks and bare URLs are
 * handled as AST nodes, so they cannot bypass an inline-link regular expression.
 */
export function sanitizeMarkdown(content: string, allow: MarkdownAllowList): string {
  const processor = unified().use(remarkParse).use(remarkGfm).use(remarkStringify, {
    bullet: "-",
    fences: true,
  });
  const tree = processor.parse(content) as Root;
  const allowedLinks = normalizedSet(allow.links);
  const allowedImages = normalizedSet(allow.images);
  const definitions = new Map<string, string | null>();

  visit(tree, "definition", (node: Definition) => {
    definitions.set(node.identifier, normalizeHttpUrl(node.url));
  });

  visit(
    tree,
    "html",
    (_node, index, parent) => {
      if (index === undefined || parent === undefined) return;
      replaceNode(parent, index, []);
    },
    true,
  );

  visit(
    tree,
    "link",
    (node: Link, index, parent) => {
      if (index === undefined || parent === undefined) return;
      const link = node as Link;
      const normalized = normalizeHttpUrl(link.url);
      if (!normalized || !allowedLinks.has(normalized)) {
        replaceNode(parent, index, plainLinkLabel(link.children));
      } else {
        link.url = normalized;
      }
    },
    true,
  );

  visit(
    tree,
    "linkReference",
    (node: LinkReference, index, parent) => {
      if (index === undefined || parent === undefined) return;
      const link = node as LinkReference;
      const target = definitions.get(link.identifier) ?? null;
      if (!target || !allowedLinks.has(target)) {
        replaceNode(parent, index, plainLinkLabel(link.children));
      }
    },
    true,
  );

  visit(
    tree,
    "image",
    (node: Image, index, parent) => {
      if (index === undefined || parent === undefined) return;
      const image = node as Image;
      const normalized = normalizeHttpUrl(image.url);
      if (!normalized || !allowedImages.has(normalized)) {
        replaceNode(parent, index, []);
      } else {
        image.url = normalized;
      }
    },
    true,
  );

  visit(
    tree,
    "imageReference",
    (node: ImageReference, index, parent) => {
      if (index === undefined || parent === undefined) return;
      const image = node as ImageReference;
      const target = definitions.get(image.identifier) ?? null;
      if (!target || !allowedImages.has(target)) replaceNode(parent, index, []);
    },
    true,
  );

  visit(
    tree,
    "definition",
    (node: Definition, index, parent) => {
      if (index === undefined || parent === undefined) return;
      const definition = node as Definition;
      const target = definitions.get(definition.identifier) ?? null;
      if (!target || (!allowedLinks.has(target) && !allowedImages.has(target))) {
        replaceNode(parent, index, []);
      } else {
        definition.url = target;
      }
    },
    true,
  );

  return processor
    .stringify(tree)
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
