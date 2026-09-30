import { CONFIG } from "../config.js";
import { PublishError } from "./publishPost.js";

const SEND_TIMEOUT_MS = 20_000;
/** An album upload carries up to 10 photos: a timeout here means "maybe posted". */
const UPLOAD_TIMEOUT_MS = 60_000;

/** A Bot API refusal: keeps the status and description so callers can tell why. */
export class TelegramApiError extends PublishError {
  constructor(
    method: string,
    readonly status: number,
    readonly description: string,
  ) {
    super(`Telegram ${method} ответил ${status}: ${description}`, status >= 500 || status < 300);
  }
}

interface SentMessage {
  message_id?: number;
}

interface TelegramReply {
  ok?: boolean;
  description?: string;
  /** sendMediaGroup answers with every message of the album. */
  result?: SentMessage | SentMessage[];
}

/**
 * One Bot API call, JSON or multipart; returns the (first) message id. Direct
 * fetch (not grammy) on purpose: the publish paths are fetch-based like the
 * blog POST, so they need no bot handle and tests stub one global. The token
 * is in the URL, so no error below may echo the URL. Network error or 5xx →
 * the message may exist (maybePosted).
 */
export async function callTelegram(
  method: string,
  body: Record<string, unknown> | FormData,
  timeoutMs?: number,
): Promise<number> {
  const upload = body instanceof FormData;
  let res: Response;
  try {
    res = await fetch(`https://api.telegram.org/bot${CONFIG.TELEGRAM_BOT_TOKEN}/${method}`, {
      method: "POST",
      ...(upload
        ? { body }
        : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(timeoutMs ?? (upload ? UPLOAD_TIMEOUT_MS : SEND_TIMEOUT_MS)),
    });
  } catch (err) {
    const name = err instanceof Error ? err.name : "Error";
    throw new PublishError(`Telegram ${method}: сеть (${name})`, true);
  }
  const data = ((await res.json().catch(() => null)) ?? {}) as TelegramReply;
  const messageId = (Array.isArray(data.result) ? data.result[0] : data.result)?.message_id;
  if (res.ok && data.ok && typeof messageId === "number") return messageId;
  throw new TelegramApiError(method, res.status, data.description ?? "без описания");
}
