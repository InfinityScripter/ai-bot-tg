/**
 * LLM-as-judge prompt for rewrite quality. The deterministic checks prove the
 * output is SHAPED right (valid JSON, source line, allow-listed images, clean
 * markdown); they cannot judge whether the prose is good. The judge fills that
 * gap: given the source item and the produced post, it scores 1–5 on a RU
 * quality rubric and lists concrete issues. Advisory by default — a case fails
 * only when the score is below the configured floor.
 */

import type { FeedItem, RewriteResult } from "../../src/types.js";

/** System prompt: defines the rubric and forces a strict JSON verdict. */
export const JUDGE_SYSTEM_PROMPT = `Ты — строгий редактор, оценивающий качество новостного поста, переписанного из
источника. Тебе дают исходную новость и готовый пост. Оцени пост по шкале 1–5:
  1 — плохо: копия источника, выдуманные факты, или сломанная структура;
  3 — приемлемо: оригинально и без домыслов, но структура/тон средние;
  5 — отлично: самостоятельный пересказ, чёткая структура, нейтральный тон,
      никаких выдуманных фактов, чистое оформление.

Критерии (учитывай все):
- ОРИГИНАЛЬНОСТЬ: пост пересказан своими словами, а не скопирован дословно;
- ФАКТИЧНОСТЬ: нет цифр/дат/цитат/имён, которых нет в источнике;
- СТРУКТУРА: короткие абзацы, уместные подзаголовки/списки, не стена текста;
- ТОН: нейтральный, без кликбейта;
- ЯЗЫК: русский, имена собственные и термины сохранены корректно.

Верни СТРОГО валидный JSON и ничего кроме него:
{"score":<1-5>,"issues":["<короткие конкретные замечания; [] если нет>"]}`;

/** Builds the judge user message: source facts + the produced post. */
export function buildJudgeUserContent(item: FeedItem, result: RewriteResult): string {
  return `ИСХОДНАЯ НОВОСТЬ
Источник: ${item.feedTitle || "неизвестен"}
Заголовок: ${item.title}
Описание: ${item.snippet || "(нет описания)"}

ГОТОВЫЙ ПОСТ
Заголовок: ${result.title}
Описание: ${result.description}
Тело:
${result.content}`;
}
