/**
 * Relevance eval fixtures: BORDERLINE feed items — the only ones the classifier
 * is ever asked about (obvious AI/tech and obvious off-topic are decided by
 * stage-A keyword markers before any LLM call). Each case declares the score
 * band it should land in and ships a recorded reply for zero-cost mock runs.
 *
 * Titles/snippets here deliberately avoid the stage-A marker substrings
 * (ON_TOPIC_MARKERS / OFF_TOPIC_MARKERS) so that in LIVE mode they genuinely
 * reach the classifier instead of being short-circuited.
 */

import type { FeedItem } from "../../src/types.js";
import type { RelevanceBand } from "../checks/relevanceChecks.js";

/** One relevance eval case. */
export interface RelevanceCase {
  /** Stable id — matches recorded reply `recorded/relevance/<id>.json`. */
  id: string;
  about: string;
  band: RelevanceBand;
  item: FeedItem;
}

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

export const RELEVANCE_CASES: RelevanceCase[] = [
  {
    id: "ai-regulation-politics",
    about: "Politics framing but an AI regulation angle → ON (the carve-out)",
    band: "on",
    item: feed({
      url: "https://example.com/eu-act",
      title: "Евросоюз согласовал новые правила для систем автоматического принятия решений",
      snippet:
        "Регуляторы ЕС утвердили требования к прозрачности и надзору за системами, " +
        "которые самостоятельно принимают решения на основе данных пользователей.",
      feedTitle: "PolicyWire",
    }),
  },
  {
    id: "ai-jobs-labor",
    about: "Labor-market story driven by automation → ON",
    band: "on",
    item: feed({
      url: "https://example.com/jobs-report",
      title: "Отчёт: автоматизация сократит спрос на офисные профессии к 2030 году",
      snippet:
        "Аналитики прогнозируют, что внедрение систем автоматизации изменит структуру " +
        "занятости, а часть рутинных офисных задач возьмут на себя цифровые сервисы.",
      feedTitle: "MarketReport",
    }),
  },
  {
    id: "generic-gadget-launch",
    about: "Consumer electronics with a tech angle but not AI-central → gray",
    band: "gray",
    item: feed({
      url: "https://example.com/earbuds",
      title: "Представлены беспроводные наушники с шумоподавлением нового поколения",
      snippet:
        "Производитель показал наушники с улучшенным активным шумоподавлением и более " +
        "долгим временем работы от батареи.",
      feedTitle: "GadgetDaily",
    }),
  },
  {
    id: "pure-finance",
    about: "Corporate earnings with no tech angle → off",
    band: "off",
    item: feed({
      url: "https://example.com/earnings",
      title: "Сеть кофеен отчиталась о росте квартальной выручки",
      snippet:
        "Компания сообщила об увеличении выручки за квартал на фоне открытия новых точек " +
        "и роста среднего чека.",
      feedTitle: "BizDaily",
    }),
  },
];
