import { escapeHtml } from "../feeds/telegramHtml.js";

/** The saved Telegram post, separate from the card's external materials. */
export function renderSourcePost(url?: string): string {
  if (!url || !/^https?:\/\/\S+$/i.test(url) || url.includes("\\")) return "";
  if ([...url].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)) return "";
  try {
    const parsed = new URL(url);
    if (
      parsed.username ||
      parsed.password ||
      parsed.port ||
      !["t.me", "telegram.me", "telegram.dog"].includes(parsed.hostname) ||
      !/^\/(?:(?:s\/)?(?!c\/|s\/)[a-z][a-z0-9_]*|c\/[1-9]\d*)\/[1-9]\d*\/?$/i.test(parsed.pathname)
    ) {
      return "";
    }
    return `<a href="${escapeHtml(url)}">Исходный пост</a>`;
  } catch {
    return "";
  }
}
