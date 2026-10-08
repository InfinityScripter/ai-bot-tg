/** Frequent words that match every post and push the real topic out of the top 5. */
const STOP_WORDS = new Set([
  "как",
  "что",
  "про",
  "для",
  "или",
  "это",
  "так",
  "уже",
  "там",
  "тут",
  "его",
  "она",
  "они",
  "мне",
  "вот",
  "нет",
  "все",
  "всё",
  "еще",
  "ещё",
  "был",
  "чтобы",
  "если",
  "когда",
  "есть",
  "было",
  "были",
  "будет",
  "меня",
  "тебя",
  "тебе",
  "просто",
  "очень",
  "можно",
  "нужно",
  "сейчас",
  "тоже",
  "только",
  "потому",
  "вообще",
  "кстати",
]);
/** FTS5 has no Russian stemmer: a 6-letter prefix catches most word forms (агентов, агенты). */
const PREFIX_CHARS = 6;
const MAX_TERMS = 12;

/** Words of 3+ letters, plus 2-letter acronyms written in capitals (ИИ, AI, ML). */
function isTerm(word: string): boolean {
  if (word.length >= 3) return true;
  return word.length === 2 && word === word.toUpperCase() && word !== word.toLowerCase();
}

/**
 * Chat text → FTS5 MATCH expression: terms minus stop words, cut to a prefix,
 * de-duplicated, OR-ed. Every term is a quoted string, so chat text can never
 * inject FTS syntax (NEAR, AND, column filters, ^).
 */
export function buildSearchQuery(texts: string[]): string {
  const words = (texts.join(" ").match(/[\p{L}\p{N}]+/gu) ?? [])
    .filter(isTerm)
    .map((w) => w.toLowerCase());
  const terms = [
    ...new Set(words.filter((w) => !STOP_WORDS.has(w)).map((w) => w.slice(0, PREFIX_CHARS))),
  ];
  return terms
    .slice(0, MAX_TERMS)
    .map((t) => `"${t}"*`)
    .join(" OR ");
}
