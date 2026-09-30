import { truncate } from "../utils.js";
import { GateFailure } from "../llm/index.js";
import { CAPTION_LIMIT, publishToChannel } from "../blog/index.js";

import type { LoadedExtraction } from "./types.js";
import type { CandidateStore } from "../store/index.js";
import type { Candidate, ChannelRetell } from "../types.js";

/** Telegram auto-links bare domains and @mentions in plain text, so stripLinks can't catch them. */
const DOMAIN_RE = /\b[\w-]+(\.[\w-]+)*\.[a-z]{2,}\b/gi;
const HANDLE_RE = /@[A-Za-z0-9_]{4,}/g;

function linkables(text: string): string[] {
  return [...text.matchAll(DOMAIN_RE), ...text.matchAll(HANDLE_RE)].map((m) => m[0].toLowerCase());
}

/**
 * Auto-path gate for a retelling: it must fit a photo caption, keep its credit
 * line, and link nothing (domain or @mention) that the source post didn't.
 */
export function assertRetellPublishable(retell: ChannelRetell, sourceText: string): void {
  if (retell.text.length > CAPTION_LIMIT) {
    throw new GateFailure(`пересказ длиннее ${CAPTION_LIMIT} символов (${retell.text.length})`);
  }
  if (!retell.text.includes("\nИсточник: ")) {
    throw new GateFailure("в пересказе нет строки «Источник»");
  }
  // stripLinks can leave nothing of a reply that was only a link.
  const body = (retell.text.split("\n\nИсточник: ")[0] ?? "").trim();
  if (body.length < 50) {
    throw new GateFailure(`пересказ почти пустой (${body.length} симв. до строки «Источник»)`);
  }
  const allowed = new Set(linkables(sourceText));
  const foreign = linkables(body).find((token) => !allowed.has(token));
  if (foreign) {
    throw new GateFailure(`в пересказе ${foreign}, которого нет в исходном посте`);
  }
}

/** A channel row's publish action: the retelling goes to the channel, not the blog. */
export function loadChannelExtraction(
  store: CandidateStore,
  candidate: Candidate,
): LoadedExtraction | null {
  const retell = store.getRetell(candidate);
  if (!retell) return null;
  const image = store.getFeedItem(candidate).imageUrls[0] ?? null;
  return {
    title: `в канале: ${truncate(retell.text.split("\n")[0] ?? "", 80)}`,
    publish: () => publishToChannel(retell.text, image),
    crossPost: null,
  };
}
