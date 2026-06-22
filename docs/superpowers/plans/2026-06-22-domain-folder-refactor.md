# Domain Folder Refactor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reorganise `src/` into domain folders (`bot/`, `llm/`, `feeds/`, `store/`, `health/`, `core/`) and split the 5 files with mixed responsibilities into focused single-purpose modules.

**Architecture:** Each domain folder owns all files for that concern; an `index.ts` barrel re-exports the public API so external callers keep their import paths short. Files that already have clean responsibilities are moved as-is; only the 5 problem files get split on the way.

**Tech Stack:** TypeScript ESM (`"type": "module"`), Node 20, no test framework currently present.

---

## Target file layout

```
src/
  bot/
    handlers.ts          ← bot-handlers.ts (no split needed — logic is already cohesive)
    ingest.ts            ← bot-ingest.ts
    keyboards.ts         ← bot-keyboards.ts
    menu.ts              ← bot-menu.ts
    model-menu.ts        ← bot-model-menu.ts
    model.ts             ← bot-model.ts
    render.ts            ← bot-render.ts
    edit.ts              ← bot-edit.ts
    index.ts             ← re-exports: createBot, createHandlers, createIngest, sendRawCard, ...
  llm/
    prompts.ts           ← NEW: SYSTEM_PROMPT + buildUserContent extracted from rewriter.ts
    rewriter.ts          ← rewriter.ts (mock + provider dispatch + sanitize; imports prompts)
    relevance-classify.ts← relevance-classify.ts (unchanged; already uses prompts inline)
    relevance-markers.ts ← relevance-markers.ts
    relevance.ts         ← relevance.ts
    models.ts            ← models.ts
    providers.ts         ← providers.ts
    index.ts             ← re-exports: rewriteToPost, classifyRelevance, filterRelevance, ...
  feeds/
    parser.ts            ← NEW: DEFAULT_FEEDS, resolveFeeds, parser instance, mapFeed, extractImageUrl, extractImageUrls
    scraper.ts           ← NEW: fetchOgImage, IMG_SRC_RE, OG_IMAGE_RE, OG_IMAGE_RE_ALT
    fetch.ts             ← NEW: fetchAllFeeds (orchestrator; imports parser + scraper)
    ingest.ts            ← ingest.ts (classifyInput, fetchArticle, feedItemFromText; imports scraper for regex)
    index.ts             ← re-exports: fetchAllFeeds, fetchArticle, feedItemFromText, classifyInput, DEFAULT_FEEDS
  store/
    store.ts             ← store.ts
    mutations.ts         ← store-mutations.ts
    settings.ts          ← store-settings.ts
    schema.ts            ← store-schema.ts
    index.ts             ← re-exports: CandidateStore
  health/
    types.ts             ← NEW: HealthCheck, HealthReport, HealthDeps interfaces
    checks.ts            ← NEW: checkProvider, checkBlog, formatUptime
    collect.ts           ← NEW: collectHealth
    render.ts            ← NEW: ATTENTION_STATES, renderHealth
    index.ts             ← re-exports: collectHealth, renderHealth + types
  core/
    config.ts            ← config.ts
    enums.ts             ← enums.ts
    types.ts             ← types.ts
    consts.ts            ← consts.ts
    utils.ts             ← utils.ts
    curate.ts            ← curate.ts
    tags.ts              ← tags.ts
    scheduler.ts         ← scheduler.ts
    auto-retry.ts        ← auto-retry.ts
    index.ts             ← re-exports all public symbols
  schemas/               ← stays flat (already clean)
  cli/                   ← stays flat (entrypoints)
  bot.ts                 ← stays at root (createBot wires everything)
  collector.ts           ← stays at root (orchestrator)
  control-server.ts      ← stays at root (HTTP server)
  index.ts               ← stays at root (main entrypoint)
```

**Key split decisions:**
- `feeds.ts` → `feeds/parser.ts` + `feeds/scraper.ts` + `feeds/fetch.ts`
  - `parser.ts`: RSS parser setup, DEFAULT_FEEDS, resolveFeeds, mapFeed, extractImageUrl, extractImageUrls
  - `scraper.ts`: shared regex constants (IMG_SRC_RE, OG_IMAGE_RE, OG_IMAGE_RE_ALT), fetchOgImage
  - `fetch.ts`: fetchAllFeeds (orchestrator that calls parser + scraper)
- `rewriter.ts` → `llm/prompts.ts` + `llm/rewriter.ts`
  - `prompts.ts`: SYSTEM_PROMPT, buildUserContent
  - `rewriter.ts`: mockRewrite, rewriteWithAnthropic, rewriteWithOpenAICompat, finalizeRewrite, rewriteToPost
- `health.ts` → `health/types.ts` + `health/checks.ts` + `health/collect.ts` + `health/render.ts`
- `bot-handlers.ts` — kept as `bot/handlers.ts` (the 260 lines is cohesive domain logic, not mixed responsibilities)
- `ingest.ts` (261 lines scraper) → `feeds/ingest.ts` (same content, new home; regex imported from `feeds/scraper.ts`)

---

## Task 1: Create domain folder skeletons

**Files:**
- Create: `src/bot/.gitkeep`
- Create: `src/llm/.gitkeep`
- Create: `src/feeds/.gitkeep`
- Create: `src/store/.gitkeep`
- Create: `src/health/.gitkeep`
- Create: `src/core/.gitkeep`

- [ ] **Step 1: Create folder skeletons**

```bash
mkdir -p src/bot src/llm src/feeds src/store src/health src/core
```

Run from `/Users/talalaev-m/projects/ai-bot-tg`.

- [ ] **Step 2: Verify folders exist**

```bash
ls src/
```

