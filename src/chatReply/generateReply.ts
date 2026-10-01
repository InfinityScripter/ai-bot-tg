import { runCodex } from "./runCodex.js";
import { ProviderName } from "../enums.js";
import { resolveActiveProvider } from "../llm/providers.js";
import { ChatReplySchema } from "../schemas/chatReplySchema.js";
import { extractJson, completeChatJson } from "../llm/chatCompletion.js";

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
 * Codex first (the owner's subscription), then the bot's active rewrite
 * provider (API credits) when Codex fails — quota spent, logged out, timeout,
 * or an unusable reply. Null when both fail: the caller stays silent rather
 * than posting an error into a public chat.
 */
export async function generateReply(
  store: CandidateStore,
  system: string,
  user: string,
): Promise<ChatReply | null> {
  try {
    const reply = parseReply(await runCodex(`${system}\n\n${user}`));
    if (reply) return reply;
    console.warn("[chatReply] codex returned no valid reply, using the fallback provider");
  } catch (err) {
    console.warn(`[chatReply] codex failed, using the fallback provider: ${String(err)}`);
  }

  const { provider, model } = resolveActiveProvider(store);
  if (provider === ProviderName.Mock) return null;
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
