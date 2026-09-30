import { truncate } from "../utils.js";
import { hrefsOf, visibleText } from "../feeds/index.js";
import { linkables, withDress, GateFailure, withSourceLine } from "../llm/index.js";
import { coverSpecFor, CAPTION_LIMIT, tryRenderCover, publishToChannel } from "../blog/index.js";

import type { LoadedExtraction } from "./types.js";
import type { CandidateStore } from "../store/index.js";
import type { FeedItem, Candidate, ChannelRetell } from "../types.js";

const MIN_BODY = 50;

const normalizeHref = (href: string) => href.trim().replace(/\/+$/, "");

/**
 * Auto-path gate for a retelling, on the text the reader sees: it must fit a
 * photo caption, end with the code-built credit line, and link nothing (<a>,
 * domain or @mention) that the source post didn't — except the source
 * channel's own handle.
 */
export function assertRetellPublishable(
  retell: ChannelRetell,
  source: Pick<FeedItem, "url" | "html" | "snippet" | "feedTitle">,
): void {
  const visible = visibleText(retell.html);
  if (visible.length > CAPTION_LIMIT) {
    throw new GateFailure(`пересказ длиннее ${CAPTION_LIMIT} символов (${visible.length})`);
  }
  const credit = withSourceLine("", source);
  if (!retell.html.endsWith(credit)) {
    throw new GateFailure("в пересказе нет строки «Источник» со ссылкой на пост");
  }
  // cleanRetellHtml can leave nothing of a reply that was only a link. The why
  // line and hashtag are code-built decoration and do not count as body.
  const dressed = retell.html.slice(0, -credit.length);
  const tail = withDress("", retell.dress ?? null);
  const body = visibleText(
    dressed.endsWith(tail) ? dressed.slice(0, dressed.length - tail.length) : dressed,
  ).trim();
  if (body.length < MIN_BODY) {
    throw new GateFailure(`пересказ почти пустой (${body.length} симв. до строки «Источник»)`);
  }
  const targets = new Set([source.url, ...hrefsOf(source.html ?? "")].map(normalizeHref));
  const foreignHref = hrefsOf(retell.html).find((href) => !targets.has(normalizeHref(href)));
  if (foreignHref) {
    throw new GateFailure(`в пересказе ссылка ${foreignHref}, которой нет в исходном посте`);
  }
  const allowed = new Set(linkables(`${source.snippet}\n${source.feedTitle}`));
  const foreign = linkables(visibleText(dressed)).find((token) => !allowed.has(token));
  if (foreign) {
    throw new GateFailure(`в пересказе ${foreign}, которого нет в исходном посте`);
  }
}

/**
 * A channel row's publish action: the retelling goes to the channel, not the
 * blog, under the branded cover (rendered at publish time, so a retelling
 * saved before covers existed gets one too).
 */
export function loadChannelExtraction(
  store: CandidateStore,
  candidate: Candidate,
): LoadedExtraction | null {
  const retell = store.getRetell(candidate);
  if (!retell) return null;
  const { imageUrls } = store.getFeedItem(candidate);
  const firstLine = visibleText(retell.html).split("\n")[0] ?? "";
  return {
    title: `в канале: ${truncate(firstLine, 80)}`,
    publish: () =>
      publishToChannel(
        retell.html,
        imageUrls,
        tryRenderCover(coverSpecFor(retell.dress, firstLine)),
      ),
    crossPost: null,
  };
}
