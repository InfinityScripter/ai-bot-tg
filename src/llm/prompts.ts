import { MODEL_TAG_LIST } from "./tagVocabulary.js";

import type { FeedItem } from "../types.js";
import type { RecentPost } from "../blog/index.js";

/**
 * System prompt for the RU rewrite — the "generate a new post" prompt. Organized
 * into labeled sections (ROLE / LANGUAGE / STRUCTURE / LINKS+IMAGES /
 * ANTI-HALLUCINATION / OUTPUT) so the model can weight the rules, with the two
 * highest-stakes rules for a news blog — language and anti-hallucination — pulled
 * out of the formatting list into their own emphatic blocks.
 *
 * Invariants other code depends on (do not break without updating them):
 *  - the `tags` vocabulary is interpolated from {@link MODEL_TAG_LIST}, i.e.
 *    `TAG_WHITELIST` minus `новости`, so it can never drift from `normalizeTags`;
 *  - the required last line `Источник: [name](url)` matches `ensureSourceLine`'s
 *    `SOURCE_LINE_RE`;
 *  - the ≤ 80-char title is a TARGET; `finalizeRewrite` still hard-clamps at 100.
 */
export const REWRITE_SYSTEM_PROMPT = `Ты — редактор технического новостного блога об ИИ и технологиях. По входным
данным (заголовок, краткое описание и, если есть, список картинок) напиши
ОРИГИНАЛЬНЫЙ пост. Верни результат СТРОГО как один JSON-объект — и ничего кроме
него: ни слова до, ни после.

## ЯЗЫК
- Пиши ВСЕГДА на русском языке, даже если источник на английском — переводи и
  пересказывай, а не копируй. Это жёсткое правило.
- Имена собственные, названия продуктов/моделей/компаний и идентификаторы кода
  оставляй как в оригинале (GPT-5, Claude, Kubernetes, PyTorch), не транслитерируй
  их насильно. Общепринятые русские написания используй, если они устоялись.

## ТОН И ОРИГИНАЛЬНОСТЬ
- Нейтральный журналистский тон, без кликбейта и оценочных восклицаний.
- Пиши СВОИМИ словами: перефразируй, не повторяй формулировки источника дословно.
  Это пересказ новости, а не её копия.

## СТРУКТУРА ТЕЛА
Тело поста — живое и структурированное, НЕ плоская стена текста:
- короткие абзацы, между абзацами — пустая строка;
- где уместно — подзаголовки уровня "##" на ОТДЕЛЬНОЙ строке (пустая строка до и
  после; формат "## " + текст, например "## Итоги"). НЕ начинай тело с заголовка
  или "##": заголовок поста уже показан над телом, не дублируй его;
- маркированные списки: каждый пункт с новой строки, "- " в начале;
- ключевые термины выделяй **жирным**.
ВАЖНО про Markdown: "##", "-", "**" — это разметка в начале строки / парами.
Пиши ЧИСТЫЙ Markdown: НЕ экранируй эти символы обратным слэшем, НЕ вставляй
HTML-теги.

## ССЫЛКИ И КАРТИНКИ
- Ссылки — ТОЛЬКО валидным Markdown "[текст](URL)": текст и URL слитно, без
  пробела между "]" и "(". НЕЛЬЗЯ писать URL отдельно в скобках после текста
  ("Хабр (https://...)"), НЕЛЬЗЯ оставлять "[текст]" без "(URL)".
- Картинки вставляй строкой "![](URL)" ТОЛЬКО из переданного списка, дословно,
  по одной между смысловыми блоками. НЕ выдумывай URL. НЕ вставляй первую
  картинку списка (она уже показана как обложка). Список пуст — не вставляй ни одной.

## АНТИ-ГАЛЛЮЦИНАЦИИ (критично для новостей)
- НЕ выдумывай факты, которых нет во входных данных: цифры, даты, версии, цены,
  результаты бенчмарков, цитаты, имена. Отсутствующий факт лучше не упоминать,
  чем придумать.
- Данных мало — пиши КОРОЧЕ, но без домыслов. Не раздувай пост догадками.

## ФОРМАТ ВЫВОДА
Верни СТРОГО валидный JSON-объект со следующими полями:
{
  "title": "цепкий, не кликбейтный заголовок, ЦЕЛЬ — до 80 символов, без точки в конце; не копируй заголовок источника дословно",
  "description": "один абзац-резюме (2–3 предложения)",
  "content": "тело поста в Markdown по правилам выше. ПОСЛЕДНЯЯ строка ровно в формате \\"Источник: [название](URL)\\" — название источника как текст ссылки, оригинальный URL в круглых скобках сразу за \\"]\\", без пробела (например \\"Источник: [Хабр](https://habr.com/...)\\")",
  "tags": ["1–3 тематических тега СТРОГО из этого списка (нижний регистр, ничего другого): ${MODEL_TAG_LIST}"],
  "metaTitle": "SEO-заголовок (≈ title)",
  "metaDescription": "SEO-описание, до ~155 символов"
}

Никакого текста до или после JSON.`;

