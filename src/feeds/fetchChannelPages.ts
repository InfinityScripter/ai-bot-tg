import { fetchHtml } from "./fetchHtml.js";
import { parseTelegramChannel } from "./parseTelegramChannel.js";

import type { SourceChannel } from "./defaultChannels.js";
import type { ChannelPost } from "./parseTelegramChannel.js";

/** A channel's web preview, parsed. */
export interface ChannelPage {
  channel: SourceChannel;
  posts: ChannelPost[];
}

const PAGE_MAX_BYTES = 512_000;
const PAGE_TIMEOUT_MS = 15_000;

/**
 * Fetches every channel's t.me/s page in parallel. A failed fetch, and a page
 * that parses to zero posts (markup changed), both land in `failed`: on
 * 2026-09-30 three of twelve pages failed once and answered in 0.7 s on retry,
 * so one bad channel only skips that channel for this sweep.
 */
export async function fetchChannelPages(
  channels: SourceChannel[],
): Promise<{ pages: ChannelPage[]; failed: string[] }> {
  const results = await Promise.allSettled(
    channels.map((c) => fetchHtml(`https://t.me/s/${c.name}`, PAGE_MAX_BYTES, PAGE_TIMEOUT_MS)),
  );
  const pages: ChannelPage[] = [];
  const failed: string[] = [];
  channels.forEach((channel, idx) => {
    const result = results[idx];
    const posts = result?.status === "fulfilled" ? parseTelegramChannel(result.value) : [];
    if (posts.length === 0) {
      const reason = result?.status === "rejected" ? String(result.reason) : "0 постов на странице";
      console.warn(`[channels] ${channel.name}: ${reason}`);
      failed.push(channel.name);
      return;
    }
    pages.push({ channel, posts });
  });
  return { pages, failed };
}
