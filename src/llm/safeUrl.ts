/** Returns a canonical absolute http(s) URL, or null for unsafe/malformed input. */
export function normalizeHttpUrl(value: string): string | null {
  const trimmed = value.trim();
  const hasControlOrWhitespace = [...trimmed].some((char) => {
    const code = char.charCodeAt(0);
    return code <= 31 || code === 127 || /\s/.test(char);
  });
  if (!trimmed || hasControlOrWhitespace) return null;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    return parsed.href.replaceAll("(", "%28").replaceAll(")", "%29");
  } catch {
    return null;
  }
}