Expected: `bot/  core/  feeds/  health/  llm/  store/` among others.

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "refactor: create domain folder skeletons"
```

---

## Task 2: Migrate `store/` domain

Move 4 clean files with zero splitting needed. Update their internal cross-references.

**Files:**
- Create: `src/store/schema.ts` ← copy of `src/store-schema.ts` with updated import paths
- Create: `src/store/mutations.ts` ← copy of `src/store-mutations.ts` with updated imports
- Create: `src/store/settings.ts` ← copy of `src/store-settings.ts` with updated imports
- Create: `src/store/store.ts` ← copy of `src/store.ts` with updated imports
- Create: `src/store/index.ts`
- Delete: `src/store-schema.ts`, `src/store-mutations.ts`, `src/store-settings.ts`, `src/store.ts`

- [ ] **Step 1: Create `src/store/schema.ts`**

Copy `src/store-schema.ts` verbatim — it has no internal cross-imports to update.

```bash
cp src/store-schema.ts src/store/schema.ts
```

- [ ] **Step 2: Create `src/store/mutations.ts`**

Copy `src/store-mutations.ts`, update its import of `store-schema.ts`:

In `src/store/mutations.ts` change:
```ts
// OLD
import { SCHEMA, MIGRATIONS, mapRow } from "./store-schema.js";
// NEW
import { SCHEMA, MIGRATIONS, mapRow } from "./schema.js";
```

- [ ] **Step 3: Create `src/store/settings.ts`**

Copy `src/store-settings.ts`, update its import of `store-schema.ts`:

```ts
// OLD
import { MODEL_OVERRIDE_KEY, MOCK_OVERRIDE_KEY } from "./store-schema.js";
// NEW
import { MODEL_OVERRIDE_KEY, MOCK_OVERRIDE_KEY } from "./schema.js";
```

- [ ] **Step 4: Create `src/store/store.ts`**

Copy `src/store.ts`, update its 3 internal imports:

```ts
// OLD
import { SCHEMA, MIGRATIONS, mapRow, ... } from "./store-schema.js";
import { recoverInFlight, claimForPublishing, ... } from "./store-mutations.js";
import { getRawSetting, setRawSetting, ... } from "./store-settings.js";
// NEW
import { SCHEMA, MIGRATIONS, mapRow, ... } from "./schema.js";
import { recoverInFlight, claimForPublishing, ... } from "./mutations.js";
import { getRawSetting, setRawSetting, ... } from "./settings.js";
```

- [ ] **Step 5: Create `src/store/index.ts`**

```ts
export { CandidateStore } from "./store.js";
export type { CandidateStore as CandidateStoreType } from "./store.js";
```

- [ ] **Step 6: Delete old files**

```bash
git rm src/store-schema.ts src/store-mutations.ts src/store-settings.ts src/store.ts
```

- [ ] **Step 7: Update all files that import from the old paths**

Search for all files that import from the old store paths and update them:

```bash
grep -rl '"./store\.js"\|"./store-schema\.js"\|"./store-mutations\.js"\|"./store-settings\.js"' src/
```

For each result, update the import path to `"../store/index.js"` or the specific sub-file as appropriate. The typical pattern for consumers is they import `CandidateStore` — update those to `"./store/index.js"` (for files at `src/` root level).

Files at `src/` root that import `CandidateStore`:
- `src/bot.ts` → `import type { CandidateStore } from "./store/index.js"`
- `src/bot-handlers.ts` → `import type { CandidateStore } from "./store/index.js"`
- `src/bot-ingest.ts` → `import type { CandidateStore } from "./store/index.js"`
- `src/bot-model-menu.ts` → `import type { CandidateStore } from "./store/index.js"`
- `src/collector.ts` → `import type { CandidateStore } from "./store/index.js"`
- `src/control-server.ts` → `import type { CandidateStore } from "./store/index.js"`
- `src/health.ts` → `import type { CandidateStore } from "./store/index.js"`
- `src/index.ts` → `import { CandidateStore } from "./store/index.js"`
- `src/providers.ts` → `import type { CandidateStore } from "./store/index.js"`
- `src/relevance-classify.ts` → `import type { CandidateStore } from "./store/index.js"`
- `src/rewriter.ts` → `import type { CandidateStore } from "./store/index.js"`
- `src/cli/run-collection.ts` → `import { CandidateStore } from "../store/index.js"`

- [ ] **Step 8: TypeScript check**

```bash
npx tsc --noEmit 2>&1 | head -40
```

Expected: 0 errors. Fix any path errors before proceeding.

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "refactor(store): migrate to src/store/ domain folder"
```

---

## Task 3: Extract `feeds/scraper.ts` (shared regex + fetchOgImage)

The regex constants `IMG_SRC_RE`, `OG_IMAGE_RE`, `OG_IMAGE_RE_ALT` and `fetchOgImage` are used by both `feeds.ts` and `ingest.ts`. Extract them first so both can import from one place.

**Files:**
- Create: `src/feeds/scraper.ts`

- [ ] **Step 1: Create `src/feeds/scraper.ts`**

```ts
/**
 * Regex patterns and lightweight HTTP scraping for image/meta extraction.
 * Used by both the RSS feed mapper and the manual-ingest article scraper.
 */

// Matches src="..." / src='...' inside an <img …> tag. Global for matchAll sweeps.
export const IMG_SRC_RE = /<img\b[^>]*?\bsrc\s*=\s*["']([^"']+)["'][^>]*>/gi;

/** Matches og:image / twitter:image (property/name before content). */
export const OG_IMAGE_RE =
  /<meta[^>]+(?:property|name)=["'](?:og:image|og:image:url|twitter:image)["'][^>]+content=["']([^"']+)["']/i;
/** Same, content before property/name (attribute order varies). */
export const OG_IMAGE_RE_ALT =
  /<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["'](?:og:image|og:image:url|twitter:image)["']/i;

/**
 * Fetches an article page and extracts its og:image (or twitter:image) URL.
 * Single GET, 8s timeout, reads only the first 64KB of HTML. Tolerant: any
 * failure (network, non-HTML, no tag) resolves to null.
 */
export async function fetchOgImage(url: string): Promise<string | null> {
  if (!url || !/^https?:\/\//i.test(url)) return null;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8_000);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { Accept: "text/html,application/xhtml+xml", "User-Agent": "blog-newsbot/1.0" },
    });
    if (!res.ok) return null;
    const type = res.headers.get("content-type") ?? "";
    if (type && !type.includes("html")) return null;
    const html = (await res.text()).slice(0, 64_000);
    const match = OG_IMAGE_RE.exec(html) ?? OG_IMAGE_RE_ALT.exec(html);
    const found = match?.[1]?.trim();
    if (found && /^https?:\/\//i.test(found)) return found;
    return null;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}
```

- [ ] **Step 2: Commit scraper module**

