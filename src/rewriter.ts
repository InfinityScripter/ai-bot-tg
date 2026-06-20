import Anthropic from '@anthropic-ai/sdk';

import { CONFIG } from './config.js';
import { RewriteSchema } from './types.js';
import type { FeedItem, RewriteResult } from './types.js';

const client = new Anthropic({ apiKey: CONFIG.ANTHROPIC_API_KEY });

// Constant system prompt → eligible for prompt caching across the daily batch.
// We instruct strict JSON and validate with zod on our side (defensive parse),
// which is portable across SDK versions and robust to stray prose.
const SYSTEM_PROMPT = `Ты — редактор новостного блога. По заголовку и краткому
описанию новости из источника напиши ОРИГИНАЛЬНЫЙ пост на русском языке: своими
словами, без копирования формулировок источника. Нейтральный журналистский тон.

Верни СТРОГО валидный JSON-объект (и ничего кроме него) со следующими полями:
{
  "title": "цепкий, не кликбейтный заголовок",
  "description": "один абзац-резюме (2–3 предложения)",
  "content": "тело поста в Markdown, 2–4 коротких абзаца; в конце строка \\"Источник: <название>\\" со ссылкой на оригинал",
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
  return parsed.data;
}
