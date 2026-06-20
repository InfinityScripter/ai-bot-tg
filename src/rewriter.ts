import Anthropic from '@anthropic-ai/sdk';

import { CONFIG } from './config.js';
import { RewriteSchema } from './types.js';
import { stripHtml, truncate } from './utils.js';
import type { FeedItem, RewriteResult } from './types.js';

const client = new Anthropic({ apiKey: CONFIG.ANTHROPIC_API_KEY });

/**
 * Builds a post from the feed item directly, with NO Claude call. Used when
 * REWRITE_MOCK is on, so the collect → approve → publish pipeline can be tested
 * without API credits. Output is a faithful copy of the source, not a rewrite —
 * never enable this in production.
 */
function mockRewrite(item: FeedItem): RewriteResult {
  const snippet = stripHtml(item.snippet).trim();
  // RSS often gives only a title (empty snippet) — fall back to the title as the
  // lede rather than repeating it twice. The real Claude path writes a full body.
  const lede = snippet || item.title;
  // Some feeds (Meduza) ship very long titles — clamp so the post heading stays
  // readable. The page already shows this as the heading, so the body must NOT
  // repeat it (no leading "## title", which rendered larger than the page H1).
  const title = truncate(item.title, 100);
  const description = truncate(lede, 200);
  const content = [
    snippet || '_Полный текст доступен по ссылке на источник._',
    '',
    `Источник: [${item.feedTitle || 'оригинал'}](${item.url})`,
  ].join('\n');
  return {
    title,
    description,
    content,
    tags: ['новости'],
    metaTitle: truncate(item.title, 70),
    metaDescription: truncate(lede, 155),
  };
}

// Constant system prompt → eligible for prompt caching across the daily batch.
// We instruct strict JSON and validate with zod on our side (defensive parse),
// which is portable across SDK versions and robust to stray prose.
const SYSTEM_PROMPT = `Ты — редактор новостного блога. По заголовку и краткому
описанию новости из источника напиши ОРИГИНАЛЬНЫЙ пост на русском языке: своими
словами, без копирования формулировок источника. Нейтральный журналистский тон.

Верни СТРОГО валидный JSON-объект (и ничего кроме него) со следующими полями:
{
  "title": "цепкий, не кликбейтный заголовок, КОРОТКИЙ — до 80 символов, без точки в конце",
  "description": "один абзац-резюме (2–3 предложения)",
  "content": "тело поста в Markdown, 2–4 коротких абзаца. НЕ начинай с заголовка/H1/H2 — заголовок уже показан над постом, не дублируй его. В конце строка \\"Источник: <название>\\" со ссылкой на оригинал",
  "tags": ["2–5 тематических тегов в нижнем регистре"],
  "metaTitle": "SEO-заголовок (≈ title)",
  "metaDescription": "SEO-описание (до ~155 символов)"
}

Не выдумывай факты, которых нет во входных данных. Если данных мало — пиши
короче, но без домыслов. Никакого текста до или после JSON.`;

/** Extracts the text from the first text content block of a message response. */
function extractText(response: Anthropic.Message): string {
  for (const block of response.content) {
    if (block.type === 'text') return block.text;
  }
  return '';
}

/** Pulls the first balanced-looking JSON object out of a text blob. */
function extractJson(text: string): string | null {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  return text.slice(start, end + 1);
}

/**
 * Rewrites a feed item into a unique blog post via Claude. Instructs strict
 * JSON, extracts it defensively, and validates with zod. Throws on refusal or
 * invalid output — the caller marks the candidate rewrite_failed and surfaces
 * the error in the Telegram DM, so one failure never aborts the batch.
 */
export async function rewriteToPost(item: FeedItem): Promise<RewriteResult> {
  if (CONFIG.REWRITE_MOCK) {
    return mockRewrite(item);
  }

  const userContent = `Источник: ${item.feedTitle || 'неизвестен'}
Ссылка на оригинал: ${item.url}
Заголовок: ${item.title}
Краткое описание: ${item.snippet || '(нет описания)'}`;

  const response = await client.messages.create({
    model: CONFIG.REWRITE_MODEL,
    max_tokens: 2048,
    system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: userContent }],
  });

  // 'refusal' may not be in this SDK version's StopReason union — compare as a
  // widened string so the guard works regardless of SDK version.
  if ((response.stop_reason as string) === 'refusal') {
    throw new Error('Claude отказался обрабатывать новость (refusal).');
  }

  const raw = extractJson(extractText(response));
  if (!raw) {
    throw new Error('Claude не вернул JSON в ответе.');
  }

  let candidate: unknown;
  try {
    candidate = JSON.parse(raw);
  } catch {
    throw new Error('Claude вернул невалидный JSON.');
  }

  const parsed = RewriteSchema.safeParse(candidate);
  if (!parsed.success) {
    throw new Error(`Ответ Claude не прошёл валидацию: ${parsed.error.issues[0]?.message ?? 'unknown'}`);
  }
  // Defensive clamp: even if Claude ignores the length hint, keep the heading
  // readable on the post page.
  return { ...parsed.data, title: truncate(parsed.data.title, 100) };
}
