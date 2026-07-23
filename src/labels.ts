/** UI-строки для сообщений бота и команд. */

/** Строки статуса сбора (возвращаются из runCollection в index.ts). */
export const COLLECTION_LABELS = {
  filterBlocked: (fetched: number) =>
    `⚠️ Фильтр отсёк все ${fetched} новостей — проверьте FILTER_INCLUDE/FILTER_EXCLUDE.`,
  noNews: (fetched: number) => `Новых новостей нет (получено ${fetched}).`,
  done: (fresh: number, published: number, failed: number) =>
    `Готово: новых ${fresh}, опубликовано ${published}${failed ? `, ошибок ${failed}` : ""}.`,
} as const;

/** Строки уведомлений о сбоях (отправляются владельцу из scheduledRun). */
export const NOTIFY_LABELS = {
  scheduledRunFailed: (err: unknown) =>
    `⚠️ Ежедневный сбор новостей упал с ошибкой:\n${String(err)}`,
} as const;
