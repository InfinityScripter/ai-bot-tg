/**
 * Rewrite eval fixtures: realistic FeedItem inputs the "generate a post" prompt
 * must handle — RU and EN sources, with and without body images, thin and rich
 * snippets. Each case ships a recorded raw model reply (a frozen realistic
 * output) so mock mode can push it through the production finalizeRewrite and
 * run the deterministic contract checks with zero credits. Live mode ignores the
 * recording and calls the real model instead.
 */

import type { FeedItem } from "../../src/types.js";

/** One rewrite eval case. */
export interface RewriteCase {
  /** Stable id — matches the recorded reply filename `recorded/<id>.json`. */
  id: string;
  /** Short human description of what the case probes. */
  about: string;
  /** The feed item fed to buildRewriteUserContent. */
  item: FeedItem;
}

/** Base FeedItem with sane defaults; override per case. */
function feed(partial: Partial<FeedItem> & Pick<FeedItem, "url" | "title">): FeedItem {
  return {
    dedupKey: partial.url,
    snippet: "",
    feedTitle: "Source",
    imageUrl: null,
    imageUrls: [],
    publishedAt: null,
    ...partial,
  };
}

export const REWRITE_CASES: RewriteCase[] = [
  {
    id: "ru-rich-images",
    about: "RU source, rich snippet, two body images available",
    item: feed({
      url: "https://habr.com/ru/articles/900001/",
      title: "Вышла новая версия PyTorch с ускоренным инференсом на GPU",
      snippet:
        "Команда PyTorch представила релиз с переработанным бэкендом компиляции. " +
        "Обещают ускорение инференса на потребительских GPU и меньшее потребление памяти.",
      feedTitle: "Хабр",
      imageUrl: "https://cdn.example/cover-pytorch.jpg",
      imageUrls: [
        "https://cdn.example/cover-pytorch.jpg",
        "https://cdn.example/bench-1.png",
        "https://cdn.example/bench-2.png",
      ],
    }),
  },
  {
    id: "en-source-translate",
    about: "English source — output must still be Russian, proper nouns kept",
    item: feed({
      url: "https://techcrunch.com/2026/07/01/anthropic-claude-update/",
      title: "Anthropic ships a faster Claude with a larger context window",
      snippet:
        "Anthropic announced an update to its Claude model family, citing lower latency " +
        "and a bigger context window for enterprise workloads.",
      feedTitle: "TechCrunch",
      imageUrl: null,
      imageUrls: [],
    }),
  },
  {
    id: "thin-snippet",
    about: "Title-only feed item (empty snippet) — must stay short, no invented facts",
    item: feed({
      url: "https://example.com/news/chip-startup",
      title: "Стартап представил ИИ-ускоритель для дата-центров",
      snippet: "",
      feedTitle: "TechNews",
      imageUrl: null,
      imageUrls: [],
    }),
  },
  {
    id: "no-images",
    about: "RU source with a snippet but no images — no image lines allowed",
    item: feed({
      url: "https://www.opennet.ru/opennews/art.shtml?num=99999",
      title: "Релиз ядра Linux 6.20: что нового",
      snippet:
        "Опубликован релиз ядра Linux 6.20. Среди изменений — улучшения планировщика, " +
        "новые драйверы и оптимизации сетевого стека.",
      feedTitle: "OpenNET",
      imageUrl: null,
      imageUrls: [],
    }),
  },
];
