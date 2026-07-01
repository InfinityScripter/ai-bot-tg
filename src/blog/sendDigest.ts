import { CONFIG } from "../config.js";
import { PublishError } from "./publishPost.js";

// Re-exported so callers can import PublishError from the same module as
// sendDigest (mirrors publishRelease.ts re-exporting it alongside publishRelease).
export { PublishError } from "./publishPost.js";

/** The digest-send result read from the backend's ok() envelope. */
export interface DigestSendResult {
  sent: number;
  failed: number;
}

/**
 * Sends the weekly digest to every confirmed subscriber via the service-token
 * path. Returns the fan-out counts on success; throws PublishError otherwise so
 * the /digest flow can surface it in the owner DM.
 *
 * CONTRACT (frozen §1/§4.3): POST /api/newsletter/send with Bearer BOT_API_TOKEN
 * and body `{ subject, html }` → 200 with an ok() envelope
 * `{ success: true, data: { sent, failed } }`, so counts are read from
 * data.data.sent / data.data.failed (the same nesting publishRelease reads at
 * data.data.release.id). A 5xx / unreadable-200 is maybe-posted
 * (PublishError.maybePosted=true) — the backend may have sent some emails before
 * failing, so the owner should verify before re-sending.
 *
 * `idempotencyKey` rides an `Idempotency-Key` header so a future backend can
 * dedupe a retried send. Harmless if the backend ignores it today.
 */
export async function sendDigest(
  subject: string,
  html: string,
  idempotencyKey?: string,
): Promise<DigestSendResult> {
  const url = `${CONFIG.BLOG_API_URL.replace(/\/$/, "")}/api/newsletter/send`;
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${CONFIG.BOT_API_TOKEN}`,
        ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
      },
      body: JSON.stringify({ subject, html }),
    });
  } catch (err) {
    // Could not even send the request → no digest emails went out.
    throw new PublishError(`Не удалось связаться с блогом: ${String(err)}`, false);
  }

  if (response.status !== 200) {
    const text = await response.text().catch(() => "");
    // A 4xx is a clear client rejection (nothing sent); a 5xx may have sent some
    // emails before failing — treat as maybe-posted.
    const maybePosted = response.status >= 500;
    throw new PublishError(`Блог ответил ${response.status}: ${text.slice(0, 200)}`, maybePosted);
  }

  // 200 received: the send ran. Read the counts from the ok() envelope
  // (data.data.sent/failed). If unreadable, emails went out but the count is
  // unknown — maybe-posted, never silently re-send.
  let data: { data?: { sent?: number; failed?: number } };
  try {
    data = (await response.json()) as { data?: { sent?: number; failed?: number } };
  } catch {
    throw new PublishError("Блог вернул 200, но тело ответа нечитаемо.", true);
  }
  return { sent: data.data?.sent ?? 0, failed: data.data?.failed ?? 0 };
}
