import { CONFIG } from "../config.js";

/** A public Telegram channel the bot retells from. */
export interface SourceChannel {
  /** Username without "@", as in https://t.me/s/<name>. */
  name: string;
  /** Priority channels are considered before all others (owner's choice). */
  priority: boolean;
}

/** The owner's list, 2026-09-30. All 12 verified public and readable that day. */
export const DEFAULT_CHANNELS: SourceChannel[] = [
  { name: "ai_for_devs", priority: true },
  { name: "sukharev_ii", priority: true },
  { name: "aostrikov_ai_agents", priority: true },
  { name: "aimastersme", priority: true },
  { name: "llm_under_hood", priority: false },
  { name: "abstractDL", priority: false },
  { name: "NeuralProfit", priority: false },
  { name: "devfm", priority: false },
  { name: "pomazkovjs", priority: false },
  { name: "ituzov_fun", priority: false },
  { name: "defendend_ai_dev", priority: false },
  { name: "shilovtech", priority: false },
];

/** Parses TG_SOURCE_CHANNELS: CSV of names, "@" optional, a leading "!" marks priority. */
export function parseChannelList(csv: string): SourceChannel[] {
  return csv
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const priority = entry.startsWith("!");
      return { name: entry.replace(/^!/, "").replace(/^@/, "").trim(), priority };
    })
    .filter((c) => c.name.length > 0);
}

/** The env override replaces the whole list; unset → DEFAULT_CHANNELS. */
export function resolveChannels(): SourceChannel[] {
  return CONFIG.TG_SOURCE_CHANNELS ? parseChannelList(CONFIG.TG_SOURCE_CHANNELS) : DEFAULT_CHANNELS;
}
