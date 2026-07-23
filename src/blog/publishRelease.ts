import { CONFIG } from "../config.js";
import { PublishError, PUBLISH_TIMEOUT_MS } from "./publishPost.js";

import type { ReleaseResult, CreateReleasePayload } from "../types.js";

/**
 * Builds the /api/changelog/new body from an extracted release (the frozen §3
 * CreateReleasePayload). The five required fields are always present; the
 * optional numeric/date fields carry the extracted value THROUGH verbatim,
 * including null — a null price/context must stay null so the backend records
 * "unknown", never a fabricated 0. `verdict` is intentionally omitted: the bot
 * publishes a draft with no owner verdict (null on the backend).
 */
export function toReleaseBody(release: ReleaseResult): CreateReleasePayload {
  return {
    vendor: release.vendor,
    model: release.model,
    version: release.version,
    releasedAt: release.releasedAt,
    sourceUrl: release.sourceUrl,
    contextTokens: release.contextTokens,
    priceIn: release.priceIn,
    priceOut: release.priceOut,
    changes: release.changes,
    sourceName: release.sourceName,
  };
}

/**
 * Publishes an extracted release to the blog changelog via the service-token
 * path. Returns the new release id on success; throws PublishError otherwise so
 * the caller can surface it in the Telegram DM and mark publish_failed.
 *
 * CONTRACT (frozen §3): POST /api/changelog/new → 201 with an ok() envelope
 * `{ success: true, data: { release } }`, so the id is read from
 * data.data.release.id (NOT data.post.id). A 5xx / unreadable-201 is maybe-posted
 * (PublishError.maybePosted=true) so the caller never silently re-publishes.
 *
 * `idempotencyKey` (the candidate's stable dedup key) rides an `Idempotency-Key`
 * header so a future backend can dedupe a retried POST.
 */
export async function publishRelease(
  release: ReleaseResult,
  idempotencyKey?: string,
): Promise<string> {
  const url = `${CONFIG.BLOG_API_URL.replace(/\/$/, "")}/api/changelog/new`;
  const signal = AbortSignal.timeout(PUBLISH_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      signal,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${CONFIG.BOT_API_TOKEN}`,
        ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
      },
      body: JSON.stringify(toReleaseBody(release)),
    });
  } catch (err) {
    // Any transport rejection may happen after the server accepted the body.
    throw new PublishError(`Не удалось связаться с блогом: ${String(err)}`, true);
  }

  if (response.status !== 201) {
    const text = await response.text().catch(() => "");
    // A 4xx is a clear client rejection (didn't post); a 5xx may have committed
    // the release before failing — treat as maybe-posted.
    const maybePosted = response.status >= 500;
    throw new PublishError(`Блог ответил ${response.status}: ${text.slice(0, 200)}`, maybePosted);
  }

  // 201 received: the release WAS created. Read the id from the ok() envelope
  // (data.data.release.id). If unreadable, it's live without an id — maybe-posted.
  let data: { data?: { release?: { id?: string } } };
  try {
    data = (await response.json()) as { data?: { release?: { id?: string } } };
  } catch {
    throw new PublishError("Блог вернул 201, но тело ответа нечитаемо.", true);
  }
  const releaseId = data.data?.release?.id;
  if (!releaseId) {
    throw new PublishError("Блог вернул 201 без id релиза.", true);
  }
  return releaseId;
}