```bash
git add src/feeds/scraper.ts
git commit -m "refactor(feeds): extract scraper.ts (regex constants + fetchOgImage)"
```

---

## Task 4: Create `feeds/parser.ts` and `feeds/fetch.ts`

Split `src/feeds.ts` into:
- `feeds/parser.ts` — RSS parser config, DEFAULT_FEEDS, resolveFeeds, mapFeed helpers
- `feeds/fetch.ts` — fetchAllFeeds orchestrator

**Files:**
- Create: `src/feeds/parser.ts`
- Create: `src/feeds/fetch.ts`
- Delete: `src/feeds.ts`

- [ ] **Step 1: Create `src/feeds/parser.ts`**

```ts
import Parser from "rss-parser";

import { CONFIG } from "../config.js";
import { truncate, stripHtml, dedupKeyFor } from "../utils.js";
import { IMG_SRC_RE } from "./scraper.js";

import type { FeedItem } from "../types.js";

export const DEFAULT_FEEDS: string[] = [
  // dev / IT
  "https://habr.com/ru/rss/best/daily/?fl=ru",
  "https://www.opennet.ru/opennews/opennews_all_utf.rss",
  // hardware / гаджеты
  "https://3dnews.ru/news/rss",
  "https://www.ixbt.com/export/news.rss",
  // AI / ML
  "https://habr.com/ru/rss/hubs/machine_learning/articles/?fl=ru",
  "https://habr.com/ru/rss/hubs/artificial_intelligence/articles/?fl=ru",
];

export function resolveFeeds(): string[] {
  if (CONFIG.RSS_FEEDS && CONFIG.RSS_FEEDS.trim()) {
    return CONFIG.RSS_FEEDS.split(",")
      .map((f) => f.trim())
      .filter(Boolean);
  }
  return DEFAULT_FEEDS;
}

interface MediaNode {
  $?: { url?: string; medium?: string; type?: string };
}

interface RssItem {
  contentEncoded?: string;
  enclosure?: { url?: string; type?: string };
  mediaContent?: MediaNode[];
  mediaThumbnail?: MediaNode[];
}

export const rssParser: Parser<Record<string, unknown>, RssItem> = new Parser({
  timeout: 10_000,
  customFields: {
    item: [
      ["content:encoded", "contentEncoded"],
      ["media:content", "mediaContent", { keepArray: true }],
      ["media:thumbnail", "mediaThumbnail", { keepArray: true }],
    ],
  },
});

function extractImageUrl(item: Parser.Item & RssItem): string | null {
  const enc = item.enclosure;
  if (enc?.url && (!enc.type || enc.type.startsWith("image/"))) return enc.url;
  const media = [...(item.mediaContent ?? []), ...(item.mediaThumbnail ?? [])];
  for (const node of media) {
    const url = node?.$?.url;
    if (url && (!node.$?.medium || node.$.medium === "image")) return url;
  }
  return null;
}

function extractImageUrls(item: Parser.Item & RssItem, cover: string | null): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (url: string | null | undefined) => {
    if (!url) return;
    const u = url.trim();
    if (!/^https?:\/\//i.test(u)) return;
    if (seen.has(u)) return;
    seen.add(u);
    out.push(u);
  };
  push(cover);
  const body = item.contentEncoded || item.content || "";
  for (const m of body.matchAll(IMG_SRC_RE)) push(m[1]);
  return out;
}

export function mapFeed(feed: Parser.Output<RssItem>): FeedItem[] {
  const feedTitle = feed.title ?? "";
  const items: FeedItem[] = [];
  for (const item of feed.items) {
    const dedupKey = dedupKeyFor(item.guid, item.link);
    if (!dedupKey) continue;
    const title = (item.title ?? "").trim();
    if (!title) continue;
    const snippet = truncate(
      stripHtml(item.contentEncoded || item.content || item.contentSnippet || ""),
      4000,
    );
    const imageUrl = extractImageUrl(item);
    const dateStr = item.isoDate || item.pubDate;
    const parsed = dateStr ? Date.parse(dateStr) : NaN;
    const publishedAt = Number.isNaN(parsed) ? null : parsed;
    items.push({
      dedupKey,
      url: item.link ?? dedupKey,
      title,
      snippet,
      feedTitle,
      imageUrl,
      publishedAt,
      imageUrls: extractImageUrls(item, imageUrl),
    });
  }
  return items;
}
```

- [ ] **Step 2: Create `src/feeds/fetch.ts`**

```ts
import { rssParser, mapFeed, resolveFeeds } from "./parser.js";
import { fetchOgImage } from "./scraper.js";

import type { FeedItem } from "../types.js";

/**
 * Fetches every configured feed and returns combined normalised items.
 * Each feed is isolated — a failing feed is logged and skipped.
 */
export async function fetchAllFeeds(feeds: string[] = resolveFeeds()): Promise<FeedItem[]> {
  const results = await Promise.allSettled(feeds.map((url) => rssParser.parseURL(url)));

  const items: FeedItem[] = [];
  results.forEach((result, idx) => {
    if (result.status === "fulfilled") {
      items.push(...mapFeed(result.value));
    } else {
      // eslint-disable-next-line no-console
      console.warn(`[feeds] failed to parse ${feeds[idx]}: ${String(result.reason)}`);
    }
  });

  // og:image fallback: scrape pages that had no feed image.
  await Promise.all(
    items.map(async (item) => {
      if (item.imageUrl) return;
      item.imageUrl = await fetchOgImage(item.url);
    }),
  );

  return items;
}
```

- [ ] **Step 3: Delete `src/feeds.ts`**

```bash
git rm src/feeds.ts
```

- [ ] **Step 4: Update all importers of `feeds.ts`**

Search for files importing from `./feeds.js` or `../feeds.js`:

```bash
grep -rl '"./feeds\.js"\|"../feeds\.js"' src/
```

Expected results: `src/collector.ts`, `src/ingest.ts`, `src/cli/run-collection.ts`.

Update `src/collector.ts`:
```ts
// OLD
import { fetchAllFeeds } from "./feeds.js";
// NEW
import { fetchAllFeeds } from "./feeds/index.js";
```

Update `src/ingest.ts`:
```ts
// OLD
import { IMG_SRC_RE, OG_IMAGE_RE, OG_IMAGE_RE_ALT } from "./feeds.js";
// NEW
import { IMG_SRC_RE, OG_IMAGE_RE, OG_IMAGE_RE_ALT } from "./feeds/scraper.js";
```

