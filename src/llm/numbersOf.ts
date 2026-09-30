/**
 * Thousands groups: a 1-3 digit lead, then groups of exactly three after a
 * space-like separator or a comma. Newlines never join: posts list tariffs one
 * per line ("x5\n200$"), and a newline join turned 5 and 200 into a fake "5200"
 * (abstractDL, 2026-09-30). A 4-digit lead is not a group ("2024 500" is a year
 * and a count).
 */
const THOUSANDS_RE = /(?<![\d.,])([1-9]\d{0,2})((?:[ ,\u00a0\u2009\u202f]\d{3})+)(?![\d]|[.,]\d)/g;

/**
 * The numbers a text states, normalised for comparison: "0,24" = "0.24",
 * "2 500" = "2,500" = "2500", "0.50" = "0.5".
 */
export function numbersOf(text: string): string[] {
  const glued = text.replace(
    THOUSANDS_RE,
    (_, lead: string, rest: string) => `${lead}${rest.replace(/\D/g, "")}`,
  );
  return (glued.match(/\d+(?:[.,]\d+)?/g) ?? []).map((n) => String(Number(n.replace(",", "."))));
}
