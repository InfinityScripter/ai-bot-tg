import { truncate } from "../utils.js";
import { ProviderName } from "../enums.js";
import { humanizeText } from "./humanize.js";
import { completeChatJson } from "./chatCompletion.js";
import { resolveActiveProvider } from "./providers.js";
import { ChannelRetellSchema } from "../schemas/channelRetellSchema.js";
import { RETELL_SYSTEM_PROMPT, buildRetellUserContent } from "./retellPrompt.js";

import type { CandidateStore } from "../store/index.js";
import type { FeedItem, ChannelRetell } from "../types.js";

/** Body cap before the source line: a photo caption holds 1024 characters in total. */
export const RETELL_MAX = 900;
const RETELL_MAX_TOKENS = 1200;
const RETELL_TEMPERATURE = 0.6;

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

/** Credit line added by code, never by the model: the channel and the exact post. */
export function withSourceLine(text: string, item: FeedItem): string {
  return `${text}\n\nИсточник: ${item.feedTitle} — ${item.url}`;
}

/** Links are allowed only via the code-built credit line; the prompt alone is not a control. */
export function stripLinks(text: string): string {
  return text
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("Источник:"))
    .join("\n")
    .replace(/(?:https?:\/\/|www\.|\bt\.me\/)\S*/gi, "")
    .replace(/[ \t]+/g, " ")
    .replace(/ ?\n ?/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Retells a channel post with the active model, then the humanizer pass. The
 * humanized text is kept only while it stays within RETELL_MAX, otherwise the
 * model's own text is used: the caption limit is hard, the voice pass is not.
 */
export async function retellChannelPost(
  item: FeedItem,
  store: CandidateStore,
): Promise<ChannelRetell> {
  const { provider, model } = resolveActiveProvider(store);
  const body =
    provider === ProviderName.Mock
      ? truncate(item.snippet, RETELL_MAX)
      : finalizeRetell(
          await completeChatJson(provider, model, {
            system: RETELL_SYSTEM_PROMPT,
            user: buildRetellUserContent(item),
            maxTokens: RETELL_MAX_TOKENS,
            temperature: RETELL_TEMPERATURE,
            refusalLabel: "пересказывать пост",
          }),
        ).text;
  const humanized = (await humanizeText(body)).trim();
  const text = humanized && humanized.length <= RETELL_MAX ? humanized : body;
  return { text: withSourceLine(stripLinks(text), item) };
}
