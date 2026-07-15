# ai-bot-tg — новостной AI-бот для блога

Автономный Telegram-бот, который раз в день собирает новости из проверенных
RSS-лент, присылает владельцу **сырые** карточки в личку и по нажатию кнопки
переписывает выбранную новость в уникальный пост активной LLM-моделью
(любой из настроенных провайдеров — GLM, DeepSeek, OpenRouter, Claude,
Gemini, см. `/model`). После подтверждения пост публикуется в блог
(`aifirst.us.com`) от имени владельца. Рерайт запускается **по требованию, в
момент публикации** — токены тратятся только на новости, которые владелец
решил обработать.

Рерайт — не нейтральный пересказ. Промпт работает в голосе Михаила как
инженера-практика: выбирает один редакторский угол, ставит читательскую ставку в
заголовок и начало, сохраняет первое лицо в авторских черновиках и отделяет
проверенные факты от PR. Перед публикацией production-финализатор разбирает
Markdown в AST, удаляет HTML и оставляет только ссылки и картинки из исходника.
Prompt eval ловит шаблонные тексты, новые числа/цитаты и потерю авторского голоса.

Помимо новостей бот умеет:

- **Релизы AI-моделей** — новость-анонс (OpenAI выпустила…, Anthropic
  announces…) распознаётся по маркерам, из неё извлекается структурированная
  запись (вендор, модель, версия, цены, контекст) и публикуется в changelog
  блога — тоже после ручного подтверждения.
- **Еженедельный e-mail-дайджест** (`/digest`) — собирает посты за неделю,
  строит письмо через LLM, ждёт вердикт владельца и рассылает подтверждённым
  подписчикам.
- **Ручной ввод** — владелец кидает боту ссылку или текст, и материал идёт по
  тому же конвейеру рерайта и публикации.

```
croner (ежедневно) ─► RSS-фиды ──┐
владелец шлёт URL / текст ───────┼─► keyword-фильтр ─► фильтр релевантности
                                 │        (FILTER_*)     (off/shadow/on)
                                 ▼
                     dedup (SQLite) ─► RAW-кандидат (news | release)
                                 │
                                 ▼
     ЛС в Telegram (RAW): заголовок + сниппет + [🔄 Переработать] [❌ Пропустить]
                                 │   владелец жмёт 🔄 — активная модель (/model)
                                 ▼
     ЛС (PREVIEW): готовый пост / карточка релиза + модель
                   [🔄 Заново] [✅ Опубликовать] [❌ Пропустить]
                                 │   владелец жмёт ✅
                                 ▼
        news    → POST {BLOG_API_URL}/api/post/new       (Bearer BOT_API_TOKEN)
        release → POST {BLOG_API_URL}/api/changelog/new  (Bearer BOT_API_TOKEN)
```

Бот общается с блогом только по HTTP API и владеет только своим состоянием —
одним SQLite-файлом (dedup-леджер + жизненный цикл кандидатов + runtime-настройки).

## Стек