- [ ] **Step 5: Create `src/feeds/index.ts`**

```ts
export { fetchAllFeeds } from "./fetch.js";
export { fetchArticle, feedItemFromText, classifyInput } from "./ingest.js";
export type { ClassifiedInput } from "./ingest.js";
export { DEFAULT_FEEDS, resolveFeeds } from "./parser.js";
export { IMG_SRC_RE, OG_IMAGE_RE, OG_IMAGE_RE_ALT, fetchOgImage } from "./scraper.js";
```

Note: `ingest.ts` will be moved to `feeds/ingest.ts` in Task 6. For now, the index can omit ingest exports until that task is done.

- [ ] **Step 6: TypeScript check**

```bash
npx tsc --noEmit 2>&1 | head -40
```

Expected: 0 errors.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "refactor(feeds): split feeds.ts into parser.ts + scraper.ts + fetch.ts"
```

---

## Task 5: Extract `llm/prompts.ts` and migrate `llm/` domain

Split `rewriter.ts`: extract SYSTEM_PROMPT and buildUserContent to `llm/prompts.ts`. Move all LLM files to `src/llm/`.

**Files:**
- Create: `src/llm/prompts.ts`
- Create: `src/llm/rewriter.ts`
- Create: `src/llm/relevance-classify.ts`
- Create: `src/llm/relevance-markers.ts`
- Create: `src/llm/relevance.ts`
- Create: `src/llm/models.ts`
- Create: `src/llm/providers.ts`
- Create: `src/llm/index.ts`
- Delete: `src/rewriter.ts`, `src/relevance-classify.ts`, `src/relevance-markers.ts`, `src/relevance.ts`, `src/models.ts`, `src/providers.ts`

- [ ] **Step 1: Create `src/llm/prompts.ts`**

```ts
import type { FeedItem } from "../types.js";

/**
 * Shared rewrite system prompt — kept constant across calls for prompt caching
 * eligibility (Anthropic caches identical system blocks across the batch).
 */
export const REWRITE_SYSTEM_PROMPT = `Ты — редактор технического новостного блога. По заголовку,
краткому описанию и (если есть) списку картинок напиши ОРИГИНАЛЬНЫЙ пост на
русском языке: своими словами, без копирования формулировок источника.
Нейтральный журналистский тон.

Тело поста должно быть НЕ плоской стеной текста, а живым и структурированным:
- разбивай на короткие абзацы (между абзацами — пустая строка);
- где уместно, добавляй подзаголовки уровня "##" (на ОТДЕЛЬНОЙ строке,
  с пустой строкой до и после; "##" + пробел + текст, например "## Итоги");
- используй маркированные списки: каждый пункт с НОВОЙ строки, "- " в начале;
- выделяй ключевые термины **жирным**;
- ссылки оформляй ТОЛЬКО валидным Markdown: "[текст](URL)" — текст и URL
  слитно, без пробела между "]" и "(". НЕ пиши URL отдельно в скобках после
  текста (НЕЛЬЗЯ "Хабр (https://...)"), НЕ оставляй "[текст]" без "(URL)";
- при наличии — вставляй картинки строкой "![](URL)" из переданного списка,
  по одной между смысловыми блоками. Используй ТОЛЬКО URL из списка, дословно,
  НЕ выдумывай свои. НЕ вставляй первую картинку (она уже показана как обложка).
  Если список картинок пуст — не вставляй ни одной.

ВАЖНО про Markdown-синтаксис: "##", "-", "**" работают только как разметка
в начале строки / парами. Пиши ЧИСТЫЙ Markdown — НЕ экранируй эти символы
обратным слэшем и не вставляй HTML-теги.

Верни СТРОГО валидный JSON-объект (и ничего кроме него) со следующими полями:
{
  "title": "цепкий, не кликбейтный заголовок, КОРОТКИЙ — до 80 символов, без точки в конце",
  "description": "один абзац-резюме (2–3 предложения)",
  "content": "тело поста в Markdown. НЕ начинай с заголовка/H1 — заголовок уже показан над постом, не дублируй его. ПОСЛЕДНЯЯ строка ровно в формате \\"Источник: [название](URL)\\" — название источника как текст ссылки, оригинальный URL в круглых скобках сразу за \\"]\\", без пробела (например \\"Источник: [Хабр](https://habr.com/...)\\")",
  "tags": ["1–3 тематических тега СТРОГО из этого списка (нижний регистр, ничего другого): технологии, наука, политика, культура, ai, llm, агенты, нейросети, безопасность, разработка, гаджеты, бизнес"],
  "metaTitle": "SEO-заголовок (≈ title)",
  "metaDescription": "SEO-описание (до ~155 символов)"
}

Не выдумывай факты, которых нет во входных данных. Если данных мало — пиши
короче, но без домыслов. Никакого текста до или после JSON.`;

/** Shared relevance-classification system prompt. */
export const RELEVANCE_SYSTEM_PROMPT = `Ты — фильтр релевантности для блога об ИИ и технологиях.
Тематика блога: искусственный интеллект, машинное обучение, нейросети, языковые
модели, чипы и железо, разработка ПО, opensource, кибербезопасность, гаджеты.
ВАЖНО: политика вокруг ИИ, бизнес и инвестиции в ИИ, влияние ИИ на рынок труда —
это ON-topic (релевантно), даже если выглядит как «политика» или «бизнес».

Оцени, насколько новость подходит блогу, по шкале 0–4:
  0 — совсем не по теме (спорт, шоу-бизнес, погода, светская хроника);
  4 — прямо про ИИ/технологии.

Верни СТРОГО валидный JSON-объект и ничего кроме него:
{"score":<0-4>,"topic":"<2-4 слова>","reason":"<кратко>"}`;

/** Builds the rewrite user message for a feed item. */
export function buildRewriteUserContent(item: FeedItem): string {
  const bodyImages = item.imageUrls.slice(1, 6);
  const imagesBlock = bodyImages.length
    ? `Картинки для тела (вставляй "![](URL)" по смыслу, только эти URL):\n${bodyImages.join("\n")}`
    : "Картинки: нет";
  return `Источник: ${item.feedTitle || "неизвестен"}
Ссылка на оригинал: ${item.url}
Заголовок: ${item.title}
Краткое описание: ${item.snippet || "(нет описания)"}
${imagesBlock}`;
}

