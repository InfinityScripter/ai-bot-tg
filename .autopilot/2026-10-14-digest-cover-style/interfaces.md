# Границы

## Границы, решённые в спецификации

Единственный модуль — `src/blog/renderCover.ts`.

- **Отдаёт наружу (не меняется):** `coverSvg(spec: CoverSpec): string`,
  `renderCover(spec): Uint8Array`, `tryRenderCover(spec): Uint8Array | null`,
  `coverSpecFor(dress, fallbackTitle, now?)`, `wrapTitle(...)`, тип `CoverSpec`.
  Вызывают: `src/blog/crossPost.ts`, `src/channelDigest/assembleIssue.ts` — их не трогать.
- **Прячет:** палитру, раскладку, чтение аватарки (`assets/brand/channel-avatar.jpg`)
  и шрифтов.
- **Шов для тестов:** `coverSvg` (строка SVG) и `renderCover` (PNG) —
  `tests/render-cover.test.ts`.

## Правила проекта
- Тексты для пользователя — по-русски; код, комментарии и коммиты — по-английски
  (CLAUDE.md).
- `npm run ts`, `npm run lint`, `npm run fm:check`, `npm test` должны быть зелёными;
  `max-lines` в eslint — ошибка.
- Не пересобирать `package-lock.json`: адреса пакетов должны остаться на
  `registry.npmjs.org`.
- README.md — главный документ проекта; если там описан вид обложки, обновить.

## Как запускать
- Стек: Node + TypeScript (ESM, `tsx`), тесты — vitest. Зависимости уже стоят (`npm ci`).
- Одна проверка всего: `npm run ts && npm run lint && npm run fm:check && npm test`
- Один файл тестов: `npx vitest run tests/render-cover.test.ts`
- Не трогать: `package.json`, `package-lock.json`, вызывающих (`src/blog/crossPost.ts`,
  `src/channelDigest/*`), старые документы в `docs/superpowers/`.
