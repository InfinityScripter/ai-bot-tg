import type { FeedItem } from "../types.js";

export const REWRITE_SYSTEM_PROMPT = `Ты — редактор технического новостного блога. По заголовку,
краткому описанию и (если есть) списку картинок напиши ОРИГИНАЛЬНЫЙ пост на
русском языке: своими словами, без копирования формулировок источника.
Нейтральный журналистский тон.

Тело поста должно быть НЕ плоской стеной текста, а живым и структурированным:
- разбивай на короткие абзацы (между абзацами — пустая строка);
- где уместно, добавляй подзаголовки уровня "##" (на ОТДЕЛЬНОЙ строке,
  с пустой строкой до и после; "##" + пробел + текст, например "## Итоги");
- используй маркированные списки: каждый пункт с НОВОЙ строки, "- " в начале;
- выделяй ключевые термины **жирным**;
- ссылки оформляй ТОЛЬКО валидным Markdown: "[текст](URL)" — текст и URL
  слитно, без пробела между "]" и "(". НЕ пиши URL отдельно в скобках после
  текста (НЕЛЬЗЯ "Хабр (https://...)"), НЕ оставляй "[текст]" без "(URL)";
- при наличии — вставляй картинки строкой "![](URL)" из переданного списка,
  по одной между смысловыми блоками. Используй ТОЛЬКО URL из списка, дословно,
  НЕ выдумывай свои. НЕ вставляй первую картинку (она уже показана как обложка).
  Если список картинок пуст — не вставляй ни одной.

ВАЖНО про Markdown-синтаксис: "##", "-", "**" работают только как разметка
в начале строки / парами. Пиши ЧИСТЫЙ Markdown — НЕ экранируй эти символы
обратным слэшем и не вставляй HTML-теги.

Верни СТРОГО валидный JSON-объект (и ничего кроме него) со следующими полями:
{
  "title": "цепкий, не кликбейтный заголовок, КОРОТКИЙ — до 80 символов, без точки в конце",
  "description": "один абзац-резюме (2–3 предложения)",
  "content": "тело поста в Markdown. НЕ начинай с заголовка/H1 — заголовок уже показан над постом, не дублируй его. ПОСЛЕДНЯЯ строка ровно в формате \\"Источник: [название](URL)\\" — название источника как текст ссылки, оригинальный URL в круглых скобках сразу за \\"]\\", без пробела (например \\"Источник: [Хабр](https://habr.com/...)\\")",
  "tags": ["1–3 тематических тега СТРОГО из этого списка (нижний регистр, ничего другого): технологии, наука, политика, культура, ai, llm, агенты, нейросети, безопасность, разработка, гаджеты, бизнес"],
  "metaTitle": "SEO-заголовок (≈ title)",
  "metaDescription": "SEO-описание (до ~155 символов)"
}

Не выдумывай факты, которых нет во входных данных. Если данных мало — пиши
короче, но без домыслов. Никакого текста до или после JSON.`;

export const RELEVANCE_SYSTEM_PROMPT = `Ты — фильтр релевантности для блога об ИИ и технологиях.
Тематика блога: искусственный интеллект, машинное обучение, нейросети, языковые
модели, чипы и железо, разработка ПО, opensource, кибербезопасность, гаджеты.
ВАЖНО: политика вокруг ИИ, бизнес и инвестиции в ИИ, влияние ИИ на рынок труда —
это ON-topic (релевантно), даже если выглядит как «политика» или «бизнес».

Оцени, насколько новость подходит блогу, по шкале 0–4:
  0 — совсем не по теме (спорт, шоу-бизнес, погода, светская хроника);
  4 — прямо про ИИ/технологии.

Верни СТРОГО валидный JSON-объект и ничего кроме него:
{"score":<0-4>,"topic":"<2-4 слова>","reason":"<кратко>"}`;

export function buildRewriteUserContent(item: FeedItem): string {
  const bodyImages = item.imageUrls.slice(1, 6);
  const imagesBlock = bodyImages.length
    ? `Картинки для тела (вставляй "![](URL)" по смыслу, только эти URL):\n${bodyImages.join("\n")}`
    : "Картинки: нет";
  return `Источник: ${item.feedTitle || "неизвестен"}
Ссылка на оригинал: ${item.url}
Заголовок: ${item.title}
Краткое описание: ${item.snippet || "(нет описания)"}
${imagesBlock}`;
}

export function buildRelevanceUserContent(item: FeedItem): string {
  const snippet = item.snippet.slice(0, 300);
  return `Заголовок: ${item.title}
Описание: ${snippet || "(нет описания)"}`;
}

/**
 * System prompt for the AI-model RELEASE extractor. This is a DATA-EXTRACTION
 * task (not the RU rewrite): pull structured facts about a newly released model
 * out of the source. The hard rule is anti-hallucination — return null for any
 * price/context/date the source does not state, NEVER guess a number, because the
 * owner reviews the card and a fabricated price would slip into the changelog.
 */
export const EXTRACT_RELEASE_SYSTEM_PROMPT = `You extract structured facts about a newly released AI model
from a news source. Read the title, snippet and source link, then return the
release as a strict JSON object — and NOTHING else.

CRITICAL anti-hallucination rule: return null for any numeric or date field you
cannot VERIFY directly from the provided source. NEVER guess, estimate, or infer
a price, context window, or release date. A wrong number is far worse than null —
null means "unknown", which is correct when the source is silent.

Return STRICTLY a valid JSON object (and nothing else) with these fields:
{
  "vendor": "the company/lab that released it (e.g. OpenAI, Anthropic, Google DeepMind)",
  "model": "the model family/name (e.g. GPT, Claude, Gemini)",
  "version": "the specific version/variant (e.g. 5, 4.5 Sonnet, 2.5 Flash)",
  "releasedAt": "the release date as an ISO string (YYYY-MM-DD) IF the source states it, else use today's date only if the source says it launched today, otherwise a best ISO the source supports",
  "sourceUrl": "the original article URL, copied verbatim",
  "contextTokens": <context window in tokens as a number, or null if not stated>,
  "priceIn": <input price in USD per 1M tokens as a number, or null if not stated>,
  "priceOut": <output price in USD per 1M tokens as a number, or null if not stated>,
  "changes": ["short bullet strings of the notable changes/features stated in the source; [] if none"],
  "sourceName": "the human-readable source name (e.g. TechCrunch), or null"
}

Do not invent facts absent from the input. No text before or after the JSON.`;

export function buildReleaseUserContent(item: FeedItem): string {
  return `Source: ${item.feedTitle || "unknown"}
Original link: ${item.url}
Title: ${item.title}
Snippet: ${item.snippet || "(no description)"}`;
}
