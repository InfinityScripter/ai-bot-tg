import { newsCount } from "./issueSlot.js";
import { buildArticle } from "./buildArticle.js";
import { writeDigestItem } from "../llm/index.js";
import { resolveChannels } from "../feeds/index.js";
import { buildFallbackText } from "./fallbackText.js";
import { downloadImage } from "../blog/downloadImage.js";
import { ChannelRubric, CandidateState } from "../enums.js";
import { coverSpecFor, tryRenderCover } from "../blog/index.js";
import { LINK_MEMORY_DAYS } from "../server/selectChannelPost.js";
import { pickIssueItems, linkKeysOfCandidate } from "./pickIssueItems.js";

import type { QueuedPost, CandidateStore } from "../store/index.js";
import type { IssueItem, IssueSlot, AssembledIssue } from "./types.js";

export const ISSUE_MIN_ITEMS = 3;
const QUEUE_MAX_AGE_MS = 24 * 3_600_000;
const PHOTOS_PER_ITEM = 4;

async function photosOf(urls: string[]): Promise<Blob[]> {
  const blobs = await Promise.all(urls.slice(0, PHOTOS_PER_ITEM).map(downloadImage));
  return blobs.filter((blob): blob is Blob => blob !== null);
}

/** One card per picked post, in pick order. Not-news → skipped; a failed card leaves the post queued. */
async function writeItems(store: CandidateStore, picked: QueuedPost[]): Promise<IssueItem[]> {
  const items: IssueItem[] = [];
  for (const { candidate } of picked) {
    const post = store.getFeedItem(candidate);
    try {
      const card = await writeDigestItem(post, store);
      if (!card) {
        store.setState(candidate.id, CandidateState.Skipped, "не новость (решила модель)");
        console.log(`[digest-issue] #${candidate.id} is not news, skipped`);
        continue;
      }
      items.push({
        candidateId: candidate.id,
        channel: post.feedTitle,
        ...card,
        photos: await photosOf(post.imageUrls),
        linkKeys: linkKeysOfCandidate(candidate),
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      console.warn(`[digest-issue] #${candidate.id} dropped from this issue: ${reason}`);
    }
  }
  return items;
}

/**
 * Builds one issue from the queue: posts older than 24 h age out first, up to
 * 7 are picked and written up one model call each, and the rest stay queued
 * for the next issue. Nothing is claimed or sent here (claiming is
 * publishIssue's job, right before the send), so a restart while the cards
 * are being written strands nothing. `slot` and `now` are fixed by the caller
 * for the whole run. `assembled` is null when fewer than 3 cards came out;
 * `notify` then gets one short note for the owner.
 */
export async function assembleIssue(
  store: CandidateStore,
  slot: IssueSlot,
  now: number,
  notify?: (text: string) => Promise<void>,
): Promise<{ assembled: AssembledIssue | null; picked: number; written: number }> {
  const expired = store.channelQueue.expire(now, QUEUE_MAX_AGE_MS);
  if (expired > 0) console.log(`[digest-issue] ${expired} queued posts older than 24 h skipped`);
  const picked = pickIssueItems(store.channelQueue.list(), resolveChannels(), (key) =>
    store.isSeenSince(key, LINK_MEMORY_DAYS),
  );
  const items = await writeItems(store, picked);
  const counts = { picked: picked.length, written: items.length };
  const article =
    items.length < ISSUE_MIN_ITEMS
      ? null
      : buildArticle({
          title: slot.title,
          items,
          cover: (count) =>
            tryRenderCover(
              coverSpecFor(
                {
                  rubric: ChannelRubric.Digest,
                  why: "",
                  coverTitle: slot.title,
                  coverFact: newsCount(count),
                },
                slot.title,
                new Date(now),
              ),
            ),
        });
  if (!article || article.items.length < ISSUE_MIN_ITEMS) {
    const ready = article?.items.length ?? counts.written;
    console.warn(`[digest-issue] ${slot.key}: ${ready} of ${counts.picked} cards, not enough`);
    await notify?.(
      `⚠️ Выпуск «${slot.title}» не собран: готово ${ready} из ${counts.picked}, нужно не меньше ${ISSUE_MIN_ITEMS}. Новости остались в очереди.`,
    ).catch((err) => console.warn(`[digest-issue] owner note failed: ${String(err)}`));
    return { assembled: null, ...counts };
  }
  const fallbackText = buildFallbackText(slot.title, article.items);
  return { assembled: { slot, article, fallbackText }, ...counts };
}
