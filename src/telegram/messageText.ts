import type { Message, RichText, RichBlock } from "grammy/types";

/** Room for Telegram's 32,768-character article plus expanded link targets. */
export const MAX_RICH_TEXT_CHARS = 131_072;

/** Include link targets for context; mention gates request visible text alone. */
export function messageText(
  message: Message | undefined,
  includeLinkTargets = true,
): string | undefined {
  const plain = message?.text ?? message?.caption;
  if (plain !== undefined) return plain;
  if (!Array.isArray(message?.rich_message?.blocks)) return undefined;
  const parts: string[] = [];
  let size = 0;
  let visited = 0;
  const available = () => size < MAX_RICH_TEXT_CHARS && visited < 65_536;
  const append = (value: string) => {
    if (typeof value !== "string") return;
    const kept = value.slice(0, MAX_RICH_TEXT_CHARS - size);
    parts.push(kept);
    size += kept.length;
  };

  function readText(text: RichText | undefined, depth: number): void {
    if (depth > 64 || !available() || text === undefined) return;
    visited++;
    if (typeof text === "string") {
      append(text);
    } else if (Array.isArray(text)) {
      for (const child of text) {
        if (!available()) break;
        readText(child, depth + 1);
      }
    } else if (text && typeof text === "object") {
      if ("text" in text) readText(text.text, depth + 1);
      if (includeLinkTargets && text.type === "url" && text.text !== text.url)
        append(` (${text.url})`);
      if (text.type === "custom_emoji") append(text.alternative_text);
      if (text.type === "mathematical_expression") append(text.expression);
    }
  }

  function readBlocks(blocks: RichBlock[] | undefined, depth: number): void {
    if (!Array.isArray(blocks)) return;
    for (const block of blocks) {
      if (!available()) break;
      readBlock(block, depth);
    }
  }

  function readBlock(block: RichBlock, depth: number): void {
    if (depth > 64 || !available() || !block || typeof block !== "object") return;
    visited++;
    switch (block.type) {
      case "list":
        if (Array.isArray(block.items)) {
          for (const item of block.items) {
            if (!available()) break;
            if (!item) continue;
            append(`${item.label} `);
            readBlocks(item.blocks, depth + 1);
          }
        }
        break;
      case "details":
        readText(block.summary, depth + 1);
        append("\n");
        readBlocks(block.blocks, depth + 1);
        break;
      case "table":
        readText(block.caption, depth + 1);
        append("\n");
        if (Array.isArray(block.cells)) {
          for (const row of block.cells) {
            if (!available()) break;
            if (!Array.isArray(row)) continue;
            for (const cell of row) {
              if (!available()) break;
              if (cell?.text === undefined) continue;
              readText(cell.text, depth + 1);
              append(" | ");
            }
            append("\n");
          }
        }
        break;
      default:
        if ("text" in block) readText(block.text, depth + 1);
        if ("expression" in block) append(block.expression);
        if ("blocks" in block) readBlocks(block.blocks, depth + 1);
        if ("caption" in block && block.caption) {
          readText(block.caption.text, depth + 1);
          append("\n");
          readText(block.caption.credit, depth + 1);
        }
    }
    if ("credit" in block) {
      append("\n");
      readText(block.credit, depth + 1);
    }
    append("\n");
  }

  readBlocks(message.rich_message.blocks, 0);
  return parts.join("").trim() || undefined;
}