/** Builds the relevance classification user message for a feed item. */
export function buildRelevanceUserContent(item: FeedItem): string {
  const snippet = item.snippet.slice(0, 300);
  return `Заголовок: ${item.title}
Описание: ${snippet || "(нет описания)"}`;
}
```

- [ ] **Step 2: Create `src/llm/rewriter.ts`**

Copy `src/rewriter.ts`, replace:
```ts
// OLD imports for SYSTEM_PROMPT / buildUserContent:
const SYSTEM_PROMPT = `...`         // delete (moved to prompts.ts)
function buildUserContent(...) {...} // delete (moved to prompts.ts)

// NEW: add at top
import { REWRITE_SYSTEM_PROMPT as SYSTEM_PROMPT, buildRewriteUserContent as buildUserContent } from "./prompts.js";

// Update all other imports from relative root to sibling paths:
// OLD                                       NEW
import { CONFIG } from "./config.js";    → import { CONFIG } from "../config.js";
import { normalizeTags } from "./tags.js"; → import { normalizeTags } from "../tags.js";
import { RewriteSchema } from "./types.js"; → import { RewriteSchema } from "../types.js";
import { truncate, stripHtml } from "./utils.js"; → import { truncate, stripHtml } from "../utils.js";
import { chatUrl, PROVIDERS, ... } from "./providers.js"; → from "./providers.js"; // stays sibling
import { ProviderKind, ProviderName as ... } from "./enums.js"; → from "../enums.js";
import type { CandidateStore } from "./store.js"; → from "../store/index.js";
import type { FeedItem, RewriteResult } from "./types.js"; → from "../types.js";
import type { ProviderName, ProviderSpec } from "./providers.js"; // stays sibling
```

The Anthropic client initialisation stays: `const client = new Anthropic({ apiKey: CONFIG.ANTHROPIC_API_KEY });`

- [ ] **Step 3: Copy remaining LLM files to `src/llm/`**

```bash
cp src/relevance-markers.ts src/llm/relevance-markers.ts
cp src/models.ts src/llm/models.ts
cp src/providers.ts src/llm/providers.ts
```

For `src/llm/relevance-classify.ts`: copy `src/relevance-classify.ts`, update imports:
```ts
// OLD → NEW
import { CONFIG } from "./config.js"; → import { CONFIG } from "../config.js";
import { ProviderKind, ProviderName } from "./enums.js"; → from "../enums.js";
import { chatUrl, PROVIDERS, resolveActiveProvider } from "./providers.js"; // stays sibling
import type { FeedItem } from "./types.js"; → from "../types.js";
import type { CandidateStore } from "./store.js"; → from "../store/index.js";
import type { ProviderSpec } from "./providers.js"; // stays sibling

// AND replace the inline SYSTEM_PROMPT and buildUserContent with:
import { RELEVANCE_SYSTEM_PROMPT, buildRelevanceUserContent } from "./prompts.js";
// then replace usages: SYSTEM_PROMPT → RELEVANCE_SYSTEM_PROMPT, buildUserContent → buildRelevanceUserContent
```

For `src/llm/relevance.ts`: copy `src/relevance.ts`, update imports:
```ts
import { RelevanceStage } from "../enums.js";
import { emitRelevanceDecisions } from "../audit-emit.js";
import { classifyRelevance } from "./relevance-classify.js";
import { ON_TOPIC_MARKERS, OFF_TOPIC_MARKERS } from "./relevance-markers.js";
import type { FeedItem } from "../types.js";
import type { CandidateStore } from "../store/index.js";
```

For `src/llm/models.ts`: update imports:
```ts
import { PROVIDERS, ... } from "./providers.js"; // stays sibling
import { ProviderName, ProviderKind } from "../enums.js";
```

For `src/llm/providers.ts`: update imports:
```ts
import { CONFIG } from "../config.js";
import { ProviderName, ProviderKind } from "../enums.js";
import type { CandidateStore } from "../store/index.js";
```

- [ ] **Step 4: Create `src/llm/index.ts`**

```ts
export { rewriteToPost } from "./rewriter.js";
export { classifyRelevance } from "./relevance-classify.js";
export { filterRelevance } from "./relevance.js";
export type { RelevanceDecision } from "./relevance.js";
export { pingModel, listModels } from "./models.js";
export {
  PROVIDERS,
  MODEL_PRICES,
  CONTROL_PROVIDERS,
  resolveActiveProvider,
  isMockActive,
  hasActiveOverride,
  isControlProvider,
  chatUrl,
} from "./providers.js";
export type { ProviderName, ProviderSpec } from "./providers.js";
export { ON_TOPIC_MARKERS, OFF_TOPIC_MARKERS } from "./relevance-markers.js";
```

- [ ] **Step 5: Delete old files**

```bash
git rm src/rewriter.ts src/relevance-classify.ts src/relevance-markers.ts src/relevance.ts src/models.ts src/providers.ts
```

- [ ] **Step 6: Update all root-level importers**

Files at `src/` root that import from the moved modules:
- `src/bot-handlers.ts`: update `./rewriter.js` → `./llm/index.js`, `./providers.js` → `./llm/index.js`
- `src/bot-model-menu.ts`: update `./models.js` → `./llm/index.js`, `./providers.js` → `./llm/index.js`
- `src/bot-model.ts`: update `./providers.js` → `./llm/index.js`
- `src/bot-render.ts`: update `./providers.js` → `./llm/index.js` (if applicable)
- `src/collector.ts`: update `./relevance.js` → `./llm/index.js`
- `src/control-server.ts`: update `./models.js` → `./llm/index.js`, `./providers.js` → `./llm/index.js`
- `src/health.ts`: update `./models.js` → `./llm/index.js`, `./providers.js` → `./llm/index.js`
- `src/audit-emit.ts`: check if it imports from moved files; update as needed

Run grep to find all importers:
```bash
grep -rl '"./rewriter\.js"\|"./relevance\.js"\|"./relevance-classify\.js"\|"./relevance-markers\.js"\|"./models\.js"\|"./providers\.js"' src/
```

- [ ] **Step 7: TypeScript check**

```bash
npx tsc --noEmit 2>&1 | head -40
```

Expected: 0 errors.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "refactor(llm): migrate to src/llm/ + extract prompts.ts"
```

