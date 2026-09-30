/** Telegram auto-links bare domains and @mentions in the visible text; cleanRetellHtml can't catch them. */
const DOMAIN_RE = /\b[\w-]+(\.[\w-]+)*\.[a-z]{2,}\b/gi;
const HANDLE_RE = /@[A-Za-z0-9_]{4,}/g;

/** Every bare domain and @handle Telegram would turn into a link, lowercased. */
export function linkables(text: string): string[] {
  return [...text.matchAll(DOMAIN_RE), ...text.matchAll(HANDLE_RE)].map((m) => m[0].toLowerCase());
}
