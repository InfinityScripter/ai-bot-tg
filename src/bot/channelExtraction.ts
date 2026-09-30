import { truncate } from "../utils.js";
import { GateFailure } from "../llm/index.js";
import { CAPTION_LIMIT, publishToChannel } from "../blog/index.js";

import type { LoadedExtraction } from "./types.js";
import type { CandidateStore } from "../store/index.js";
import type { Candidate, ChannelRetell } from "../types.js";

/** Auto-path gate for a retelling: it must fit a photo caption and keep its credit line. */
export function assertRetellPublishable(retell: ChannelRetell): void {
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
