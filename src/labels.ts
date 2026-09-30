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
  catalogImportFailed: (err: unknown) =>
    `⚠️ Импорт каталога моделей упал с ошибкой:\n${String(err)}`,
  releaseWatchFailed: (err: unknown) =>
    `⚠️ Проверка фидов на релизы моделей упала с ошибкой (повторю молча до первого успеха):\n${String(err)}`,
  channelWatchFailed: (err: unknown) =>
    `⚠️ Проход по AI-каналам упал с ошибкой (повторю молча до первого успеха):\n${String(err)}`,
  channelIssueFailed: (err: unknown) =>
    `⚠️ Выпуск дайджеста каналов упал с ошибкой (пока выпуски падают подряд, повторно писать не буду):\n${String(err)}`,
} as const;
