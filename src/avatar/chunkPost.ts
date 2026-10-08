import type { MemoryChunk } from "./types.js";

/** Chunk size: one thought fits, and five chunks still fit a prompt comfortably. */
const CHUNK_CHARS = 1200;

/** Post HTML or markdown → plain paragraphs separated by one blank line. */
export function plainText(content: string): string {
  return content
    .replace(/<\/(p|h[1-6]|li|blockquote|pre)>|<br\s*\/?>/gi, "\n\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/[ \t]+/g, " ")
    .replace(/ ?\n ?/g, "\n")
    .replace(/\n{2,}/g, "\n\n")
    .trim();
}

/** Cuts a text longer than CHUNK_CHARS at the last space before the limit. */
function hardSplit(text: string): string[] {
  if (text.length <= CHUNK_CHARS) return [text];
  const space = text.lastIndexOf(" ", CHUNK_CHARS);
  const at = space > CHUNK_CHARS / 2 ? space : CHUNK_CHARS;
  return [text.slice(0, at).trim(), ...hardSplit(text.slice(at).trim())];
}

/** Packs whole paragraphs into chunks of at most CHUNK_CHARS characters. */
export function chunkPost(post: { title: string; url: string; content: string }): MemoryChunk[] {
  const pieces = plainText(post.content)
    .split("\n\n")
    .flatMap(hardSplit)
    .filter((p) => p.length > 0);
  const bodies: string[] = [];
  for (const piece of pieces) {
    const prev = bodies.at(-1);
    if (prev !== undefined && prev.length + 2 + piece.length <= CHUNK_CHARS) {
      bodies[bodies.length - 1] = `${prev}\n\n${piece}`;
    } else {
      bodies.push(piece);
    }
  }
  return bodies.map((body) => ({ title: post.title, url: post.url, body }));
}
