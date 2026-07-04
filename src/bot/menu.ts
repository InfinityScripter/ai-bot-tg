import { InlineKeyboard } from "grammy";

import { MenuAction } from "../enums.js";
import { MENU_CALLBACK } from "../consts.js";

import type { CommandSpec } from "./types.js";

/**
 * The single source of truth for the bot's commands. /help renders from it, the
 * inline menu builds buttons from the entries that carry an action, and the
 * native Telegram command list (setMyCommands) is derived from it too — so all
 * three can never drift.
 */
export const COMMANDS: CommandSpec[] = [
  {
    command: "menu",
    buttonTitle: undefined,
    description: "показать меню с кнопками",
  },
  {
    command: "fetch",
    buttonTitle: "📰 Собрать новости",
    action: MenuAction.Fetch,
    description: "запустить сбор новостей сейчас (как ежедневный крон)",
  },
  {
    command: "model",
    buttonTitle: "🤖 Модель",
    action: MenuAction.Model,
    description: "выбрать провайдер/модель для рерайта, вкл/выкл mock",
  },
  {
    command: "digest",
    buttonTitle: undefined,
    description: "собрать и отправить еженедельный email-дайджест подписчикам",
  },
  {
    command: "health",
    buttonTitle: "🩺 Проверка",
    action: MenuAction.Health,
    description: "проверка: процесс, расписание, LLM, блог API, очередь",
  },
  {
    command: "help",
    buttonTitle: "❓ Помощь",
    action: MenuAction.Help,
    description: "список всех команд и что они делают",
  },
  {
    command: "ping",
    buttonTitle: undefined,
    description: "быстрая проверка живости (pong)",
  },
];

/** The /help text: every command and what it does. */
export function helpText(): string {
  const rows = COMMANDS.map((c) => `/${c.command} — ${c.description}`);
  return [
    "📋 *Команды бота*",
    "",
    ...rows,
    "",
    "Также можно прислать ссылку или текст — переработаю в пост.",
  ].join("\n");
}

/** The intro shown by /start and /menu, above the button keyboard. */
export function menuIntro(): string {
  return "Новостной бот на связи. Выберите действие или пришлите ссылку/текст для публикации.";
}

/** The inline keyboard of command buttons (one per actionable command). */
export function menuKeyboard(): InlineKeyboard {
  const kb = new InlineKeyboard();
  for (const c of COMMANDS) {
    if (c.action && c.buttonTitle) kb.text(c.buttonTitle, `${MENU_CALLBACK}${c.action}`).row();
  }
  return kb;
}

/** The list registered with Telegram (setMyCommands) — drives the blue Menu button. */
export function nativeCommands(): { command: string; description: string }[] {
  return COMMANDS.map((c) => ({ command: c.command, description: c.description }));
}

/** Parses a menu-button callback into its MenuAction, or null if not a menu tap. */
export function parseMenuCallback(data: string): MenuAction | null {
  if (!data.startsWith(MENU_CALLBACK)) return null;
  const value = data.slice(MENU_CALLBACK.length);
  return (Object.values(MenuAction) as string[]).includes(value) ? (value as MenuAction) : null;
}