---

## Task 6: Migrate `feeds/ingest.ts`

Move `src/ingest.ts` to `src/feeds/ingest.ts`. It already imports regex from `feeds/scraper.ts` (fixed in Task 4).

**Files:**
- Create: `src/feeds/ingest.ts` ← copy of `src/ingest.ts` with updated imports
- Delete: `src/ingest.ts`

- [ ] **Step 1: Create `src/feeds/ingest.ts`**

Copy `src/ingest.ts`, update imports:
```ts
// OLD
import { InputKind } from "./enums.js";
import { truncate, stripHtml, canonicalizeUrl } from "./utils.js";
import { IMG_SRC_RE, OG_IMAGE_RE, OG_IMAGE_RE_ALT } from "./feeds.js";
import type { FeedItem } from "./types.js";

// NEW
import { InputKind } from "../enums.js";
import { truncate, stripHtml, canonicalizeUrl } from "../utils.js";
import { IMG_SRC_RE, OG_IMAGE_RE, OG_IMAGE_RE_ALT } from "./scraper.js";
import type { FeedItem } from "../types.js";
```

Everything else in the file is unchanged.

- [ ] **Step 2: Update `src/feeds/index.ts`** — add ingest exports that were deferred in Task 4:

```ts
export { fetchAllFeeds } from "./fetch.js";
export { fetchArticle, feedItemFromText, classifyInput } from "./ingest.js";
export type { ClassifiedInput } from "./ingest.js";
export { DEFAULT_FEEDS, resolveFeeds } from "./parser.js";
export { IMG_SRC_RE, OG_IMAGE_RE, OG_IMAGE_RE_ALT, fetchOgImage } from "./scraper.js";
```

- [ ] **Step 3: Delete `src/ingest.ts`**

```bash
git rm src/ingest.ts
```

- [ ] **Step 4: Update all root-level importers of `ingest.ts`**

```bash
grep -rl '"./ingest\.js"' src/
```

Expected: `src/bot-ingest.ts`. Update:
```ts
// OLD
import { classifyInput, fetchArticle, feedItemFromText } from "./ingest.js";
// NEW
import { classifyInput, fetchArticle, feedItemFromText } from "./feeds/index.js";
```

- [ ] **Step 5: TypeScript check**

```bash
npx tsc --noEmit 2>&1 | head -40
```

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "refactor(feeds): move ingest.ts to feeds/ingest.ts"
```

---

## Task 7: Migrate `health/` domain

Split `src/health.ts` into 4 focused files.

**Files:**
- Create: `src/health/types.ts`
- Create: `src/health/checks.ts`
- Create: `src/health/collect.ts`
- Create: `src/health/render.ts`
- Create: `src/health/index.ts`
- Delete: `src/health.ts`

- [ ] **Step 1: Create `src/health/types.ts`**

```ts
import type { pingModel } from "../llm/index.js";

export interface HealthCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export interface HealthReport {
  healthy: boolean;
  checks: HealthCheck[];
  queue: Record<string, number>;
}

export interface HealthDeps {
  pingFn?: typeof pingModel;
  fetchFn?: typeof fetch;
  nextRun?: () => Date | null;
  uptimeSec?: () => number;
}
```

- [ ] **Step 2: Create `src/health/checks.ts`**

```ts
import { CONFIG } from "../config.js";
import { pingModel } from "../llm/index.js";
import { isMockActive, resolveActiveProvider, PROVIDERS } from "../llm/index.js";

import type { CandidateStore } from "../store/index.js";
import type { HealthCheck, HealthDeps } from "./types.js";

export function formatUptime(totalSec: number): string {
  const s = Math.max(0, Math.floor(totalSec));
  const d = Math.floor(s / 86_400);
  const h = Math.floor((s % 86_400) / 3_600);
  const m = Math.floor((s % 3_600) / 60);
  const sec = s % 60;
  if (d > 0) return `${d}д ${h}ч ${m}м`;
  if (h > 0) return `${h}ч ${m}м`;
  if (m > 0) return `${m}м ${sec}с`;
  return `${sec}с`;
}

export async function checkProvider(
  store: CandidateStore,
  pingFn: typeof pingModel,
): Promise<HealthCheck> {
  const { provider, model } = resolveActiveProvider(store);
  const { label } = PROVIDERS[provider];
  if (isMockActive(store)) {
    return { name: "LLM", ok: true, detail: `mock (без LLM) — ${label}/${model}` };
  }
  const started = Date.now();
  let result: Awaited<ReturnType<typeof pingModel>>;
  try {
    result = await pingFn(provider, model);
  } catch (err) {
    return { name: "LLM", ok: false, detail: `${label}/${model}: ${String(err)}` };
  }
  const ms = Date.now() - started;
  return result.ok
    ? { name: "LLM", ok: true, detail: `${label}/${model} (${ms}мс)` }
    : { name: "LLM", ok: false, detail: `${label}/${model}: ${result.error ?? "ошибка"}` };
}

export async function checkBlog(fetchFn: typeof fetch): Promise<HealthCheck> {
  const url = CONFIG.BLOG_API_URL.replace(/\/$/, "");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5_000);
  try {
    const res = await fetchFn(url, { method: "HEAD", signal: controller.signal });
    return { name: "Блог API", ok: true, detail: `${url} → ${res.status}` };
  } catch (err) {
    return { name: "Блог API", ok: false, detail: `${url}: ${String(err)}` };
  } finally {
    clearTimeout(timer);
  }
}

export function processCheck(uptimeSec: () => number): HealthCheck {
  return {
    name: "Процесс",
    ok: true,
    detail: `аптайм ${formatUptime(uptimeSec())}, node ${process.version}`,
  };
}

export function scheduleCheck(nextRun: (() => Date | null) | undefined): HealthCheck {
  const next = nextRun?.() ?? null;
  return {
    name: "Расписание",
    ok: true,
    detail: next ? `следующий сбор ${next.toISOString()}` : "не запланировано",
  };
}
```

- [ ] **Step 3: Create `src/health/collect.ts`**

```ts
import { pingModel } from "../llm/index.js";
import { checkProvider, checkBlog, processCheck, scheduleCheck } from "./checks.js";

