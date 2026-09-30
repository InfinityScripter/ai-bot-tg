/**
 * Release-confirm eval fixtures: real feed items that hit the release markers,
 * taken from the production ledger on 2026-09-30, with the verdict the confirm
 * check (src/llm/detectRelease.ts) must give. The two DevDay roundups were
 * confirmed as releases by the first prompt and published as duplicate posts;
 * they are the regression cases. Recorded replies come from openai/gpt-6-luna.
 */

import type { FeedItem } from "../../src/types.js";

/** One release-confirm eval case. */
export interface ReleaseCase {
  /** Stable id — matches recorded reply `recorded/release/<id>.json`. */
  id: string;
  about: string;
  expected: boolean;
  item: FeedItem;
}

function feed(partial: Pick<FeedItem, "url" | "title" | "feedTitle" | "snippet">): FeedItem {
  return { dedupKey: partial.url, imageUrl: null, imageUrls: [], publishedAt: null, ...partial };
}

export const RELEASE_CASES: ReleaseCase[] = [
  {
    id: "techcrunch-gpt-6-1-sol",
    about: "A launch article about one new model \u2192 release",
    expected: true,
    item: feed({
      url: "https://techcrunch.com/2026/09/29/openai-launches-gpt-6-1-sol-says-it-nearly-matches-gpt-6-astra-and-costs-less/",
      title: "OpenAI launches GPT-6.1 Sol, says it nearly matches GPT-6 Astra and costs less",
      feedTitle: "AI News & Artificial Intelligence | TechCrunch",
      snippet:
        "OpenAI says GPT-6.1 Sol delivers significant improvements over GPT-6 Sol across complex professional tasks, including code writing and debugging, document understanding, and executing multistep business workflows.",
    }),
  },
  {
    id: "verge-devday-roundup",
    about:
      "Event roundup that includes a model launch \u2192 news (published by mistake on 2026-09-30)",
    expected: false,
    item: feed({
      url: "https://www.theverge.com/ai-artificial-intelligence/1001681/openai-devday-2026-biggest-news-announcements",
      title: "OpenAI DevDay 2026: The biggest news and announcements",
      feedTitle: "AI | The Verge",
      snippet:
        "It&#8217;s OpenAI’s turn in the fall tech events calendar. The company is hosting its annual DevDay on September 29th in San Francisco, and during a live keynote featuring CEO Sam Altman, it revealed several notable updates, including Dots , its AI agent product that rivals Meta’s recently-launched Muse. However, unlike Muse, which is available for free, Dots will initially be available to paid subscribers of ChatGPT Pro, Business Premium, and Enterprise. The company also revealed its GPT-6.1 Sol model, said that ChatGPT now has 1.2 billion users per week , and announced a new ChatGPT Pro plan",
    }),
  },
  {
    id: "habr-devday-roundup",
    about:
      "RU roundup of DevDay listing several products \u2192 news (published by mistake on 2026-09-30)",
    expected: false,
    item: feed({
      url: "https://habr.com/ru/companies/gptunnel/articles/1088404/?utm_campaign=1088404&utm_source=habrahabr&utm_medium=rss",
      title: "dots, GPT-6.1 Sol и тариф $500: всё, что OpenAI показала на DevDay 2026",
      feedTitle: "Все статьи подряд / Искусственный интеллект / Хабр",
      snippet:
        "TL;DR. 29 сентября на DevDay в Сан-Франциско OpenAI за час объявила больше двадцати новинок. Главные из них: – Доты – «всегда включённые» агенты со своим облачным компьютером, которые работают, пока вы заняты другим. – GPT-6.1 Sol – модель, которая почти догоняет флагман Astra за пятую часть его цены. – Ultrafast – платный режим скорости, до 8 раз быстрее в Codex. – Pro 500 – новый тариф за $500 в месяц. – ChatGPT Space – общее рабочее пространство для людей и агентов. При этом флагманскую GPT-6.1 Astra сняли с релиза за день до конференции. Ниже разберём, что показали, что уже доступно и где ",
    }),
  },
  {
    id: "latentspace-devday-newsletter",
    about: "Newsletter issue covering a whole event \u2192 news",
    expected: false,
    item: feed({
      url: "https://www.latent.space/p/ainews-openai-devday-2026-dots-61",
      title:
        "[AINews] OpenAI DevDay 2026: Dots, 6.1 Sol, Ultrafast, Decisions API, Agents API, Spaces, Marketplace, and 1.2 Billion ChatGPT WAU",
      feedTitle: "Latent.Space",
      snippet:
        "Today is the 20 year anniversary of Sam Altman&#8217;s first startup , and fittingly OpenAI the consumer AI company is so back (as is OpenAI the AI Cloud and OpenAI the Enterprise and Coding Definitely Not Anthropic Hyperscaler), with Dots &#8212; their voice-enabled answer to Instinct and Muse, ChatGPT Spaces &#8212; with Dots their answer to Notion and the office productivity suite, GPT 6.1 Sol (no Astra! alas) &#8212; their answer to Opus 5.5 with a new ultrafast mode running on unspecified silicon , alongside a wealth of platform updates, including the Decisions API , their rapid answer to",
    }),
  },
  {
    id: "hn-decisions-api",
    about: "A new API, not a model \u2192 news",
    expected: false,
    item: feed({
      url: "https://x.com/i/trending/2105154696566501872",
      title: "OpenAI Launches Decisions API for Fast AI Choices",
      feedTitle: 'Hacker News - Newest: ""AI" "LLM""',
      snippet:
        "Article URL: https://x.com/i/trending/2105154696566501872 Comments URL: https://news.ycombinator.com/item?id=49904454 Points: 2 # Comments: 4",
    }),
  },
  {
    id: "arxiv-openai-hf-paper",
    about: "Research paper mentioning a vendor \u2192 news",
    expected: false,
    item: feed({
      url: "https://arxiv.org/abs/2609.35799",
      title: "OpenAI-HuggingFace: A Reproduction & Lessons for Alignment Testing",
      feedTitle: "cs.AI updates on arXiv.org",
      snippet:
        "arXiv:2609.35799v1 Announce Type: new Abstract: In July 2026, OpenAI's agents coordinated over channels outside their intended environment to breach Hugging Face's secured infrastructure. Could existing alignment testing practices have foreseen this incident? If not, what needs to change? We explore these questions. First, we identify the misaligned behaviors that caused this incident. Then, we show how to elicit these behaviors from publicly available models manually and that auditing agents can do the same if given a large compute budget. Based on our results, we propose directions to improv",
    }),
  },
];
