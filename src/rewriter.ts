import Anthropic from "@anthropic-ai/sdk";

import { CONFIG } from "./config.js";
import { normalizeTags } from "./tags.js";
import { RewriteSchema } from "./types.js";
import { truncate, stripHtml } from "./utils.js";
import { chatUrl, PROVIDERS, resolveActiveProvider } from "./providers.js";
import { ProviderKind, ProviderName as ProviderNameEnum } from "./enums.js";

import type { CandidateStore } from "./store.js";
import type { FeedItem, RewriteResult } from "./types.js";
import type { ProviderName, ProviderSpec } from "./providers.js";

const client = new Anthropic({ apiKey: CONFIG.ANTHROPIC_API_KEY });

/**
 * Builds a post from the feed item directly, with NO LLM call. Used when
 * REWRITE_MOCK is on (or REWRITE_PROVIDER=mock), so the collect → approve →
 * publish pipeline can be tested without API credits. Output is a faithful copy
 * of the source, not a rewrite — never enable this in production.
 */
function mockRewrite(item: FeedItem): RewriteResult {
  const snippet = stripHtml(item.snippet).trim();
  // RSS often gives only a title (empty snippet) — fall back to the title as the
  // lede rather than repeating it twice. The real LLM path writes a full body.
  const lede = snippet || item.title;
  // Some feeds (Meduza) ship very long titles — clamp so the post heading stays
  // readable. The page already shows this as the heading, so the body must NOT
  // repeat it (no leading "## title", which rendered larger than the page H1).
  const title = truncate(item.title, 100);
  const description = truncate(lede, 200);
  // Drop the cover (shown by the page already); embed the rest of the images so
  // the mock body isn't a flat wall of text either.
  const bodyImages = item.imageUrls.slice(1, 4).map((u) => `![](${u})`);
  const content = [
    snippet || "_Полный текст доступен по ссылке на источник._",
    ...(bodyImages.length ? ["", ...bodyImages] : []),
    "",
    `Источник: [${item.feedTitle || "оригинал"}](${item.url})`,
  ].join("\n");
  return {
    title,
    description,
    content,
    // normalizeTags force-includes 'новости'; the mock has no topical tags to add.
    tags: normalizeTags([]),
    metaTitle: truncate(item.title, 70),
    metaDescription: truncate(lede, 155),
  };
}