import type { CandidateStore } from "../store/index.js";
import type { HealthReport, HealthDeps } from "./types.js";

export async function collectHealth(
  store: CandidateStore,
  deps: HealthDeps = {},
): Promise<HealthReport> {
  const pingFn = deps.pingFn ?? pingModel;
  const fetchFn = deps.fetchFn ?? fetch;
  const uptimeSec = deps.uptimeSec ?? (() => process.uptime());

  const checks = [
    processCheck(uptimeSec),
    scheduleCheck(deps.nextRun),
  ];

  const [provider, blog] = await Promise.all([checkProvider(store, pingFn), checkBlog(fetchFn)]);
  checks.push(provider, blog);

  const queue = store.countsByState();
  const healthy = checks.every((c) => c.ok);
  return { healthy, checks, queue };
}
```

- [ ] **Step 4: Create `src/health/render.ts`**

```ts
import { CandidateState } from "../enums.js";
import { escapeMarkdown } from "../utils.js";

import type { HealthReport } from "./types.js";

const ATTENTION_STATES: CandidateState[] = [
  CandidateState.NeedsVerification,
  CandidateState.PendingReview,
  CandidateState.RewriteFailed,
];

export function renderHealth(report: HealthReport): string {
  const head = report.healthy ? "✅ *Всё ОК*" : "⚠️ *Есть проблемы*";
  const lines = report.checks.map(
    (c) => `${c.ok ? "✅" : "❌"} *${escapeMarkdown(c.name)}*: ${escapeMarkdown(c.detail)}`,
  );

  const total = Object.values(report.queue).reduce((a, b) => a + b, 0);
  const attention = ATTENTION_STATES.filter((s) => (report.queue[s] ?? 0) > 0).map(
    (s) => `${s}=${report.queue[s]}`,
  );
  const queueLine = total
    ? `🗂 Очередь: всего ${total}${attention.length ? ` (внимание: ${attention.join(", ")})` : ""}`
    : "🗂 Очередь пуста";

  return [head, "", ...lines, "", escapeMarkdown(queueLine)].join("\n");
}
```

- [ ] **Step 5: Create `src/health/index.ts`**

```ts
export { collectHealth } from "./collect.js";
export { renderHealth } from "./render.js";
export type { HealthCheck, HealthReport, HealthDeps } from "./types.js";
```

- [ ] **Step 6: Delete `src/health.ts`**

```bash
git rm src/health.ts
```

- [ ] **Step 7: Update importers**

```bash
grep -rl '"./health\.js"' src/
```

Expected: `src/bot.ts`. Update:
```ts
// OLD
import { collectHealth, renderHealth } from "./health.js";
import type { HealthCheck, HealthReport, HealthDeps } from "./health.js";
// NEW
import { collectHealth, renderHealth } from "./health/index.js";
import type { HealthCheck, HealthReport, HealthDeps } from "./health/index.js";
```

- [ ] **Step 8: TypeScript check**

```bash
npx tsc --noEmit 2>&1 | head -40
```

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "refactor(health): split health.ts into health/ domain folder"
```

---

## Task 8: Migrate `bot/` domain

Move all `bot-*.ts` files to `src/bot/`, rename by dropping the `bot-` prefix.

**Files:**
- Create: `src/bot/handlers.ts` ← `src/bot-handlers.ts`
- Create: `src/bot/ingest.ts` ← `src/bot-ingest.ts`
- Create: `src/bot/keyboards.ts` ← `src/bot-keyboards.ts`
- Create: `src/bot/menu.ts` ← `src/bot-menu.ts`
- Create: `src/bot/model-menu.ts` ← `src/bot-model-menu.ts`
- Create: `src/bot/model.ts` ← `src/bot-model.ts`
- Create: `src/bot/render.ts` ← `src/bot-render.ts`
- Create: `src/bot/edit.ts` ← `src/bot-edit.ts`
- Create: `src/bot/index.ts`
- Delete: all `src/bot-*.ts`

- [ ] **Step 1: Copy files with updated import paths**

For each file, copy and update:
- All `../` paths for moved domains (`../llm/index.js`, `../store/index.js`, `../feeds/index.js`, `../health/index.js`)
- Sibling `bot-*` imports become `./edit.js`, `./keyboards.js`, etc.
- Root-level imports (`./config.js`, `./enums.js`, `./types.js`, `./consts.js`, `./utils.js`) become `../config.js`, etc.

Example for `src/bot/handlers.ts`:
```ts
// OLD                              NEW
import { CONFIG } from "./config.js"; → import { CONFIG } from "../config.js";
import { escapeMarkdown } from "./utils.js"; → import { escapeMarkdown } from "../utils.js";
import { CARD_CALLBACK } from "./consts.js"; → import { CARD_CALLBACK } from "../consts.js";
import { CandidateState } from "./enums.js"; → import { CandidateState } from "../enums.js";
import { rewriteToPost } from "./rewriter.js"; → import { rewriteToPost } from "../llm/index.js";
import { parseCallback } from "./bot-model.js"; → import { parseCallback } from "./model.js";
import { ackSilently, logEditError } from "./bot-edit.js"; → import { ... } from "./edit.js";
import { handleModelCallback } from "./bot-model-menu.js"; → import { ... } from "./model-menu.js";
import { PublishError, publishToBlog } from "./publisher.js"; → import { ... } from "../publisher.js";
import { rawKeyboard, previewKeyboard } from "./bot-keyboards.js"; → import { ... } from "./keyboards.js";
import { renderPreview, isModelNotFound, renderRewriting } from "./bot-render.js"; → from "./render.js";
import { PROVIDERS, hasActiveOverride, resolveActiveProvider } from "./providers.js"; → from "../llm/index.js";
import type { Candidate } from "./types.js"; → from "../types.js";
import type { CandidateStore } from "./store.js"; → from "../store/index.js";
```

Apply the same logic to all 8 bot files.

- [ ] **Step 2: Create `src/bot/index.ts`**

