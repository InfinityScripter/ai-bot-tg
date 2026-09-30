import { truncate } from "../utils.js";
import { ProviderName } from "../enums.js";
import { humanizeText } from "./humanize.js";
import { dressForChannel } from "./dressForChannel.js";
import { completeChatJson } from "./chatCompletion.js";
import { resolveActiveProvider } from "./providers.js";
import { CAPTION_LIMIT } from "../blog/publishToChannel.js";
import { ChannelRetellSchema } from "../schemas/channelRetellSchema.js";
import {
  hrefsOf,
  escapeHtml,
  tagNamesOf,
  visibleText,
  sanitizeTelegramHtml,
} from "../feeds/index.js";
import {
  RETELL_MAX,
  RETELL_SYSTEM_PROMPT,
  buildRetellUserContent,
  buildShortenUserContent,
} from "./retellPrompt.js";

import type { CandidateStore } from "../store/index.js";
import type { FeedItem, ChannelDress, ChannelRetell } from "../types.js";

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

/** The why line and the rubric hashtag, added by code under the retelling (the model is told to write neither). */
export function withDress(html: string, dress: ChannelDress | null): string {
  if (!dress) return html;
  const why = dress.why ? `\n\n💡 <b>Зачем тебе это:</b> ${escapeHtml(dress.why)}` : "";
  return `${html}${why}\n\n#${dress.rubric}`;
}

/** Credit line added by code, never by the model: the channel handle linked to the exact post. */
export function withSourceLine(html: string, item: Pick<FeedItem, "url" | "feedTitle">): string {
  return `${html}\n\nИсточник: <a href="${escapeHtml(item.url)}">${escapeHtml(item.feedTitle)}</a>`;
}

/**
 * Model (or humanizer) HTML reduced to what may be published: Telegram tags
 * only, links only to the source post's own targets, no credit line or
 * trailing channel signature of its own. The prompt alone is not a control
 * (OWASP LLM05).
 */
export function cleanRetellHtml(html: string, item: FeedItem): string {
  const lines = html
    .split("\n")
    .filter((line) => !visibleText(line).trimStart().startsWith("Источник:"));
  while (lines.length > 0 && visibleText(lines.at(-1) ?? "").trim() === "") lines.pop();
  // Posts end with the author's "@channel" signature; the credit line already names it.
  const signature = item.feedTitle.toLowerCase();
  if (
    visibleText(lines.at(-1) ?? "")
      .trim()
      .toLowerCase() === signature
  )
    lines.pop();
  return sanitizeTelegramHtml(lines.join("\n"), { allowedHrefs: hrefsOf(item.html ?? "") });
}

/** The same tags and the same link targets: the humanizer may reword, not re-mark. */
export function sameMarkup(a: string, b: string): boolean {
  const hrefSet = (html: string) => [...new Set(hrefsOf(html))].sort();
  return (
    tagNamesOf(a).join() === tagNamesOf(b).join() && hrefSet(a).join("\n") === hrefSet(b).join("\n")
  );
}

async function askModel(
  provider: ProviderName,
  model: string,
  user: string,
  item: FeedItem,
): Promise<string> {
  const raw = await completeChatJson(provider, model, {
    system: RETELL_SYSTEM_PROMPT,
    user,
    maxTokens: RETELL_MAX_TOKENS,
    temperature: RETELL_TEMPERATURE,
    refusalLabel: "пересказывать пост",
  });
  return cleanRetellHtml(finalizeRetell(raw).html, item);
}

/**
 * One more call for a draft over RETELL_MAX. Optional: when it fails or comes
 * back no shorter, the draft stands and the publish gate decides.
 */
async function shortened(
  provider: ProviderName,
  model: string,
  draft: string,
  item: FeedItem,
): Promise<string> {
  const { length } = visibleText(draft);
  if (length <= RETELL_MAX) return draft;
  try {
    const short = await askModel(provider, model, buildShortenUserContent(item, draft), item);
    if (short !== "" && visibleText(short).length < length) return short;
    console.warn(`[retell] shortening gave no shorter text, kept the ${length}-character draft`);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.warn(`[retell] shortening failed, kept the ${length}-character draft: ${reason}`);
  }
  return draft;
}

/**
 * Retells a channel post with the active model (asking once more to shorten a
 * draft over RETELL_MAX), then the humanizer pass on the HTML. The humanized
 * HTML is kept only while it has the model's exact tags and links and stays
 * within RETELL_MAX visible characters: the caption limit and the formatting
 * are hard, the voice pass is not. The dress (why line, rubric, cover text) is
 * made from the final text and is skipped when the model gives none.
 */
export async function retellChannelPost(
  item: FeedItem,
  store: CandidateStore,
): Promise<ChannelRetell> {
  const { provider, model } = resolveActiveProvider(store);
  const body =
    provider === ProviderName.Mock
      ? escapeHtml(truncate(item.snippet, RETELL_MAX))
      : await shortened(
          provider,
          model,
          await askModel(provider, model, buildRetellUserContent(item), item),
          item,
        );
  const humanized = cleanRetellHtml(await humanizeText(body), item);
  const keep =
    humanized !== "" && visibleText(humanized).length <= RETELL_MAX && sameMarkup(humanized, body);
  if (!keep && humanized !== body) {
    console.warn("[retell] humanizer changed the markup or went over the cap, kept the model HTML");
  }
  const text = keep ? humanized : body;
  const asked = await dressForChannel({ title: "", text: visibleText(text) }, store);
  // A draft the shortening could not cut leaves no room for the why line; the
  // rubric and the cover still fit, and the post is not sent to the owner over it.
  const overflows =
    asked?.why && visibleText(withSourceLine(withDress(text, asked), item)).length > CAPTION_LIMIT;
  if (overflows)
    console.warn(`[retell] why line left out: the caption would exceed ${CAPTION_LIMIT}`);
  const dress = asked && overflows ? { ...asked, why: "" } : asked;
  return {
    html: withSourceLine(withDress(text, dress), item),
    ...(dress ? { dress } : {}),
  };
}
