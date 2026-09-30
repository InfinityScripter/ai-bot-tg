import { truncate } from "../utils.js";
import { ProviderName } from "../enums.js";
import { humanizeText } from "./humanize.js";
import { completeChatJson } from "./chatCompletion.js";
import { resolveActiveProvider } from "./providers.js";
import { ChannelRetellSchema } from "../schemas/channelRetellSchema.js";
import { RETELL_SYSTEM_PROMPT, buildRetellUserContent } from "./retellPrompt.js";
import {
  hrefsOf,
  escapeHtml,
  tagNamesOf,
  visibleText,
  sanitizeTelegramHtml,
} from "../feeds/index.js";

import type { CandidateStore } from "../store/index.js";
import type { FeedItem, ChannelRetell } from "../types.js";

/** Visible-text cap before the source line: a photo caption holds 1024 characters in total. */
export const RETELL_MAX = 900;
export const RETELL_MAX_TOKENS = 1200;
export const RETELL_TEMPERATURE = 0.6;

/** Parses and validates a raw model reply. Throws a readable RU error. */
export function finalizeRetell(raw: string | null): ChannelRetell {
  if (!raw) throw new Error("LLM не вернул JSON в ответе.");
  let candidate: unknown;
  try {
    candidate = JSON.parse(raw);
  } catch {
    throw new Error("LLM вернул невалидный JSON.");
  }
  const parsed = ChannelRetellSchema.safeParse(candidate);
  if (!parsed.success) {
    throw new Error(
      `Ответ LLM не прошёл валидацию: ${parsed.error.issues[0]?.message ?? "unknown"}`,
    );
  }
  return parsed.data;
}

/** Credit line added by code, never by the model: the channel handle linked to the exact post. */
export function withSourceLine(html: string, item: FeedItem): string {
  return `${html}\n\nИсточник: <a href="${escapeHtml(item.url)}">${escapeHtml(item.feedTitle)}</a>`;
}

/**
 * Model (or humanizer) HTML reduced to what may be published: Telegram tags
 * only, links only to the source post's own targets, no credit line of its
 * own. The prompt alone is not a control (OWASP LLM05).
 */
export function cleanRetellHtml(html: string, item: FeedItem): string {
  const withoutCredit = html
    .split("\n")
    .filter((line) => !visibleText(line).trimStart().startsWith("Источник:"))
    .join("\n");
  return sanitizeTelegramHtml(withoutCredit, { allowedHrefs: hrefsOf(item.html ?? "") });
}

function sameMarkup(a: string, b: string): boolean {
  const hrefSet = (html: string) => [...new Set(hrefsOf(html))].sort();
  return (
    tagNamesOf(a).join() === tagNamesOf(b).join() && hrefSet(a).join("\n") === hrefSet(b).join("\n")
  );
}

/**
 * Retells a channel post with the active model, then the humanizer pass on the
 * HTML. The humanized HTML is kept only while it has the model's exact tags and
 * links and stays within RETELL_MAX visible characters: the caption limit and
 * the formatting are hard, the voice pass is not.
 */
export async function retellChannelPost(
  item: FeedItem,
  store: CandidateStore,
): Promise<ChannelRetell> {
  const { provider, model } = resolveActiveProvider(store);
  const body =
    provider === ProviderName.Mock
      ? escapeHtml(truncate(item.snippet, RETELL_MAX))
      : cleanRetellHtml(
          finalizeRetell(
            await completeChatJson(provider, model, {
              system: RETELL_SYSTEM_PROMPT,
              user: buildRetellUserContent(item),
              maxTokens: RETELL_MAX_TOKENS,
              temperature: RETELL_TEMPERATURE,
              refusalLabel: "пересказывать пост",
            }),
          ).html,
          item,
        );
  const humanized = cleanRetellHtml(await humanizeText(body), item);
  const keep =
    humanized !== "" && visibleText(humanized).length <= RETELL_MAX && sameMarkup(humanized, body);
  return { html: withSourceLine(keep ? humanized : body, item) };
}
