/**
 * Deterministic contract checks for a finalized rewrite. Given the FeedItem that
 * went in and the RewriteResult that came out (already through finalizeRewrite —
 * so the safety nets have run), assert every invariant the REWRITE prompt is
 * supposed to honour. Zero LLM, zero network: this is the free grader that locks
 * the output contract and catches a prompt that produces broken shape.
 *
 * Each function returns Findings; `checkRewrite` aggregates them. The checks are
 * exported individually so the unit test can prove each one fails on bad input.
 */

import { pass, fail } from "./types.js";
import { normalizeHttpUrl } from "../../src/llm/safeUrl.js";
import { NEWS_TAG, TAG_WHITELIST } from "../../src/blog/normalizeTags.js";

import type { Finding } from "./types.js";
import type { FeedItem, RewriteResult } from "../../src/types.js";

/** Hard title clamp from finalizeRewrite; > this is a real defect. */
const TITLE_HARD_MAX = 100;
/** Soft headline target from the prompt; over → warn only. */
const TITLE_SOFT_MAX = 80;
/** Soft SEO description ceiling; over → warn. */
const META_DESC_SOFT_MAX = 160;

const WHITELIST_SET = new Set(TAG_WHITELIST);
/** Canonical source line, must be the last non-empty line (mirrors SOURCE_LINE_RE). */
const SOURCE_LINE_RE = /^Источник:\s*\[([^\]]*)\]\(([^)]+)\)\s*$/;
/** Any markdown image: captures the URL. */
const IMAGE_RE = /!\[[^\]]*\]\(([^)]+)\)/g;
/** Any http(s) URL, regardless of Markdown syntax. */
const URL_RE = /https?:\/\/[^\s<>"'\]]+/g;
/** A markdown inline link (non-image): captures text + url. */
const LINK_RE = /(?<!!)\[([^\]]+)\]\(([^)]+)\)/g;
/** "текст (http...)" — a URL in parens right after words, the anti-pattern. */
const BARE_URL_IN_PARENS_RE = /[^\]]\s\((https?:\/\/[^)]+)\)/;
/** Backslash-escaped markdown the prompt forbids. */
const ESCAPED_MD_RE = /\\[#\-*]/;
/** A crude HTML tag detector. */
const HTML_TAG_RE = /<\/?[a-z][a-z0-9]*(\s[^>]*)?>/i;
const GENERIC_TITLE_RE =
  /^(?:компания|стартап|разработчики|команда)\s+.*(?:новую модель|новую версию|обновление|ии)(?:$|[^\p{L}])/iu;
const GENERIC_HEADING_RE =
  /^##\s+(?:(?:основные|ключевые|главные)\s+(?:изменения|нововведения|возможности)|что изменилось|почему это важно|итоги|заключение)\s*$/gimu;
const FIRST_PERSON_RE =
  /(?:^|[^\p{L}])(?:я|мне|меня|мой|моя|моё|мои|мы|нам|наш|наша)(?=$|[^\p{L}])/iu;
const NUMBER_RE = /\d+(?:[.,]\d+)*/g;
const QUOTE_RE = /«([^»]{20,})»|"([^"\n]{20,})"/g;

/** Title: non-empty, within the hard clamp, headline-length target, no leading #. */
export function checkTitle(result: RewriteResult, item: FeedItem): Finding[] {
  const out: Finding[] = [];
  const title = result.title.trim();
  out.push(
    title.length > 0 ? pass("title.nonEmpty") : fail("title.nonEmpty", "error", "empty title"),
  );
  out.push(
    title.length <= TITLE_HARD_MAX
      ? pass("title.hardMax")
      : fail("title.hardMax", "error", `title ${title.length} > ${TITLE_HARD_MAX} chars`),
  );
  out.push(
    title.length <= TITLE_SOFT_MAX
      ? pass("title.softMax")
      : fail("title.softMax", "warn", `title ${title.length} > ${TITLE_SOFT_MAX} target`),
  );
  out.push(
    title.startsWith("#")
      ? fail("title.noHeading", "error", "title starts with '#'")
      : pass("title.noHeading"),
  );
  out.push(
    title.toLowerCase() === item.title.trim().toLowerCase()
      ? fail("title.notVerbatim", "warn", "title copies the source verbatim")
      : pass("title.notVerbatim"),
  );
  out.push(
    GENERIC_TITLE_RE.test(title)
      ? fail("title.specific", "error", "generic announcement headline has no reader stake")
      : pass("title.specific"),
  );
  return out;
}

/** Content must not open with a heading (no duplicate of the post's own title). */
export function checkNoLeadingHeading(result: RewriteResult): Finding[] {
  const firstLine = result.content.trimStart().split("\n", 1)[0] ?? "";
  const isHeading = /^#{1,6}\s/.test(firstLine.trim());
  return [
    isHeading
      ? fail(
          "content.noLeadingHeading",
          "error",
          `body opens with a heading: "${firstLine.trim().slice(0, 40)}"`,
        )
      : pass("content.noLeadingHeading"),
  ];
}

