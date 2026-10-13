import type { Side, Debate, Speaker, DebateLine, DebateContext } from "./types.js";

export interface DebateDeps {
  hope: Speaker;
  avatar: Speaker;
  /** Legacy capacity; every positive value is capped at one line per side including the opener. */
  turns: number;
  /** Pause before every reply. */
  pauseMs: number;
  /** Repeating the same source (or a legacy opener without a source) waits this long. */
  cooldownMs: number;
  /** Detached follow-up; failures never delay or restart a debate. */
  onEnded?: (debate: Debate, reason: string) => void | Promise<void>;
}

/** Shutdown waits this long for a reply in flight (systemd allows 20 s). */
const DRAIN_MAX_MS = 10_000;

const other = (side: Side): Side => (side === "hope" ? "avatar" : "hope");

/**
 * Hope and the avatar argue in a chat: they take turns, each reply answers
 * the last one. Telegram hides other bots' messages from a bot unless its
 * "Bot to Bot Communication Mode" is on in BotFather; we keep it off, and this
 * engine, not Telegram, passes the lines between them. Silence ends the loop;
 * the total-line cap also bounds legacy per-side settings. A
 * debate runs detached and never throws.
 */
export function createDebates(deps: DebateDeps) {
  /** The running debate of each chat. */
  const running = new Map<number, Debate>();
  const loops = new Set<Promise<void>>();
  const endedAt = new Map<number, { at: number; triggerMessageId?: number }>();
  const wakers = new Set<() => void>();
  let stopped = false;

  /** A pause that shutdown cuts short; after shutdown it does not wait at all. */
  function pause(ms: number): Promise<void> {
    if (stopped) return Promise.resolve();
    return new Promise((resolve) => {
      const wake = (): void => {
        clearTimeout(timer);
        wakers.delete(wake);
        resolve();
      };
      const timer = setTimeout(wake, ms);
      wakers.add(wake);
    });
  }

  /**
   * Runs the turns after the opener; returns why it ended. The sides
   * alternate, so the line count says whose turn it is. Both sides must still
   * be able to speak before every turn: after /avatar off Hope must not answer
   * into the void.
   */
  async function run(debate: Debate): Promise<string> {
    const current = () => running.get(debate.chatId) === debate;
    while (debate.lines.length < Math.min(2 * deps.turns, 2)) {
      await pause(deps.pauseMs);
      if (stopped) return "shutdown";
      if (!current()) return "superseded";
      const side = other(debate.lines.at(-1)!.side);
      for (const s of [side, other(side)]) {
        if (!(await deps[s].canSpeak(debate.chatId))) return `${s} cannot speak here`;
      }
      if (!current()) return "superseded";
      const line = await deps[side].speak(debate);
      if (!current()) return "superseded";
      if (!line) return `${side} had no reply`;
      debate.lines.push(line);
      console.log(`[debate] ${debate.chatId}: ${side} replied, ${line.text.length} chars`);
    }
    return "done";
  }

  function start(
    chatId: number,
    opener: DebateLine,
    topic: string,
    context: DebateContext = {},
  ): void {
    if (stopped) return;
    const previous = running.get(chatId);
    if (
      previous &&
      (context.triggerMessageId === undefined ||
        context.triggerMessageId <= (previous.triggerMessageId ?? -Infinity))
    ) {
      console.log(`[debate] ${chatId}: not started, one is already running`);
      return;
    }
    const last = endedAt.get(chatId);
    if (
      last !== undefined &&
      (context.triggerMessageId === undefined ||
        context.triggerMessageId === last.triggerMessageId) &&
      Date.now() - last.at < deps.cooldownMs
    ) {
      console.log(`[debate] ${chatId}: not started, the last one ended less than a cooldown ago`);
      return;
    }
    const debate: Debate = { chatId, topic, lines: [opener], ...context };
    running.set(chatId, debate);
    console.log(`[debate] ${chatId}: started by ${opener.side}`);
    // Every attempt holds the cooldown, even a failed one: with Codex down or
    // the news bot missing from the group, every reply would start a doomed debate.
    const loop = run(debate)
      .catch((err: unknown) => `failed: ${String(err)}`)
      .then((reason) => {
        console.log(`[debate] ${chatId}: ended (${reason}), ${debate.lines.length} lines`);
        if (running.get(chatId) === debate)
          endedAt.set(chatId, { at: Date.now(), triggerMessageId: debate.triggerMessageId });
        if (deps.onEnded) {
          void Promise.resolve()
            .then(() => deps.onEnded?.(debate, reason))
            .catch((err: unknown) =>
              console.warn(`[debate] ${chatId}: completion callback failed: ${String(err)}`),
            );
        }
      })
      .finally(() => {
        if (running.get(chatId) === debate) running.delete(chatId);
        loops.delete(loop);
      });
    loops.add(loop);
  }

  /** Resolves when no debate runs. */
  async function idle(): Promise<void> {
    while (loops.size > 0) await Promise.allSettled([...loops]);
  }

  /** Starts no new debate and no new turn; a turn in flight still finishes. */
  function stop(): void {
    stopped = true;
    for (const wake of [...wakers]) wake();
  }

  /** Stops, then waits for the turns in flight, capped. */
  async function drain(): Promise<void> {
    stop();
    const cap = new Promise<"cut">((resolve) => {
      setTimeout(() => resolve("cut"), DRAIN_MAX_MS).unref();
    });
    const done = Promise.allSettled([...loops]).then(() => "done" as const);
    if ((await Promise.race([done, cap])) === "cut") {
      console.warn(`[debate] shutdown cut ${loops.size} debates mid-reply`);
    }
  }

  return { start, idle, stop, drain };
}
