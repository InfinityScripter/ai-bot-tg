import { ProviderName } from "../enums.js";
import { runCodex } from "../llm/runCodex.js";
import { resolveActiveProvider } from "../llm/providers.js";
import { extractJson, completeChatJson } from "../llm/chatCompletion.js";
import { ChatReplySchema, CHAT_REPLY_JSON_SCHEMA } from "../schemas/chatReplySchema.js";

import type { CandidateStore } from "../store/index.js";
import type { ChatReply } from "../schemas/chatReplySchema.js";

/** Parses a model reply into the contract; null when it is not valid JSON of that shape. */
function parseReply(text: string | null): ChatReply | null {
  const json = text === null ? null : extractJson(text);
  if (json === null) return null;
  try {
    const parsed = ChatReplySchema.safeParse(JSON.parse(json));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/**
 * One Codex turn on the owner's subscription. Null when Codex fails (quota
 * spent, logged out, timeout) or its reply breaks the contract. Debates use
 * only this: they never spend API credits.
 */
export async function codexReply(system: string, user: string): Promise<ChatReply | null> {
  try {
    const reply = parseReply(
      await runCodex(`${system}\n\n${user}`, { schema: CHAT_REPLY_JSON_SCHEMA }),
    );
    if (!reply) console.warn("[chatReply] codex returned no valid reply");
    return reply;
  } catch (err) {
    console.warn(`[chatReply] codex failed: ${String(err)}`);
    return null;
  }
}

/**
 * Codex first, then the bot's active rewrite provider (API credits) when
 * Codex gives nothing, as long as `takePaidSlot` grants one. Null when both
 * fail: the caller stays silent rather than posting an error into a public chat.
 */
export async function generateReply(
  store: CandidateStore,
  system: string,
  user: string,
  takePaidSlot: () => boolean,
): Promise<ChatReply | null> {
  const reply = await codexReply(system, user);
  if (reply) return reply;

  const { provider, model } = resolveActiveProvider(store);
  if (provider === ProviderName.Mock) return null;
  if (!takePaidSlot()) {
    console.warn("[chatReply] paid fallback skipped: CHAT_REPLY_FALLBACK_PER_HOUR cap reached");
    return null;
  }
  try {
    const text = await completeChatJson(provider, model, {
      system,
      user,
      maxTokens: 1200,
      refusalLabel: "отвечать в чате",
    });
    return parseReply(text);
  } catch (err) {
    console.error(`[chatReply] fallback ${provider}/${model} failed: ${String(err)}`);
    return null;
  }
}