/** The last non-empty content line must be the canonical source line for this item. */
export function checkSourceLine(result: RewriteResult, item: FeedItem): Finding[] {
  const lines = result.content.trimEnd().split("\n");
  const lastNonEmpty = [...lines].reverse().find((l) => l.trim().length > 0) ?? "";
  const m = SOURCE_LINE_RE.exec(lastNonEmpty.trim());
  const out: Finding[] = [];
  if (!item.url) {
    return [
      SOURCE_LINE_RE.test(lastNonEmpty.trim())
        ? fail("source.present", "error", "manual draft must not contain an empty source link")
        : pass("source.present"),
    ];
  }
  if (!m) {
    out.push(
      fail(
        "source.present",
        "error",
        `no canonical 'Источник:' last line (got "${lastNonEmpty.slice(0, 50)}")`,
      ),
    );
    return out;
  }
  out.push(pass("source.present"));
  out.push(
    normalizeHttpUrl(m[2]!) === normalizeHttpUrl(item.url)
      ? pass("source.url")
      : fail("source.url", "error", `source url "${m[2]}" != item url "${item.url}"`),
  );
  // Exactly one source line — a stray second one means a self-heal edge case.
  const count = lines.filter((l) => SOURCE_LINE_RE.test(l.trim())).length;
  out.push(
    count === 1 ? pass("source.single") : fail("source.single", "error", `${count} source lines`),
  );
  return out;
}

/** Every prose link must come from the source input; model-invented URLs are unsafe. */
export function checkLinks(result: RewriteResult, item: FeedItem): Finding[] {
  const sourceUrls = item.snippet.match(/https?:\/\/[^\s<>"'\]]+/g) ?? [];
  const allowed = new Set(
    [item.url, ...sourceUrls, ...item.imageUrls.slice(1)]
      .map(normalizeHttpUrl)
      .filter((url): url is string => url !== null),
  );
  const used = [...result.content.matchAll(URL_RE)].map((match) =>
    match[0].replace(/[),.;!?]+$/, ""),
  );
  const invented = used.filter((url) => {
    const normalized = normalizeHttpUrl(url);
    return !normalized || !allowed.has(normalized);
  });
  return [
    invented.length
      ? fail("links.sourceOnly", "error", `invented link(s): ${invented.slice(0, 2).join(", ")}`)
      : pass("links.sourceOnly"),
  ];
}

/** High-signal anti-template checks plus first-person preservation for author drafts. */
export function checkEditorialQuality(result: RewriteResult, item: FeedItem): Finding[] {
  const bullets = result.content.split("\n").filter((line) => /^-\s+/.test(line)).length;
  const genericTemplate = GENERIC_HEADING_RE.test(result.content) && bullets === 3;
  GENERIC_HEADING_RE.lastIndex = 0;
  const sourceHasFirstPerson = !item.url && FIRST_PERSON_RE.test(item.snippet);
  const outputHasFirstPerson = FIRST_PERSON_RE.test(`${result.description} ${result.content}`);
  const firstParagraph =
    result.content
      .split(/\n\s*\n/, 1)[0]
      ?.replace(/\s+/g, " ")
      .trim() ?? "";
  const description = result.description.replace(/\s+/g, " ").trim();
  const echo =
    firstParagraph.length >= 60 && description.slice(0, 60) === firstParagraph.slice(0, 60);
  return [
    genericTemplate
      ? fail(
          "voice.genericTemplate",
          "error",
          "generic heading followed by a forced three-item list",
        )
      : pass("voice.genericTemplate"),
    sourceHasFirstPerson && !outputHasFirstPerson
      ? fail(
          "voice.preserveFirstPerson",
          "error",
          "manual first-person draft lost the author's voice",
        )
      : pass("voice.preserveFirstPerson"),
    echo
      ? fail("voice.descriptionEcho", "warn", "description is copied into the opening paragraph")
      : pass("voice.descriptionEcho"),
  ];
}

function normalizedNumbers(input: string): Set<string> {
  return new Set((input.match(NUMBER_RE) ?? []).map((value) => value.replace(",", ".")));
}

/** Detects objectively unsupported numerals and long direct quotes. */
export function checkFactuality(result: RewriteResult, item: FeedItem): Finding[] {
  const source = `${item.title}\n${item.snippet}`;
  const body = result.content
    .split("\n")
    .filter((line) => !SOURCE_LINE_RE.test(line.trim()))
    .join("\n")
    .replace(IMAGE_RE, "")
    .replace(/\]\(https?:\/\/[^)]+\)/g, "]");
  const output = `${result.title}\n${result.description}\n${body}\n${result.metaTitle}\n${result.metaDescription}`;
  const sourceNumbers = normalizedNumbers(source);
  const novelNumbers = [...normalizedNumbers(output)].filter((value) => !sourceNumbers.has(value));
  const sourceNormalized = source.replace(/\s+/g, " ").toLowerCase();
  const quoteOutput = `${result.title}\n${result.description}\n${body}\n${result.metaTitle}\n${result.metaDescription}`;
  const novelQuotes = [...quoteOutput.matchAll(QUOTE_RE)]
    .map((match) => (match[1] ?? match[2] ?? "").replace(/\s+/g, " ").trim().toLowerCase())
    .filter((quote) => !sourceNormalized.includes(quote));
  return [
    novelNumbers.length
      ? fail("facts.numbers", "error", `number(s) absent from source: ${novelNumbers.join(", ")}`)
      : pass("facts.numbers"),
    novelQuotes.length
      ? fail("facts.quotes", "error", `quote absent from source: "${novelQuotes[0]!.slice(0, 60)}"`)
      : pass("facts.quotes"),
  ];
}

