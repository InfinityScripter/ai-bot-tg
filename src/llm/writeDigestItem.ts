import { truncate } from "../utils.js";
import { numbersOf } from "./numbersOf.js";
import { linkables } from "./linkables.js";
import { humanizeText } from "./humanize.js";
import { completeChatJson } from "./chatCompletion.js";
import { resolveActiveProvider } from "./providers.js";
import { ProviderName, ChannelRubric } from "../enums.js";
import { buildRetellUserContent } from "./retellPrompt.js";
import { escapeHtml, visibleText } from "../feeds/index.js";
import { sameMarkup, cleanRetellHtml } from "./retellChannelPost.js";
import { DigestItemReplySchema } from "../schemas/digestItemSchema.js";
import {
  DIGEST_ITEM_MAX,
  DIGEST_TITLE_MAX,
  DIGEST_ITEM_SYSTEM_PROMPT,
  buildDigestItemShortenContent,
} from "./digestItemPrompt.js";

import type { FeedItem, DigestItem } from "../types.js";
import type { CandidateStore } from "../store/index.js";

/**
 * Reasoning models think before they answer: at "low" effort gpt-6-luna spent
 * 56-343 reasoning tokens on a retelling (2026-10-01); the card itself is ~300.
 */
export const DIGEST_ITEM_MAX_TOKENS = 1200;
export const DIGEST_ITEM_TEMPERATURE = 0.5;
const FALLBACK_EMOJI = "📌";
const MOCK_TEXT = 300;

function isOneEmoji(value: string): boolean {
  const graphemes = [...new Intl.Segmenter("ru", { granularity: "grapheme" }).segment(value)];
  return graphemes.length === 1 && /\p{Extended_Pictographic}/u.test(value);
}

/** Parses a raw reply: null when the model says the post is not news. Throws a readable RU error. */
export function finalizeDigestItem(raw: string | null): DigestItem | null {
  if (!raw) throw new Error("LLM не вернул JSON в ответе.");
  let candidate: unknown;
  try {
    candidate = JSON.parse(raw);
  } catch {
    throw new Error("LLM вернул невалидный JSON.");
  }
  const parsed = DigestItemReplySchema.safeParse(candidate);
  if (!parsed.success) {
    throw new Error(
      `Ответ LLM не прошёл валидацию: ${parsed.error.issues[0]?.message ?? "unknown"}`,
    );
  }
  if (parsed.data.skip) return null;
  const { emoji, rubric, title, html } = parsed.data;
  if (rubric === ChannelRubric.Digest) {
    throw new Error("LLM выбрал рубрику «дайджест», её ставит только код.");
  }
  return {
    emoji: isOneEmoji(emoji) ? emoji : FALLBACK_EMOJI,
    rubric,
    title: truncate(title, DIGEST_TITLE_MAX),
    html,
  };
}

/** The card text as the article carries it: inline Telegram tags, source links only, one paragraph. */
export function inlineItemHtml(html: string, item: FeedItem): string {
  return cleanRetellHtml(html, item)
    .replace(/<\/?(?:pre|blockquote)>/g, "")
    .replace(/\s*\n+\s*/g, " ")
    .trim();
}

/** Why a card may not go out, or null: empty, too long, or a number, domain or @handle the post lacks. */
export function itemProblem(card: DigestItem, item: FeedItem): string | null {
  const body = visibleText(card.html).trim();
  if (body === "") return "пустой текст";
  if (body.length > DIGEST_ITEM_MAX) {
    return `текст длиннее ${DIGEST_ITEM_MAX} символов (${body.length})`;
  }
  const shown = `${card.title}\n${body}`;
  const numbers = new Set(numbersOf(item.snippet));
  const novel = numbersOf(shown).find((n) => !numbers.has(n));
  if (novel) return `число ${novel}, которого нет в посте`;
  const allowed = new Set(linkables(`${item.snippet}\n${item.feedTitle}`));
  const foreign = linkables(shown).find((token) => !allowed.has(token));
  return foreign ? `${foreign}, которого нет в посте` : null;
}

async function ask(
  provider: ProviderName,
  model: string,
  user: string,
  item: FeedItem,
): Promise<DigestItem | null> {
  const raw = await completeChatJson(provider, model, {
    system: DIGEST_ITEM_SYSTEM_PROMPT,
    user,
    maxTokens: DIGEST_ITEM_MAX_TOKENS,
    temperature: DIGEST_ITEM_TEMPERATURE,
    refusalLabel: "писать карточку дайджеста",
  });
  const card = finalizeDigestItem(raw);
  return card && { ...card, html: inlineItemHtml(card.html, item) };
}

/** One shorten call for a card over the cap; a failed or no shorter answer keeps the draft. */
async function shortened(
  provider: ProviderName,
  model: string,
  draft: DigestItem,
  item: FeedItem,
): Promise<DigestItem> {
  const { length } = visibleText(draft.html);
  if (length <= DIGEST_ITEM_MAX) return draft;
  try {
    const short = await ask(provider, model, buildDigestItemShortenContent(item, draft), item);
    if (short && short.html !== "" && visibleText(short.html).length < length) {
      return { ...draft, html: short.html };
    }
    console.warn(`[digest-item] shortening gave no shorter text, kept ${length} characters`);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.warn(`[digest-item] shortening failed, kept ${length} characters: ${reason}`);
  }
  return draft;
}

function mockCard(item: FeedItem): DigestItem {
  return {
    emoji: FALLBACK_EMOJI,
    rubric: ChannelRubric.Opinion,
    title: truncate(item.title, DIGEST_TITLE_MAX),
    html: escapeHtml(truncate(item.snippet.replace(/\s+/g, " "), MOCK_TEXT)),
  };
}

/**
 * One digest card for a queued channel post, by the active model. Null when
 * the model says the post is not news (contest, ad, course sale, personal
 * story). Throws when the card breaks a check even after one shorten call:
 * the issue drops that post and goes on. The humanizer's HTML is kept only
 * with the model's exact tags and links, within the cap, and with no number,
 * domain or handle the post lacks.
 */
export async function writeDigestItem(
  item: FeedItem,
  store: CandidateStore,
): Promise<DigestItem | null> {
  const { provider, model } = resolveActiveProvider(store);
  if (provider === ProviderName.Mock) return mockCard(item);
  const first = await ask(provider, model, buildRetellUserContent(item), item);
  if (!first) return null;
  const card = await shortened(provider, model, first, item);
  const problem = itemProblem(card, item);
  if (problem) throw new Error(problem);
  const humanized = { ...card, html: inlineItemHtml(await humanizeText(card.html), item) };
  const keep =
    humanized.html !== "" &&
    sameMarkup(humanized.html, card.html) &&
    itemProblem(humanized, item) === null;
  if (!keep && humanized.html !== card.html) {
    console.warn(
      "[digest-item] humanizer changed the markup, length or facts, kept the model HTML",
    );
  }
  return keep ? humanized : card;
}