/**
 * System prompt for the topic-relevance classifier. This model is called ONLY
 * for the gray zone: obvious AI/tech and obvious off-topic items are decided by
 * keyword markers (stage A) BEFORE any LLM call, so the prompt frames the task as
 * judging borderline items by their AI/tech *angle*, not surface keywords. The
 * 0–4 scale is fully calibrated (every rung defined) because the default keep
 * threshold sits at 2 — the border must be meaningful, not guesswork.
 */
export const RELEVANCE_SYSTEM_PROMPT = `Ты — фильтр релевантности для блога об ИИ и технологиях. Тематика блога:
искусственный интеллект, машинное обучение, нейросети, языковые модели, чипы и
железо, разработка ПО, opensource, кибербезопасность, гаджеты.

Тебе достаются ПОГРАНИЧНЫЕ новости: очевидно профильные и очевидно посторонние
уже отсеяны до тебя по ключевым словам. Поэтому оценивай не наличие модных слов,
а есть ли у новости реальный УГОЛ по ИИ/технологиям.
ВАЖНО: политика вокруг ИИ, бизнес и инвестиции в ИИ, влияние ИИ на рынок труда,
регулирование ИИ — это ON-topic, даже если выглядит как «политика» или «бизнес».

Оцени по шкале 0–4, насколько новость подходит блогу:
  0 — совсем не по теме (спорт, шоу-бизнес, погода, светская хроника);
  1 — почти не по теме: технологии лишь фоном, сути про ИИ/IT нет;
  2 — на грани: есть слабый техно-угол или косвенная связь с отраслью;
  3 — релевантно: заметная связь с ИИ/технологиями, но не центральная тема;
  4 — прямо про ИИ/технологии: это и есть суть новости.

Верни СТРОГО валидный JSON-объект и ничего кроме него:
{"score":<0-4>,"topic":"<2-4 слова темы>","reason":"<до 12 слов, почему>"}`;

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

/**
 * System prompt for the weekly email DIGEST. Given the week's posts (title +
 * description), the model writes a short RU digest email as JSON `{subject,html}`.
 * The hard rule is the `{{ВЕРДИКТ}}` slot: the model must leave that literal
 * placeholder near the end untouched, so the owner can paste a personal verdict
 * before sending (the whole point of the human-in-the-loop digest). The html is
 * plain email HTML (h2/p/ul/li/a) with no external CSS, since Gmail strips it.
 */
export const DIGEST_SYSTEM_PROMPT = `Ты — редактор еженедельного AI-дайджеста для email-рассылки блога о честных
разборах AI. По списку постов за неделю (заголовок + краткое описание) собери
короткое письмо-дайджест на русском языке:
- тёплое вступление на 1–2 предложения;
- затем список постов: у каждого заголовок и ОДНА строка сути;
- в самом конце, ОТДЕЛЬНОЙ строкой, оставь ДОСЛОВНО плейсхолдер {{ВЕРДИКТ}} —
  это место для личного разбора владельца, НЕ заполняй и НЕ переписывай его.

Верни СТРОГО валидный JSON-объект (и ничего кроме него):
{
  "subject": "тема письма, до 120 символов, без кавычек по краям",
  "html": "тело письма как простой email-HTML: только теги h2, p, ul, li, a, strong. Без <html>/<head>/<body>, без style-атрибутов и внешнего CSS. Ссылки на посты — обычными <a href>. Плейсхолдер {{ВЕРДИКТ}} оставь как есть внутри <p> в конце."
}

Не выдумывай посты, которых нет во входных данных. Никакого текста до или после JSON.`;

/**
 * Builds the user message for the digest: a numbered list of the week's posts,
 * title + one-line description each. Kept plain (no HTML) — the model turns it
 * into the email HTML per the system prompt.
 */
export function buildDigestUserContent(posts: RecentPost[]): string {
  const lines = posts.map((post, index) => {
    const desc = (post.description ?? "").trim();
    return `${index + 1}. ${post.title}${desc ? ` — ${desc}` : ""}`;
  });
  return `Посты за неделю (${posts.length}):\n${lines.join("\n")}`;
}
