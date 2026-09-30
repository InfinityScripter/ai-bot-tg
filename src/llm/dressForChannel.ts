import { numbersOf } from "./numbersOf.js";
import { linkables } from "./linkables.js";
import { completeChatJson } from "./chatCompletion.js";
import { resolveActiveProvider } from "./providers.js";
import { ProviderName, ChannelRubric } from "../enums.js";
import { ChannelDressSchema } from "../schemas/channelDressSchema.js";
import { DRESS_SYSTEM_PROMPT, buildDressUserContent } from "./dressPrompt.js";

import type { CandidateStore } from "../store/index.js";
import type { ChannelDress } from "../schemas/channelDressSchema.js";

/** Keeps "💡 Зачем тебе это:" plus the line within the 1024-character photo caption next to a 720-character retelling. */
export const WHY_MAX = 180;
/** One line of the cover's fact row (JetBrains Mono, 36 px across 1120 px). */
export const FACT_MAX = 50;
/**
 * Reasoning models spend this budget on thinking first: gpt-6-luna used 270-480
 * reasoning tokens on a dress, and at 400 it stopped with finish=length and an
 * empty reply (evals, 2026-10-01). The answer itself is ~100 tokens.
 */
export const DRESS_MAX_TOKENS = 1200;
export const DRESS_TEMPERATURE = 0.3;
/**
 * The dress runs right after a retelling and between a blog publish and its
 * announcement: it may not hold either for the full LLM_TIMEOUT_MS (plus a
 * retry on the Anthropic path). The abandoned call ends on its own timeout.
 */
export const DRESS_TIMEOUT_MS = 20_000;

/** The retell gate rejects links the source didn't have; a why line with one is dropped, not the post. */
const LINK_RE = /https?:\/\/|www\.|@[A-Za-z0-9_]{4,}/i;

/** The field's value, or "" (logged) when the reason to drop it holds. */
function dropped(field: string, value: string, drop: boolean): string {
  if (!drop) return value;
  console.warn(`[dress] dropped ${field}: too long or with a link (${value.length} chars)`);
  return "";
}

/** Parses and validates a raw model reply. Throws a readable RU error. */
export function finalizeDress(raw: string | null): ChannelDress {
  if (!raw) throw new Error("LLM не вернул JSON в ответе.");
  let candidate: unknown;
  try {
    candidate = JSON.parse(raw);
  } catch {
    throw new Error("LLM вернул невалидный JSON.");
  }
  const parsed = ChannelDressSchema.safeParse(candidate);
  if (!parsed.success) {
    throw new Error(
      `Ответ LLM не прошёл валидацию: ${parsed.error.issues[0]?.message ?? "unknown"}`,
    );
  }
  const dress = parsed.data;
  if (dress.rubric === ChannelRubric.Digest) {
    throw new Error("LLM выбрал рубрику «дайджест», её ставит только код.");
  }
  return {
    ...dress,
    why: dropped("why", dress.why, dress.why.length > WHY_MAX || LINK_RE.test(dress.why)),
    coverFact: dropped("coverFact", dress.coverFact, dress.coverFact.length > FACT_MAX),
  };
}

/**
 * The dress with every field that invents something taken out: a number absent
 * from the post (an invented figure on the cover reads as the channel's claim)
 * or, in the why line, a domain or @handle Telegram would link and the post
 * never had (the retell gate would stop the whole post over it). The why line
 * and the fact are optional and go alone; the cover title is not, so an
 * invented number there drops the whole dress.
 */
export function dropInventions(dress: ChannelDress, source: string): ChannelDress | null {
  const numbers = new Set(numbersOf(source));
  const links = new Set(linkables(source));
  const inventsNumber = (text: string) => numbersOf(text).some((n) => !numbers.has(n));
  const inventsLink = (text: string) => linkables(text).some((token) => !links.has(token));
  if (inventsNumber(dress.coverTitle)) return null;
  return {
    ...dress,
    why: inventsNumber(dress.why) || inventsLink(dress.why) ? "" : dress.why,
    coverFact: inventsNumber(dress.coverFact) ? "" : dress.coverFact,
  };
}

/**
 * Rubric, "why it matters" line and cover text for a channel post, by the
 * active model. Decoration only: mock mode, a model error or an invalid reply
 * give null (logged), and the post goes out plain rather than not at all.
 */
export async function dressForChannel(
  post: { title: string; text: string },
  store: CandidateStore,
): Promise<ChannelDress | null> {
  try {
    const { provider, model } = resolveActiveProvider(store);
    if (provider === ProviderName.Mock) return null;
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`timed out after ${DRESS_TIMEOUT_MS} ms`)),
        DRESS_TIMEOUT_MS,
      );
    });
    const call = completeChatJson(provider, model, {
      system: DRESS_SYSTEM_PROMPT,
      user: buildDressUserContent(post),
      maxTokens: DRESS_MAX_TOKENS,
      temperature: DRESS_TEMPERATURE,
      refusalLabel: "оформлять пост",
    });
    const raw = await Promise.race([call, timeout]).finally(() => clearTimeout(timer));
    const asked = finalizeDress(raw);
    const dress = dropInventions(asked, `${post.title}\n${post.text}`);
    if (JSON.stringify(dress) !== JSON.stringify(asked)) {
      console.warn(
        "[dress] dropped a field with a number, domain or handle the post does not have",
      );
    }
    return dress;
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.warn(`[dress] no rubric or why line, the post goes out plain: ${reason}`);
    return null;
  }
}
