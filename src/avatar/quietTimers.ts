/**
 * One pending "consider replying" timer per chat. Every new message restarts
 * the chat's timer, so the model is asked once per pause in the talk, not once
 * per message — the main cost control of the read-everything mode.
 */
export class QuietTimers {
  private readonly timers = new Map<number, NodeJS.Timeout>();

  private readonly quietMs: number;

  constructor(quietMs: number) {
    this.quietMs = quietMs;
  }

  bump(chatId: number, fire: () => void): void {
    this.cancel(chatId);
    const timer = setTimeout(() => {
      this.timers.delete(chatId);
      fire();
    }, this.quietMs);
    this.timers.set(chatId, timer);
  }

  cancel(chatId: number): void {
    const timer = this.timers.get(chatId);
    if (timer) clearTimeout(timer);
    this.timers.delete(chatId);
  }

  stopAll(): void {
    for (const chatId of [...this.timers.keys()]) this.cancel(chatId);
  }
}
