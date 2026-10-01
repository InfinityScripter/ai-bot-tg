import { CONFIG } from "../config.js";

import type { IssueSlot } from "./types.js";

/** The crons fire at 11:00 and 19:00: anything before 15:00 is the morning issue. */
const EVENING_FROM_HOUR = 15;

/** The issue a moment belongs to, in CRON_TZ: "2026-10-01/morning", «AI за утро · 1 октября». */
export function issueSlot(now: number, timeZone: string = CONFIG.CRON_TZ): IssueSlot {
  const at = new Date(now);
  const date = new Intl.DateTimeFormat("en-CA", { timeZone }).format(at);
  const hour = Number(
    new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", hourCycle: "h23" }).format(at),
  );
  const dayMonth = new Intl.DateTimeFormat("ru-RU", {
    timeZone,
    day: "numeric",
    month: "long",
  }).format(at);
  const morning = hour < EVENING_FROM_HOUR;
  return {
    key: `${date}/${morning ? "morning" : "evening"}`,
    title: `AI за ${morning ? "утро" : "вечер"} · ${dayMonth}`,
  };
}

/** Slot keys in time order: the evening issue comes after the morning one of the same day. */
const slotRank = (key: string) => key.replace("/morning", "/0").replace("/evening", "/1");

/** True when `key` is an earlier issue than the one `now` falls in. */
export function isPastSlot(key: string, now: number): boolean {
  return slotRank(key) < slotRank(issueSlot(now).key);
}

const NEWS_FORMS: Partial<Record<Intl.LDMLPluralRule, string>> = { one: "новость", few: "новости" };

/** "1 новость", "3 новости", "6 новостей": the cover's fact line and the owner's notes. */
export function newsCount(n: number): string {
  return `${n} ${NEWS_FORMS[new Intl.PluralRules("ru").select(n)] ?? "новостей"}`;
}
