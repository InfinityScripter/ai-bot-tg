export interface GateInput {
  /** The message mentions the bot or replies to it. */
  direct: boolean;
  now: number;
  /** Answered turns in this chat today (UTC). */
  callsToday: number;
  lastAvatarAt: number | null;
  /** The last unasked turn, also one that ended in silence. */
  lastUnaskedAt: number | null;
  lastOwnerAt: number | null;
  limits: { dailyCalls: number; cooldownMs: number };
}

export type GateVerdict =
  | { call: true }
  | { call: false; reason: "daily_cap" | "unasked_cap" | "cooldown" | "owner_active" };

/**
 * Decides whether this turn may cost a model call. The daily cap holds even
 * for mentions (it protects the owner's quota), and unasked turns get only
 * half of it, so a chatty group cannot use up the answers to mentions. An
 * unasked turn also waits out a cooldown after the last unasked turn or reply,
 * and stays silent while the owner is talking himself.
 */
/** What unasked turns and debates may use of the daily cap: half, the rest stays for mentions. */
export const unaskedCap = (dailyCalls: number): number => Math.floor(dailyCalls / 2);

export function replyGate(input: GateInput): GateVerdict {
  const { direct, now, callsToday, lastAvatarAt, lastUnaskedAt, lastOwnerAt, limits } = input;
  if (callsToday >= limits.dailyCalls) return { call: false, reason: "daily_cap" };
  if (direct) return { call: true };
  if (callsToday >= unaskedCap(limits.dailyCalls)) {
    return { call: false, reason: "unasked_cap" };
  }
  if (lastOwnerAt !== null && now - lastOwnerAt < limits.cooldownMs) {
    return { call: false, reason: "owner_active" };
  }
  const lastTurn = Math.max(lastAvatarAt ?? -Infinity, lastUnaskedAt ?? -Infinity);
  if (now - lastTurn < limits.cooldownMs) return { call: false, reason: "cooldown" };
  return { call: true };
}