```ts
export { createHandlers } from "./handlers.js";
export { createIngest } from "./ingest.js";
export { modelMenu, handleModelCallback } from "./model-menu.js";
export { parseCallback } from "./model.js";
export { rawKeyboard, previewKeyboard, keyboardFrom } from "./keyboards.js";
export { renderRaw, renderPreview, renderRewriting, isModelNotFound } from "./render.js";
export { logEditError, ackSilently } from "./edit.js";
export { COMMANDS, helpText, menuKeyboard, nativeCommands, parseMenuCallback } from "./menu.js";
```

- [ ] **Step 3: Delete old `bot-*.ts` files**

```bash
git rm src/bot-handlers.ts src/bot-ingest.ts src/bot-keyboards.ts src/bot-menu.ts src/bot-model-menu.ts src/bot-model.ts src/bot-render.ts src/bot-edit.ts
```

- [ ] **Step 4: Update `src/bot.ts`**

`src/bot.ts` imports from the old `bot-*.ts` paths. Update each import to use `./bot/` subpaths or `./bot/index.js`:
```ts
// OLD
import { createHandlers } from "./bot-handlers.js";
import { createIngest } from "./bot-ingest.js";
// etc.
// NEW
import { createHandlers } from "./bot/handlers.js";
import { createIngest } from "./bot/ingest.js";
// etc.
```

- [ ] **Step 5: TypeScript check**

```bash
npx tsc --noEmit 2>&1 | head -40
```

Expected: 0 errors.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "refactor(bot): migrate bot-*.ts files to src/bot/ domain folder"
```

---

## Task 9: Migrate `core/` domain

Move shared infrastructure files to `src/core/`. These are imported by every domain so they stay separate from domain folders.

**Files:**
- Create: `src/core/config.ts`, `src/core/enums.ts`, `src/core/types.ts`, `src/core/consts.ts`, `src/core/utils.ts`, `src/core/curate.ts`, `src/core/tags.ts`, `src/core/scheduler.ts`, `src/core/auto-retry.ts`
- Create: `src/core/index.ts`
- Delete: all source files above from `src/`

**Note:** This task is the highest-risk: these files are imported by virtually every other module. Consider whether the ergonomic benefit justifies the churn. If the team prefers keeping `config.ts`, `enums.ts`, `utils.ts` etc. at the root level (common pattern for small projects), skip this task.

- [ ] **Step 1: Copy files to `src/core/`**

```bash
cp src/config.ts src/core/config.ts
cp src/enums.ts src/core/enums.ts
cp src/types.ts src/core/types.ts
cp src/consts.ts src/core/consts.ts
cp src/utils.ts src/core/utils.ts
cp src/curate.ts src/core/curate.ts
cp src/tags.ts src/core/tags.ts
cp src/scheduler.ts src/core/scheduler.ts
cp src/auto-retry.ts src/core/auto-retry.ts
```

- [ ] **Step 2: Update internal cross-imports within core**

Files in `src/core/` that import from sibling core files need no path update (they already use `./` relative). But check for any imports from domains that moved:
- `src/core/types.ts` imports `RewriteSchema` from `../schemas/rewrite-schema.js` (stays as `../schemas/`)
- `src/core/curate.ts` — check its imports

- [ ] **Step 3: Create `src/core/index.ts`**

```ts
export { CONFIG } from "./config.js";
export * from "./enums.js";
export * from "./types.js";
export * from "./consts.js";
export * from "./utils.js";
export { parseKeywords, passesFilters, curateForQueue } from "./curate.js";
export { normalizeTags } from "./tags.js";
export { scheduleDaily } from "./scheduler.js";
export { autoRetry } from "./auto-retry.js";
```

- [ ] **Step 4: Delete old root-level files**

```bash
git rm src/config.ts src/enums.ts src/types.ts src/consts.ts src/utils.ts src/curate.ts src/tags.ts src/scheduler.ts src/auto-retry.ts
```

- [ ] **Step 5: Mass-update all imports across the codebase**

Every file in `src/bot/`, `src/llm/`, `src/feeds/`, `src/store/`, `src/health/`, and root `src/*.ts` that imports from the moved core files needs updating.

Use grep to find each:
```bash
grep -rl '"\.\.\/config\.js"\|"\.\.\/enums\.js"\|"\.\.\/types\.js"\|"\.\.\/consts\.js"\|"\.\.\/utils\.js"\|"\.\.\/tags\.js"\|"\.\.\/scheduler\.js"' src/
```

For files inside domain folders (`src/bot/`, `src/llm/`, etc.), update `../config.js` → `../core/config.js`.
For root files (`src/bot.ts`, `src/collector.ts`, `src/index.ts`), update `./config.js` → `./core/config.js`.

- [ ] **Step 6: TypeScript check**

```bash
npx tsc --noEmit 2>&1 | head -40
```

Expected: 0 errors.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "refactor(core): migrate shared infrastructure to src/core/"
```

---

## Task 10: Final verification

- [ ] **Step 1: Full TypeScript check**

```bash
npx tsc --noEmit 2>&1
```

Expected: 0 errors.

- [ ] **Step 2: Lint check**

```bash
npm run lint 2>&1 | tail -20
```

Expected: 0 errors (warnings about `no-console` in existing code are pre-existing and acceptable).

- [ ] **Step 3: Smoke-test bot startup**

```bash
# In a subshell so it can be killed after a few seconds
timeout 5 npm run dev 2>&1 || true
```

Expected: `[index] bot @<username> polling.` or `[index] started.` — no module-not-found errors.

- [ ] **Step 4: Verify final folder structure**

```bash
find src -type f -name "*.ts" | sort
```

Expected layout matches the target at the top of this plan.

- [ ] **Step 5: Final commit**

```bash
git add -A
git commit -m "refactor: complete domain folder reorganisation"
```

---

## Self-review notes

- **Task 9 is optional**: migrating `core/` adds the most churn (every file touches `../core/` prefix). If the team prefers keeping config/enums/utils at root, skip Task 9 and just do Tasks 1–8.
- **Import depth**: after Task 9, inner files will have paths like `import { CONFIG } from "../core/config.js"` from domain subfolders — readable and consistent.
- **No behaviour change**: all refactors are pure file moves + import-path updates. No logic is changed.
- **cli/ stays flat**: `src/cli/run-collection.ts` is an entrypoint — no benefit in nesting it further.
- **bot.ts, collector.ts, control-server.ts, index.ts stay at root**: they are the composition/wiring layer that sees all domains, which is why they're not inside any domain folder.
