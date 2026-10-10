import { CONFIG } from "../config.js";
import { CandidateKind } from "../enums.js";
import { WhenResetSchema } from "../schemas/whenresetSchema.js";

import type { FeedItem } from "../types.js";

class WhenResetReadError extends Error {}

/** Complete history, not latest.json: several resets can arrive between ticks. */
export async function readWhenReset(): Promise<FeedItem[]> {
  try {
    const response = await fetch("https://whenreset.app/api/v1/resets.json", {
      signal: AbortSignal.timeout(CONFIG.WHENRESET_TIMEOUT_MS),
      redirect: "error",
      headers: { Accept: "application/json" },
    });
    if (!response.ok) throw new WhenResetReadError(`WhenReset: HTTP ${response.status}.`);
    const snapshot = WhenResetSchema.parse(await response.json());
    const items: FeedItem[] = [];
    for (const product of ["codex", "claude"] as const) {
      const name = product === "codex" ? "Codex" : "Claude";
      for (const event of snapshot.products[product].events) {
        const page = new URL(event.page);
        if (
          page.origin !== "https://whenreset.app" ||
          page.pathname !== `/${product}/${event.date}/` ||
          page.search ||
          page.hash
        )
          throw new Error("Unexpected event page");
        // Future event types/kinds are not silently presented as confirmed resets.
        if (event.type !== "reset" || !["regular", "banked"].includes(event.kind)) continue;
        const label = event.kind === "banked" ? "резервном сбросе" : "сбросе лимитов";
        items.push({
          dedupKey: `whenreset:${product}:${event.id}`,
          url: event.page,
          title: `${name}: сообщение о ${label}`,
          feedTitle: "WhenReset",
          snippet: [
            `WhenReset добавил сообщение о ${label} ${name}. Дата сообщения: ${event.date}.`,
            `Охват по данным источника: ${event.scope}.`,
            `Оригинальное сообщение (непроверенный текст источника):\n${event.summary}`,
            event.delivered_at
              ? `WhenReset указывает время доставки: ${event.delivered_at}. ${event.delivery_note_en ?? ""}`
              : "API не содержит времени доставки сброса.",
            "Эта запись не подтверждает восстановление лимита конкретного аккаунта. Сообщение может описывать будущие планы; прогноз не означает выполненный сброс.",
            `Официальное сообщение: ${event.url}`,
            ...(event.delivered_source_url
              ? [`Источник сведений о доставке: ${event.delivered_source_url}`]
              : []),
            `Запись WhenReset: ${event.page}`,
            `Архив: https://${product}-resets.com`,
          ].join("\n\n"),
          publishedAt: Date.parse(event.ts ?? `${event.date}T00:00:00Z`),
          imageUrl: null,
          imageUrls: [],
          kind: CandidateKind.News,
        });
      }
    }
    return items.sort((a, b) => (a.publishedAt ?? 0) - (b.publishedAt ?? 0));
  } catch (err) {
    if (err instanceof WhenResetReadError) throw err;
    // Never echo response bodies, validation inputs or error URLs to logs/DMs.
    throw new WhenResetReadError("WhenReset: API недоступен или ответ не прошёл проверку.");
  }
}