/** Every markdown image URL in the body must be in the item's allow-list (imageUrls[1:]). */
export function checkImages(result: RewriteResult, item: FeedItem): Finding[] {
  const allowed = new Set(item.imageUrls.slice(1));
  const used = [...result.content.matchAll(IMAGE_RE)].map((mm) => mm[1]!.trim());
  const invalid = used.filter((u) => !allowed.has(u));
  if (invalid.length === 0) return [pass("images.allowlist")];
  return [
    fail("images.allowlist", "error", `off-allowlist image(s): ${invalid.slice(0, 2).join(", ")}`),
  ];
}

/** Tags: subset of the whitelist, `новости` present & first, 1–4 entries. */
export function checkTags(result: RewriteResult): Finding[] {
  const out: Finding[] = [];
  const { tags } = result;
  out.push(
    tags.length >= 1 && tags.length <= 4
      ? pass("tags.count")
      : fail("tags.count", "error", `${tags.length} tags (want 1–4)`),
  );
  const offList = tags.filter((t) => !WHITELIST_SET.has(t));
  out.push(
    offList.length === 0
      ? pass("tags.whitelist")
      : fail("tags.whitelist", "error", `off-whitelist tag(s): ${offList.join(", ")}`),
  );
  out.push(
    tags[0] === NEWS_TAG
      ? pass("tags.newsFirst")
      : fail("tags.newsFirst", "error", `first tag is "${tags[0]}", expected "${NEWS_TAG}"`),
  );
  return out;
}

/** Markdown hygiene: valid links, no bare-URL-in-parens, no escaped md, no HTML. */
export function checkMarkdown(result: RewriteResult): Finding[] {
  const out: Finding[] = [];
  const { content } = result;

  // Every inline link has non-empty text and an http(s) URL.
  const badLinks = [...content.matchAll(LINK_RE)].filter(
    (m) => !m[1]!.trim() || !/^https?:\/\//.test(m[2]!.trim()),
  );
  out.push(
    badLinks.length === 0
      ? pass("md.links")
      : fail("md.links", "error", `${badLinks.length} malformed [text](url) link(s)`),
  );

  // The "Хабр (https://...)" anti-pattern — a URL parenthesized after prose,
  // NOT part of a []() link. Exclude the canonical source line (handled above).
  const withoutSource = content
    .split("\n")
    .filter((l) => !SOURCE_LINE_RE.test(l.trim()))
    .join("\n");
  out.push(
    BARE_URL_IN_PARENS_RE.test(withoutSource)
      ? fail("md.bareUrl", "warn", "a URL appears in parens after text, not as a []() link")
      : pass("md.bareUrl"),
  );

  out.push(
    ESCAPED_MD_RE.test(content)
      ? fail("md.noEscape", "error", "backslash-escaped markdown (\\#, \\-, \\*) present")
      : pass("md.noEscape"),
  );
  out.push(
    HTML_TAG_RE.test(content)
      ? fail("md.noHtml", "error", "raw HTML tag present in content")
      : pass("md.noHtml"),
  );
  return out;
}

/** description non-empty; metaDescription within the soft SEO ceiling. */
export function checkMeta(result: RewriteResult): Finding[] {
  const out: Finding[] = [];
  out.push(
    result.description.trim().length > 0
      ? pass("desc.nonEmpty")
      : fail("desc.nonEmpty", "error", "empty description"),
  );
  out.push(
    result.metaDescription.length <= META_DESC_SOFT_MAX
      ? pass("meta.descLen")
      : fail(
          "meta.descLen",
          "warn",
          `metaDescription ${result.metaDescription.length} > ${META_DESC_SOFT_MAX}`,
        ),
  );
  return out;
}

/** Runs every rewrite check and returns the flattened finding list. */
export function checkRewrite(result: RewriteResult, item: FeedItem): Finding[] {
  return [
    ...checkTitle(result, item),
    ...checkNoLeadingHeading(result),
    ...checkSourceLine(result, item),
    ...checkImages(result, item),
    ...checkTags(result),
    ...checkMarkdown(result),
    ...checkLinks(result, item),
    ...checkEditorialQuality(result, item),
    ...checkFactuality(result, item),
    ...checkMeta(result),
  ];
}
