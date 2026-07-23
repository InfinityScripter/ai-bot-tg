import { CONFIG } from "../config.js";

import type { AutoPublishFlags } from "./types.js";

const FLAGS_TIMEOUT_MS = 10_000;

/** Fail-closed value: automation off, everything diverts to manual approval. */
const OFF: AutoPublishFlags = { releases: false, news: false };

/**
 * Reads the two auto-publish master switches from the blog admin settings so the
 * collector can decide, per candidate kind, whether to auto-publish or divert to
 * the owner's manual approval.
 *
 * FAIL-CLOSED by design: any failure — network error, timeout, non-2xx, or an
 * unreadable/unexpected body — returns { releases:false, news:false }. A blog
 * outage must never let the bot auto-publish against an intended "off"; instead
 * every item reaches the owner as a manual card, so nothing is lost. The owner is
 * not separately alerted that automation is off — the manual cards ARE the signal.
 *
 * Auth: the same Bearer BOT_API_TOKEN used for publishing, which the backend's
 * requireAuth resolves to the owner admin — so GET /api/admin/settings (admin-only)
 * is reachable and returns the full flag snapshot under the ok() envelope
 * `{ success, data: { flags: { autoPublishReleases, autoPublishNews, … } } }`.
 * Note the flags live at data.data.flags, NOT the top level.
 */
export async function fetchAutoPublishFlags(): Promise<AutoPublishFlags> {
  const url = `${CONFIG.BLOG_API_URL.replace(/\/$/, "")}/api/admin/settings`;
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(FLAGS_TIMEOUT_MS),
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${CONFIG.BOT_API_TOKEN}`,
      },
    });
    if (!res.ok) {
      console.warn(`[autopublish-flags] settings responded ${res.status}, failing closed (off)`);
      return OFF;
    }
    const data = (await res.json()) as {
      data?: { flags?: { autoPublishReleases?: unknown; autoPublishNews?: unknown } };
    };
    const flags = data.data?.flags;
    // Read strictly: only an explicit boolean true enables. Missing/undefined
    // (e.g. an older backend without these keys) stays off — fail-closed.
    return {
      releases: flags?.autoPublishReleases === true,
      news: flags?.autoPublishNews === true,
    };
  } catch (err) {
    console.warn(
      `[autopublish-flags] failed to read settings, failing closed (off): ${String(err)}`,
    );
    return OFF;
  }
}
