import type { MenuAction, ProviderName, CallbackKind } from "../enums.js";

/**
 * Shared types of the bot module. Pure declarations only — keyboards, renders
 * and handlers live in their own modules (mirrors health/types.ts).
 */

/** Extra wiring the entrypoint supplies (kept optional so callers/tests can omit it). */
export interface BotOptions {
  /** Next scheduled cron run, for /health. Defaults to "unknown". */
  nextRun?: () => Date | null;
}

/** One bot command: its slash name, the human title, and a one-line description. */
export interface CommandSpec {
  /** Slash command without the leading "/". */
  command: string;
  /** Short title for the inline button (omitted → no button, /help-only). */
  buttonTitle?: string;
  /** The MenuAction a button tap maps to (omitted → no button). */
  action?: MenuAction;
  /** One-line description for /help and the native Telegram command list. */
  description: string;
}

/** A button: a label and the callback data it carries. */
export interface ButtonSpec {
  text: string;
  data: string;
}

/** A decoded /model inline-button callback, or null when data isn't ours. */
export type ParsedCallback =
  | { kind: CallbackKind.Provider; provider: ProviderName }
  | { kind: CallbackKind.Model; provider: ProviderName; model: string }
  | { kind: CallbackKind.Reset }
  | { kind: CallbackKind.Back }
  | { kind: CallbackKind.MockOn }
  | { kind: CallbackKind.MockOff }
  | null;

/**
 * A loaded, ready-to-publish extraction for a candidate, discriminated by kind.
 * `title` is the label shown in the "✅ Опубликовано: …" confirmation; `publish`
 * runs the kind-appropriate POST (/api/post/new for news, /api/changelog/new for
 * release) and returns the created id.
 */
export interface LoadedExtraction {
  title: string;
  publish: () => Promise<string>;
}