// Constant system prompt → eligible for prompt caching across the daily batch.
// We instruct strict JSON and validate with zod on our side (defensive parse),
// which is portable across providers and robust to stray prose.
const SYSTEM_PROMPT = `Ты — редактор технического новостного блога. По заголовку,
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

/** Builds the per-item user message shared by both LLM providers. */
function buildUserContent(item: FeedItem): string {
  // Skip the cover (index 0) — it's rendered by the page; offer the rest as
  // body candidates. Cap so a gallery-heavy article doesn't bloat the prompt.
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

/** Extracts the text from the first text content block of a message response. */
function extractText(response: Anthropic.Message): string {
  for (const block of response.content) {
    if (block.type === "text") return block.text;
  }
  return "";
}

/** Pulls the first balanced-looking JSON object out of a text blob. */
function extractJson(text: string): string | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  return text.slice(start, end + 1);
}

/**
 * Strips any Markdown image whose URL is not in the allow-list. Guards against
 * a model inventing image URLs (or echoing the cover): only images that came
 * from the feed survive. Leaves the surrounding text untouched.
 */
function sanitizeImages(content: string, allowed: string[]): string {
  const allow = new Set(allowed);
  return (
    content
      .replace(/!\[[^\]]*\]\(([^)]+)\)/g, (full, url: string) =>
        allow.has(url.trim()) ? full : "",
      )
      // collapse blank-line runs left behind by removed images
      .replace(/\n{3,}/g, "\n\n")
      .trim()
  );
}

/** Parses, validates and post-processes a raw JSON string from either provider. */
function finalizeRewrite(raw: string | null, item: FeedItem): RewriteResult {
  if (!raw) {
    throw new Error("LLM не вернул JSON в ответе.");
  }
  let candidate: unknown;
  try {
    candidate = JSON.parse(raw);
  } catch {
    throw new Error("LLM вернул невалидный JSON.");
  }
  const parsed = RewriteSchema.safeParse(candidate);
  if (!parsed.success) {
    throw new Error(
      `Ответ LLM не прошёл валидацию: ${parsed.error.issues[0]?.message ?? "unknown"}`,
    );
  }
  // Only allow body images (cover excluded — the page shows it). Defensive
  // clamp on the title keeps the heading readable even if the hint is ignored.
  // normalizeTags is the safety net for the tag list — it forces 'новости'
  // first, drops anything off the whitelist, maps synonyms, and caps at 4, so
  // the published tags/metaKeywords are always the clean curated set. Applied
  // here so BOTH providers (Claude and the OpenAI-compatible ones) get it.
  const allowed = item.imageUrls.slice(1);
  return {
    ...parsed.data,
    title: truncate(parsed.data.title, 100),
    content: sanitizeImages(parsed.data.content, allowed),
    tags: normalizeTags(parsed.data.tags),
  };
}

/** Rewrites via Claude (Anthropic) with the given model. */
async function rewriteWithAnthropic(item: FeedItem, model: string): Promise<RewriteResult> {
  const response = await client.messages.create({
    model,
    max_tokens: 2048,
    system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content: buildUserContent(item) }],
  });

  // 'refusal' may not be in this SDK version's StopReason union — compare as a
  // widened string so the guard works regardless of SDK version.
  if ((response.stop_reason as string) === "refusal") {
    throw new Error("Claude отказался обрабатывать новость (refusal).");
  }
  return finalizeRewrite(extractJson(extractText(response)), item);
}

interface OpenAIChatResponse {
  choices?: { message?: { content?: string } }[];
}

/**
 * Rewrites via any OpenAI-compatible chat-completions endpoint (Gemini, GLM,
 * DeepSeek). No SDK — a single fetch. response_format=json_object nudges the
 * model toward pure JSON, but we still extract+validate defensively. URL/key
 * come from the provider registry; the model is resolved at call time.
 */
async function rewriteWithOpenAICompat(
  item: FeedItem,
  spec: ProviderSpec,
  model: string,
): Promise<RewriteResult> {
  let response: Response;
  try {
    response = await fetch(chatUrl(spec), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${spec.apiKey()}`,
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: buildUserContent(item) },
        ],
        response_format: { type: "json_object" },
      }),
    });
  } catch (err) {
    throw new Error(`Не удалось связаться с ${spec.label}: ${String(err)}`);
  }

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`${spec.label} ответил ${response.status}: ${text.slice(0, 200)}`);
  }

  const data = (await response.json()) as OpenAIChatResponse;
  const text = data.choices?.[0]?.message?.content ?? "";
  return finalizeRewrite(extractJson(text), item);
}

/**
 * Rewrites a feed item into a unique blog post. Resolves the active provider +
 * model at call time (a stored /model override wins over the env default), then
 * dispatches to Claude / an OpenAI-compatible endpoint / mock. Throws on refusal
 * or invalid output — the caller marks the candidate rewrite_failed and surfaces
 * the error in the Telegram DM, so one failure never aborts the batch.
 */
export async function rewriteToPost(item: FeedItem, store: CandidateStore): Promise<RewriteResult> {
  const { provider, model } = resolveActiveProvider(store);
  return rewriteWith(item, provider, model);
}

/** Dispatches a rewrite to a specific provider+model. Shared by the rewriter. */
async function rewriteWith(
  item: FeedItem,
  provider: ProviderName,
  model: string,
): Promise<RewriteResult> {
  if (provider === ProviderNameEnum.Mock) {
    return mockRewrite(item);
  }
  const spec = PROVIDERS[provider];
  if (spec.kind === ProviderKind.Anthropic) {
    return rewriteWithAnthropic(item, model);
  }
  return rewriteWithOpenAICompat(item, spec, model);
}
