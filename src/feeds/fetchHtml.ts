/**
 * The one capped HTML GET shared by every scraper in feeds/ (article ingest,
 * body enrichment, og:image). Single request, hard timeout, size-capped body
 * read — so a huge or hung page can never stall a run or buffer unbounded.
 * Throws readable RU errors; callers that must not fail (og:image) catch them.
 */

const DEFAULT_TIMEOUT_MS = 8_000;

const REQUEST_HEADERS = {
  Accept: "text/html,application/xhtml+xml",
  "User-Agent": "blog-newsbot/1.0",
} as const;

/**
 * Reads a response body as text, stopping once `maxBytes` have been consumed so
 * a huge page never buffers unbounded. Falls back to a plain (then sliced)
 * `res.text()` when the body isn't a readable stream.
 */
export async function readCapped(res: Response, maxBytes: number): Promise<string> {
  const reader = res.body?.getReader?.();
  if (!reader) return (await res.text()).slice(0, maxBytes);
  const decoder = new TextDecoder("utf-8");
  let out = "";
  let read = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      read += value.byteLength;
      out += decoder.decode(value, { stream: true });
      if (read >= maxBytes) break;
    }
  } finally {
    // Stop the transfer; we have enough. Ignore any cancel error.
    await reader.cancel().catch(() => {});
  }
  out += decoder.decode();
  return out;
}

/**
 * GETs a page and returns the first `maxBytes` of its HTML. Throws a readable
 * Error on a network failure, a non-ok status, or a non-HTML content type —
 * the messages surface verbatim in the owner's Telegram DM.
 */
export async function fetchHtml(
  url: string,
  maxBytes: number,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  let res: Response;
  try {
    res = await fetch(url, { signal: controller.signal, headers: REQUEST_HEADERS });
  } catch (err) {
    throw new Error(`Не удалось загрузить страницу: ${String(err)}`);
  } finally {
    clearTimeout(timeout);
  }

  if (!res.ok) throw new Error(`Страница ответила ${res.status}.`);
  const type = res.headers.get("content-type") ?? "";
  if (type && !type.includes("html")) throw new Error("Ссылка ведёт не на HTML-страницу.");

  return readCapped(res, maxBytes);
}
