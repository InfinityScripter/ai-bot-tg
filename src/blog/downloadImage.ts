const DOWNLOAD_TIMEOUT_MS = 15_000;
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

function skip(url: string, reason: string): null {
  console.warn(`[channels] photo skipped (${reason}): ${url}`);
  return null;
}

/** The body up to `maxBytes`, or null once it grows past the cap (transfer cancelled). */
async function readUpTo(res: Response, maxBytes: number): Promise<Uint8Array[] | null> {
  const reader = res.body?.getReader();
  if (!reader) return [];
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return chunks;
      size += value.byteLength;
      if (size > maxBytes) return null;
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
}

/**
 * Fetches a post photo for upload as a file: Telegram refuses to fetch the
 * t.me CDN (cdn*.telesco.pe) URLs itself. Never throws — a photo that can't be
 * used is logged and skipped, the post goes out with the rest.
 */
export async function downloadImage(url: string): Promise<Blob | null> {
  if (!/^https?:\/\//i.test(url)) return skip(url, "not http(s)");
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
    if (!res.ok) return skip(url, `HTTP ${res.status}`);
    const type = res.headers.get("content-type") ?? "";
    if (!type.startsWith("image/")) return skip(url, `not an image: ${type || "no type"}`);
    if (Number(res.headers.get("content-length") ?? 0) > MAX_IMAGE_BYTES) {
      return skip(url, "over 10 MB");
    }
    const chunks = await readUpTo(res, MAX_IMAGE_BYTES);
    if (!chunks) return skip(url, "over 10 MB");
    return new Blob(chunks, { type });
  } catch (err) {
    return skip(url, err instanceof Error ? err.name : "error");
  }
}
