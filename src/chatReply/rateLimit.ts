const HOUR_MS = 60 * 60 * 1000;

/**
 * Rolling one-hour cap on paid fallback calls. In memory on purpose: a restart
 * (every deploy) resets it, which at worst doubles one hour's spend — not worth
 * a table.
 */
export function createRateLimit(maxPerHour: number, now: () => number = Date.now) {
  let stamps: number[] = [];

  function prune(): void {
    const cutoff = now() - HOUR_MS;
    stamps = stamps.filter((t) => t > cutoff);
  }

  return {
    /** Takes one slot; false when the hour is already full. */
    tryTake(): boolean {
      prune();
      if (stamps.length >= maxPerHour) return false;
      stamps.push(now());
      return true;
    },
    used(): number {
      prune();
      return stamps.length;
    },
  };
}
