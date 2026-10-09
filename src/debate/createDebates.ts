import type { Side, Debate, Speaker, DebateLine } from "./types.js";

export interface DebateDeps {
  hope: Speaker;
  avatar: Speaker;
  /** Replies per side, the opener included. */
  turns: number;
  /** Pause before every reply. */
  pauseMs: number;
  /** A new debate in a chat waits this long after the last one with replies. */
  cooldownMs: number;
}

/** Shutdown waits this long for a reply in flight (systemd allows 20 s). */
const DRAIN_MAX_MS = 10_000;

const other = (side: Side): Side => (side === "hope" ? "avatar" : "hope");

/**
 * Hope and the avatar argue in a chat: they take turns, each reply answers
 * the last one. Telegram hides other bots' messages from a bot unless its
 * "Bot to Bot Communication Mode" is on in BotFather; we keep it off, and this
 * engine, not Telegram, passes the lines between them. The per-side
 * counter is the only loop between the two bots, and it always ends. A
 * debate runs detached and never throws.
 */
export function createDebates(deps: DebateDeps) {
  /** The running debate of each chat. */
  const running = new Map<number, Promise<void>>();
  const endedAt = new Map<number, number>();
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
    while (debate.lines.length < 2 * deps.turns) {
      await pause(deps.pauseMs);
      if (stopped) return "shutdown";
      const side = other(debate.lines.at(-1)!.side);
      for (const s of [side, other(side)]) {
        if (!(await deps[s].canSpeak(debate.chatId))) return `${s} cannot speak here`;
      }
      const line = await deps[side].speak(debate);
      if (!line) return `${side} had no reply`;
      debate.lines.push(line);
      console.log(`[debate] ${debate.chatId}: ${side} replied, ${line.text.length} chars`);
    }
    return "done";
  }

  function start(chatId: number, opener: DebateLine, topic: string): void {
    if (stopped) return;
    if (running.has(chatId)) {
      console.log(`[debate] ${chatId}: not started, one is already running`);
      return;
    }
    const last = endedAt.get(chatId);
    if (last !== undefined && Date.now() - last < deps.cooldownMs) {
      console.log(`[debate] ${chatId}: not started, the last one ended less than a cooldown ago`);
      return;
    }
    const debate: Debate = { chatId, topic, lines: [opener] };
    console.log(`[debate] ${chatId}: started by ${opener.side}`);
    // Every attempt holds the cooldown, even a failed one: with Codex down or
    // the news bot missing from the group, every reply would start a doomed debate.
    const loop = run(debate)
      .catch((err: unknown) => `failed: ${String(err)}`)
      .then((reason) => {
        console.log(`[debate] ${chatId}: ended (${reason}), ${debate.lines.length} lines`);
        endedAt.set(chatId, Date.now());
      })
      .finally(() => running.delete(chatId));
    running.set(chatId, loop);
  }

  /** Resolves when no debate runs. */
  async function idle(): Promise<void> {
    while (running.size > 0) await Promise.allSettled([...running.values()]);
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
    const done = Promise.allSettled([...running.values()]).then(() => "done" as const);
    if ((await Promise.race([done, cap])) === "cut") {
      console.warn(`[debate] shutdown cut ${running.size} debates mid-reply`);
    }
  }

  return { start, idle, stop, drain };
}