- [grammY](https://grammy.dev) — Telegram-бот (long polling)
- [rss-parser](https://www.npmjs.com/package/rss-parser) — чтение RSS/Atom
- [@anthropic-ai/sdk](https://www.npmjs.com/package/@anthropic-ai/sdk) — путь Claude;
  остальные провайдеры (Gemini/GLM/DeepSeek/OpenRouter) ходят по
  OpenAI-совместимому chat-completions через `fetch`, без SDK
- [croner](https://www.npmjs.com/package/croner) — ежедневное расписание
- [better-sqlite3](https://www.npmjs.com/package/better-sqlite3) — хранилище
- [zod](https://zod.dev) — валидация env и структурированных ответов LLM
- TypeScript, запуск через [tsx](https://www.npmjs.com/package/tsx) (без сборки)

## Структура проекта — что за что отвечает

```
src/
├── index.ts          # entrypoint: собирает store + бот + крон + control server
├── config.ts         # загрузка env через zod-схему; экспортирует CONFIG
├── enums.ts          # доменные string-enum'ы (состояния, провайдеры, режимы)
├── consts.ts         # префиксы callback-данных Telegram-кнопок
├── types.ts          # доменные интерфейсы: FeedItem, Candidate, тела POST'ов
├── labels.ts         # строки статусов/уведомлений владельцу
├── utils.ts          # canonicalizeUrl/dedupKey, stripHtml, truncate, escapeMarkdown
├── auditEmit.ts      # зеркалирование решений фильтра в audit-log бэкенда
├── schemas/          # zod-схемы: envSchema, rewriteSchema, releaseSchema
├── bot/              # весь Telegram-слой
│   ├── createBot.ts       # фабрика бота: команды, owner-lock, роутинг callback'ов
│   ├── createHandlers.ts  # кнопки карточек: rewrite / publish / skip
│   ├── createIngest.ts    # ручной ввод (URL/текст) + уведомления после сбоя
│   ├── candidateActions.ts# ветвление news/release: extraction + publish
│   ├── digestFlow.ts      # флоу /digest: превью → вердикт → рассылка
│   ├── digestVerdict.ts   # плейсхолдер {{ВЕРДИКТ}} и его заполнение
│   ├── menu.ts            # единый список команд: /help, кнопки, setMyCommands
│   ├── modelMenu.ts       # интерактив /model (пинг модели перед сохранением)
│   ├── modelPick.ts       # кодек callback-данных /model, кнопки, статус
│   ├── keyboards.ts       # inline-клавиатуры карточек
│   ├── render.ts / renderRelease.ts  # тексты RAW/PREVIEW карточек
│   ├── edit.ts            # безопасные ack/edit (Telegram любит кидать 400)
│   ├── autoRetry.ts       # ретраи 429/5xx Telegram API (vendored auto-retry)
│   └── types.ts           # общие типы модуля
├── feeds/            # получение контента
│   ├── defaultFeeds.ts    # список RSS по умолчанию + override RSS_FEEDS
│   ├── parseFeed.ts       # rss-parser → нормализованные FeedItem
│   ├── fetchAllFeeds.ts   # обход всех фидов (изоляция сбоев) + og:image
│   ├── fetchHtml.ts       # общий GET с таймаутом и капом байт
│   ├── fetchArticleBody.ts# дотягивание полного текста перед рерайтом
│   ├── ingestArticle.ts   # скрейп страницы по ссылке владельца → FeedItem
│   ├── scrapeOgImage.ts   # обложка из og:image / twitter:image
│   ├── collectImages.ts   # сбор картинок статьи (обложка + <img> из тела)
│   ├── curateQueue.ts     # keyword-фильтры + сортировка очереди
│   └── types.ts
├── llm/              # всё про модели
│   ├── providers.ts       # реестр провайдеров: URL, ключи, дефолтные модели
│   ├── chatCompletion.ts  # ЕДИНОЕ ядро вызова (Anthropic SDK / OpenAI-compat)
│   ├── prompts.ts         # все системные промпты и сборка user-сообщений
│   ├── rewriteToPost.ts   # новость → пост (+mock-режим без LLM)
│   ├── sanitizeMarkdown.ts # AST allow-list для ссылок/картинок, запрет HTML
│   ├── extractRelease.ts  # анонс → структурированный релиз (анти-галлюцинации)
│   ├── buildDigest.ts     # посты недели → письмо дайджеста
│   ├── classifyRelevance.ts / filterRelevant.ts  # фильтр релевантности (0–4)
│   ├── relevanceMarkers.ts / releaseMarkers.ts   # keyword-маркеры (данные)
│   ├── modelRegistry.ts   # listModels (live + fallback) и pingModel
│   ├── modelPrices.ts     # ценники моделей для кнопок/панели (данные)
│   └── types.ts
├── store/            # SQLite-хранилище
│   ├── CandidateStore.ts  # фасад: dedup, lifecycle, восстановление после краша
│   ├── candidateSchema.ts # DDL, миграции, ключи настроек, маппинг строки
│   ├── candidateMutations.ts # атомарные переходы состояний (claim/attach/…)
│   ├── storeSettings.ts   # runtime-переопределения модели и mock
│   └── types.ts
├── blog/             # HTTP-клиент блога
│   ├── publishPost.ts     # POST /api/post/new (+PublishError с maybePosted)
│   ├── publishRelease.ts  # POST /api/changelog/new
│   ├── sendDigest.ts      # POST /api/newsletter/send
│   ├── fetchRecentPosts.ts# GET /api/post/list для дайджеста
│   ├── normalizeTags.ts   # белый список тегов
│   ├── defaultCovers.ts   # дефолтные обложки по темам (подбор по тегам поста)
│   └── types.ts
├── health/           # /health и проверка моделей
│   ├── collectHealth.ts   # отчёт готовности: процесс, крон, LLM, блог, очередь
│   ├── probeChecks.ts     # отдельные пробы
│   ├── probeModels.ts     # пинг дефолтной модели каждого control-провайдера
│   ├── renderHealth.ts    # рендер отчёта в Telegram-Markdown
│   └── types.ts
├── server/           # инфраструктура процесса
│   ├── runCollection.ts   # один цикл сбора (fetch→фильтры→dedup→карточки)
│   ├── scheduler.ts       # ежедневный крон (croner)
│   ├── controlServer.ts   # localhost HTTP API для админки блога
│   └── types.ts
└── cli/
    ├── runCollection.ts   # npm run fetch — разовый сбор без polling
    └── testModels.ts      # npm run test:models — доступность провайдеров с хоста
```

Конвенции: один модуль ≤ 200 строк кода (ESLint `max-lines`, error);
доменные строковые значения — только через enum'ы из `src/enums.ts`;
общие типы модуля — в его `types.ts`; чистые данные (маркеры, цены, фиды) —
в отдельных файлах; zod-валидация — в `src/schemas/`; имена файлов camelCase.

## Жизненный цикл кандидата

```
collected ──🔄──► rewriting ──► pending_review ──✅──► publishing ──► published
    │                │                │                    │
    │                ▼                │ 🔄 заново          ▼ (сбой)
    │          rewrite_failed ◄──── (ошибка)        publish_failed → pending_review
    │                │ 🔄 retry                           │ (может быть опубликован)
    └──❌──► skipped ◄────────────────────────────  needs_verification
```

`needs_verification` — упали посреди публикации: POST мог дойти. На старте бот
предупреждает владельца, чтобы тот проверил блог перед повторной публикацией
(защита от дублей). Двойные нажатия кнопок отсекаются атомарными UPDATE'ами
(`claimForPublishing` / `claimForRewriting`) — задвоить пост или рерайт нельзя.

## Команды бота (только для владельца)

| Команда           | Что делает                                                                                                                                  |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `/start`, `/menu` | меню с кнопками (Собрать новости / Модель / Проверка / Помощь)                                                                              |
| `/help`           | список команд; тот же список в нативной кнопке Menu                                                                                         |
| `/fetch`          | запустить цикл сбора сейчас (как ежедневный крон)                                                                                           |
| `/model`          | сменить провайдера/модель на лету; пингует модель перед сохранением; переключатель 🧪 Mock (публикация копии без LLM); «↩️ Сбросить на env» |
| `/digest`         | собрать e-mail-дайджест за неделю → превью → вердикт → рассылка                                                                             |
| `/health`         | готовность: процесс, следующий запуск, активная LLM (live-пинг), блог API, очередь                                                          |
| `/ping`           | `pong` — быстрая проверка живости                                                                                                           |
| ссылка/текст      | ручной кандидат: URL скрейпится, текст берётся как статья                                                                                   |

Выбор модели и mock-переключатель хранятся в SQLite и переживают рестарт;
значение из БД имеет приоритет над env (`REWRITE_MOCK`/`REWRITE_PROVIDER`).

## Фильтры очереди

1. **Keyword-фильтр** (`FILTER_INCLUDE` / `FILTER_EXCLUDE`) — бесплатный CSV по
   подстрокам заголовка+сниппета; exclude сильнее include.
2. **Фильтр релевантности** (`RELEVANCE_MODE`) — тематический (AI/tech):
   blocklist-маркеры → мгновенный drop; on-topic-маркеры → мгновенный keep;
   иначе один дешёвый LLM-запрос со шкалой 0–4 (`RELEVANCE_THRESHOLD`).
   Режимы: `off` — выключен; `shadow` (дефолт) — только логирует решения;
   `on` — реально отбрасывает. Любая ошибка классификатора = keep (fail-open).
   Решения зеркалируются в audit-log бэкенда (`RELEVANCE_AUDIT`).

## Admin control server (опционально)

При заданном `BOT_CONTROL_TOKEN` бот поднимает **localhost-only** HTTP-сервер
(`127.0.0.1:CONTROL_PORT`, по умолчанию 8455), через который co-located бэкенд
блога управляет моделью без Telegram. Каждый запрос — `Authorization: Bearer
<BOT_CONTROL_TOKEN>` (сравнение constant-time). Без токена сервер не
стартует; занятый порт отключает только панель, но не новостной конвейер.

| Метод и путь                           | Что делает                                                            |
| -------------------------------------- | --------------------------------------------------------------------- |
| `GET /control/status`                  | активные `{provider, model, isMockEnabled}`                           |
| `GET /control/providers`               | доступные панели провайдеры (glm/deepseek/openrouter) + наличие ключа |
| `GET /control/models?provider=`        | список моделей провайдера с ценовыми пометками                        |
| `GET /control/models/health`           | пинг дефолтной модели каждого control-провайдера                      |
| `POST /control/model {provider,model}` | пинг → сохранить override (сбрасывает mock)                           |
| `POST /control/mock {enabled}`         | переключить mock-режим                                                |

## Настройка

```bash
npm install
cp .env.example .env   # заполнить значения
```

Обязательные переменные (полный список с комментариями — в `.env.example`):

| Переменная           | Что это                                                                                                                                         |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `TELEGRAM_BOT_TOKEN` | токен от @BotFather                                                                                                                             |
| `OWNER_TELEGRAM_ID`  | числовой chat id владельца (только он управляет ботом)                                                                                          |
| `BLOG_API_URL`       | база API блога (`http://localhost:7272` дев, `https://api.aifirst.us.com:8444` прод)                                                            |
| `BOT_API_TOKEN`      | общий секрет — **должен совпадать** с `BOT_API_TOKEN` бэкенда                                                                                   |
| ключ провайдера      | `GLM_API_KEY` / `DEEPSEEK_API_KEY` / `OPENROUTER_API_KEY` / `ANTHROPIC_API_KEY` / `GEMINI_API_KEY` — какой требует выбранный `REWRITE_PROVIDER` |

Ключевые опции: `REWRITE_PROVIDER` (glm/deepseek/openrouter/anthropic/gemini/mock),
`REWRITE_TEMPERATURE`, `REWRITE_MAX_TOKENS`, `MAX_PER_RUN`, `CRON_SCHEDULE`/`CRON_TZ`,
`RSS_FEEDS` (полная замена дефолтного списка), `SQLITE_PATH`.

## Запуск и разработка

```bash
npm run dev          # бот с автоперезапуском (tsx watch)
npm start            # бот без перезапуска
npm run fetch        # разовый сбор из шелла и выход (без polling)
npm run test:models  # какие провайдеры доступны с этого хоста (гео/сеть)

npm test             # vitest (371 тест; сеть замокана, ключи не нужны)
npm run ts           # tsc --noEmit
npm run lint         # eslint (airbnb-base + perfectionist, max-lines=200)
npm run fm:fix       # prettier
```

Проверка end-to-end руками: поднять бэкенд блога на `:7272` (с `BOT_API_TOKEN`
и `OWNER_EMAIL`), `npm run dev`, в Telegram `/fetch` → 🔄 на карточке → ✅ —
пост появляется в блоге.

## Деплой

**Работает в проде** на той же VDS, что и блог (systemd-юнит `blog-newsbot`,
`node --import tsx src/index.ts`, без сборки). Push в `main` деплоит
автоматически через GitHub Actions.

- **[deploy/RUNBOOK.md](deploy/RUNBOOK.md)** — воспроизводимый рецепт: CI-секреты,
  первый ручной деплой, проверка, откат. Читать перед настройкой CI заново.
- **[deploy/DEPLOY.md](deploy/DEPLOY.md)** — точные env-ключи, systemd-юнит, справка CI.
- **[deploy/CLEANUP.md](deploy/CLEANUP.md)** — забитый диск VDS: безопасная очистка
  (`vds-cleanup.sh`, dry-run по умолчанию) и профилактика «поставил и забыл»
  (`vds-cleanup-install.sh`: еженедельная авточистка + ежедневная проверка диска
  с алертом владельцу в Telegram + лимит журнала systemd).

Историческая документация решений — в `docs/` (планы и спеки фич по датам).
