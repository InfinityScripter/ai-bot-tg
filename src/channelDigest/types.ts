import type { ChannelRubric } from "../enums.js";

/**
 * Shared types of the channel digest: the issue slot, one written card, the
 * rich article and the assembled issue. Pure declarations only.
 */

/** One issue per slot: key "2026-10-01/morning", title «AI за утро · 1 октября». */
export interface IssueSlot {
  key: string;
  title: string;
}

/** One queued post written up as a card of the article. */
export interface IssueItem {
  candidateId: number;
  /** "@channel", as the cite line shows it. */
  channel: string;
  emoji: string;
  rubric: ChannelRubric;
  title: string;
  /** Telegram inline HTML (b i u s a code), links only from the source post. */
  html: string;
  /** The post's downloaded photos, at most 4. */
  photos: Blob[];
  /** `link:` seen-keys of the post's outbound links, remembered once it is published. */
  linkKeys: string[];
}

export interface ArticlePhoto {
  /** Media id inside the rich message: "cover", "p0", "p1", … */
  id: string;
  blob: Blob;
}

/** The rich message: its HTML, the files it references, and the cards that made it in. */
export interface Article {
  html: string;
  photos: ArticlePhoto[];
  items: IssueItem[];
}

export interface AssembledIssue {
  slot: IssueSlot;
  article: Article;
  /** The same cards as one sendMessage text, for a rejected rich message. */
  fallbackText: string;
}

/** How one issue attempt ended, for the owner and /health. */
export interface IssueOutcome {
  ok: boolean;
  outcome: string;
}

export interface IssueStatus extends IssueOutcome {
  at: number;
  slot: string;
}
