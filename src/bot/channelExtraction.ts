import { truncate } from "../utils.js";
import { hrefsOf, visibleText } from "../feeds/index.js";
import { GateFailure, withSourceLine } from "../llm/index.js";
import { CAPTION_LIMIT, publishToChannel } from "../blog/index.js";

import type { LoadedExtraction } from "./types.js";
import type { CandidateStore } from "../store/index.js";
import type { FeedItem, Candidate, ChannelRetell } from "../types.js";

/** Telegram auto-links bare domains and @mentions in the visible text; cleanRetellHtml can't catch them. */
const DOMAIN_RE = /\b[\w-]+(\.[\w-]+)*\.[a-z]{2,}\b/gi;
const HANDLE_RE = /@[A-Za-z0-9_]{4,}/g;
const MIN_BODY = 50;

function linkables(text: string): string[] {
  return [...text.matchAll(DOMAIN_RE), ...text.matchAll(HANDLE_RE)].map((m) => m[0].toLowerCase());
}

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
  // cleanRetellHtml can leave nothing of a reply that was only a link.
  const body = visibleText(retell.html.slice(0, -credit.length)).trim();
  if (body.length < MIN_BODY) {
    throw new GateFailure(`пересказ почти пустой (${body.length} симв. до строки «Источник»)`);
  }
  const targets = new Set([source.url, ...hrefsOf(source.html ?? "")].map(normalizeHref));
  const foreignHref = hrefsOf(retell.html).find((href) => !targets.has(normalizeHref(href)));
  if (foreignHref) {
    throw new GateFailure(`в пересказе ссылка ${foreignHref}, которой нет в исходном посте`);
  }
  const allowed = new Set(linkables(`${source.snippet}\n${source.feedTitle}`));
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
  const { imageUrls } = store.getFeedItem(candidate);
  return {
    title: `в канале: ${truncate(visibleText(retell.html).split("\n")[0] ?? "", 80)}`,
    publish: () => publishToChannel(retell.html, imageUrls),
    crossPost: null,
  };
}
