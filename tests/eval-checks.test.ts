import { it, expect, describe } from "vitest";

import { RETELL_MAX } from "../src/llm/retellPrompt.js";
import { isCasePassing } from "../evals/checks/types.js";
import { checkDress } from "../evals/checks/dressChecks.js";
import { finalizeRewrite } from "../src/llm/rewriteToPost.js";
import { parseJudgeVerdict } from "../evals/judge/runJudge.js";
import { checkChannelRetell } from "../evals/checks/channelChecks.js";
import { judgeGate, parseJudgeFloor } from "../evals/judge/judgeGate.js";
import { checkRelease, parseReleaseReply } from "../evals/checks/releaseChecks.js";
import { checkRelevance, parseRelevanceReply } from "../evals/checks/relevanceChecks.js";
import {
  checkMeta,
  checkTags,
  checkTitle,
  checkLinks,
  checkImages,
  checkRewrite,
  checkMarkdown,
  checkFactuality,
  checkSourceLine,
  checkEditorialQuality,
  checkNoLeadingHeading,
} from "../evals/checks/rewriteChecks.js";

import type { Finding } from "../evals/checks/types.js";
import type { FeedItem, RewriteResult } from "../src/types.js";

/**
 * Tests for the eval GRADERS themselves. A check that never fails on bad input is
 * worthless, so every check is proven to (a) pass a good artifact and (b) flag a
 * deliberately broken one at the right severity. This is what makes the eval
 * harness trustworthy.
 */

const ITEM: FeedItem = {
  dedupKey: "k",
  url: "https://ex.com/article",
  title: "Оригинальный заголовок источника",
  snippet: "snippet",
  feedTitle: "Хабр",
  imageUrl: "https://cdn/cover.jpg",
  imageUrls: ["https://cdn/cover.jpg", "https://cdn/in1.png"],
  publishedAt: null,
};

/** A fully valid rewrite for ITEM. */
function goodResult(): RewriteResult {
  return {
    title: "Хороший короткий заголовок",
    description: "Одно-два предложения резюме поста.",
    content:
      "Первый абзац поста.\n\n## Подзаголовок\n\n- пункт один\n- пункт два\n\n" +
      "![](https://cdn/in1.png)\n\nИсточник: [Хабр](https://ex.com/article)",
    tags: ["новости", "разработка"],
    metaTitle: "Хороший заголовок",
    metaDescription: "Короткое SEO-описание.",
  };
}

/** True if a finding id is present and failed at error severity. */
function erroredOn(findings: Finding[], id: string): boolean {
  return findings.some((f) => f.id === id && !f.ok && f.severity === "error");
}
function warnedOn(findings: Finding[], id: string): boolean {
  return findings.some((f) => f.id === id && !f.ok && f.severity === "warn");
}

describe("checkRewrite — full pass on a good result", () => {
  it("produces zero error findings for a clean rewrite", () => {
    const findings = checkRewrite(goodResult(), ITEM);
    expect(isCasePassing(findings)).toBe(true);
    expect(findings.filter((f) => !f.ok && f.severity === "error")).toEqual([]);
  });
});

describe("checkTitle", () => {
  it("errors on an empty title", () => {
    expect(erroredOn(checkTitle({ ...goodResult(), title: "  " }, ITEM), "title.nonEmpty")).toBe(
      true,
    );
  });
  it("errors on a title over the 100-char hard clamp", () => {
    const long = "А".repeat(120);
    expect(erroredOn(checkTitle({ ...goodResult(), title: long }, ITEM), "title.hardMax")).toBe(
      true,
    );
  });
  it("warns (not errors) on a title over the 80-char target", () => {
    const t = "Б".repeat(90);
    const f = checkTitle({ ...goodResult(), title: t }, ITEM);
    expect(warnedOn(f, "title.softMax")).toBe(true);
    expect(erroredOn(f, "title.softMax")).toBe(false);
  });
  it("errors when the title starts with '#'", () => {
    expect(
      erroredOn(checkTitle({ ...goodResult(), title: "# Заголовок" }, ITEM), "title.noHeading"),
    ).toBe(true);
  });
  it("warns when the title copies the source verbatim", () => {
    expect(
      warnedOn(checkTitle({ ...goodResult(), title: ITEM.title }, ITEM), "title.notVerbatim"),
    ).toBe(true);
  });

  it("errors on a generic company-announcement headline", () => {
    const result = { ...goodResult(), title: "Компания представила новую модель ИИ" };
    expect(erroredOn(checkTitle(result, ITEM), "title.specific")).toBe(true);
  });

  it("accepts a specific consequence-led headline", () => {
    const result = { ...goodResult(), title: "Новая модель режет расходы на инференс вдвое" };
    expect(erroredOn(checkTitle(result, ITEM), "title.specific")).toBe(false);
  });
});

describe("checkNoLeadingHeading", () => {
  it("errors when the body opens with a heading", () => {
    const r = {
      ...goodResult(),
      content: "## Заголовок\n\nтекст\n\nИсточник: [Хабр](https://ex.com/article)",
    };
    expect(erroredOn(checkNoLeadingHeading(r), "content.noLeadingHeading")).toBe(true);
  });
  it("passes when the body opens with prose", () => {
    expect(isCasePassing(checkNoLeadingHeading(goodResult()))).toBe(true);
  });
});

describe("checkSourceLine", () => {
  it("errors when there is no source line", () => {
    const r = { ...goodResult(), content: "Просто текст без источника." };
    expect(erroredOn(checkSourceLine(r, ITEM), "source.present")).toBe(true);
  });
  it("errors when the source URL points elsewhere", () => {
    const r = { ...goodResult(), content: "Текст.\n\nИсточник: [Хабр](https://other.com/x)" };
    expect(erroredOn(checkSourceLine(r, ITEM), "source.url")).toBe(true);
  });
  it("passes for the canonical source line", () => {
    expect(isCasePassing(checkSourceLine(goodResult(), ITEM))).toBe(true);
  });

  it("allows legitimate interior Источник prose in a manual draft", () => {
    const item = { ...ITEM, url: "" };
    const result = {
      ...goodResult(),
      content: "Источник: мои замеры за неделю.\n\nВот что из них следует.",
    };
    expect(erroredOn(checkSourceLine(result, item), "source.present")).toBe(false);
  });

  it("parses canonical attribution after hostile feed-title sanitization", () => {
    const item = { ...ITEM, feedTitle: "Feed](https://evil.example) [spoof" };
    const finalized = finalizeRewrite(JSON.stringify(goodResult()), item);
    const findings = checkSourceLine(finalized, item);

    expect(erroredOn(findings, "source.present")).toBe(false);
    expect(erroredOn(findings, "source.url")).toBe(false);
  });
});

describe("checkImages", () => {
  it("errors on an off-allowlist image (invented or cover)", () => {
    const r = {
      ...goodResult(),
      content: "Текст.\n\n![](https://evil/fake.png)\n\nИсточник: [Хабр](https://ex.com/article)",
    };
    expect(erroredOn(checkImages(r, ITEM), "images.allowlist")).toBe(true);
  });
  it("errors when the cover image (index 0) is embedded in the body", () => {
    const r = {
      ...goodResult(),
      content: "Текст.\n\n![](https://cdn/cover.jpg)\n\nИсточник: [Хабр](https://ex.com/article)",
    };
    expect(erroredOn(checkImages(r, ITEM), "images.allowlist")).toBe(true);
  });
  it("passes when only allow-listed body images are used", () => {
    expect(isCasePassing(checkImages(goodResult(), ITEM))).toBe(true);
  });
});

describe("checkTags", () => {
  it("errors on an off-whitelist tag", () => {
    expect(
      erroredOn(checkTags({ ...goodResult(), tags: ["новости", "спорт"] }), "tags.whitelist"),
    ).toBe(true);
  });
  it("errors when новости is not first", () => {
    expect(
      erroredOn(checkTags({ ...goodResult(), tags: ["разработка", "новости"] }), "tags.newsFirst"),
    ).toBe(true);
  });
  it("errors on an empty tag list", () => {
    expect(erroredOn(checkTags({ ...goodResult(), tags: [] }), "tags.count")).toBe(true);
  });
});

describe("checkMarkdown", () => {
  it("errors on backslash-escaped markdown", () => {
    const r = {
      ...goodResult(),
      content: "Текст со \\# экранированием.\n\nИсточник: [Хабр](https://ex.com/article)",
    };
    expect(erroredOn(checkMarkdown(r), "md.noEscape")).toBe(true);
  });
  it("errors on raw HTML tags", () => {
    const r = {
      ...goodResult(),
      content: "Текст <b>жирный</b>.\n\nИсточник: [Хабр](https://ex.com/article)",
    };
    expect(erroredOn(checkMarkdown(r), "md.noHtml")).toBe(true);
  });
  it("errors on a malformed link (no url scheme)", () => {
    const r = {
      ...goodResult(),
      content: "Смотри [тут](/relative).\n\nИсточник: [Хабр](https://ex.com/article)",
    };
    expect(erroredOn(checkMarkdown(r), "md.links")).toBe(true);
  });
  it("warns on a bare URL in parens after text", () => {
    const r = {
      ...goodResult(),
      content: "Читайте на Хабре (https://habr.com/x).\n\nИсточник: [Хабр](https://ex.com/article)",
    };
    expect(warnedOn(checkMarkdown(r), "md.bareUrl")).toBe(true);
  });
  it("passes clean markdown", () => {
    expect(isCasePassing(checkMarkdown(goodResult()))).toBe(true);
  });
});

describe("checkLinks", () => {
  it("errors on a link invented by the model", () => {
    const result = {
      ...goodResult(),
      content:
        "Читайте [подробнее](https://evil.example/prompt).\n\nИсточник: [Хабр](https://ex.com/article)",
    };
    expect(erroredOn(checkLinks(result, ITEM), "links.sourceOnly")).toBe(true);
  });

  it("allows the original source URL", () => {
    expect(erroredOn(checkLinks(goodResult(), ITEM), "links.sourceOnly")).toBe(false);
  });

  it("errors on invented reference, bare and raw-HTML URLs", () => {
    for (const content of [
      "[текст][x]\n\n[x]: https://evil.example/reference",
      "https://evil.example/bare",
      '<iframe src="https://evil.example/frame"></iframe>',
    ]) {
      expect(erroredOn(checkLinks({ ...goodResult(), content }, ITEM), "links.sourceOnly")).toBe(
        true,
      );
    }
  });
});

describe("checkEditorialQuality", () => {
  it("errors on the generic AI template: generic heading plus three bullets", () => {
    const result = {
      ...goodResult(),
      content:
        "Компания представила обновление.\n\n## Основные изменения\n\n- быстрее\n- дешевле\n- удобнее\n\nИсточник: [Хабр](https://ex.com/article)",
    };
    expect(erroredOn(checkEditorialQuality(result, ITEM), "voice.genericTemplate")).toBe(true);
  });

  it("errors when a manual first-person draft loses the author's voice", () => {
    const item = {
      ...ITEM,
      url: "",
      feedTitle: "Прислано вручную",
      snippet: "Я неделю тестировал агент и понял, где он ломается.",
    };
    const result = {
      ...goodResult(),
      content: "Автор неделю тестировал агент и нашёл сбой.",
    };
    expect(erroredOn(checkEditorialQuality(result, item), "voice.preserveFirstPerson")).toBe(true);
  });

  it("keeps first-person voice in a manual draft", () => {
    const item = { ...ITEM, url: "", snippet: "Я неделю тестировал агент." };
    const result = { ...goodResult(), content: "Я неделю тестировал агент и нашёл сбой." };
    expect(erroredOn(checkEditorialQuality(result, item), "voice.preserveFirstPerson")).toBe(false);
  });
});

describe("checkFactuality", () => {
  it("errors on a numeral absent from the source", () => {
    const result = { ...goodResult(), content: "Модель ускорилась в 2 раза." };
    expect(erroredOn(checkFactuality(result, ITEM), "facts.numbers")).toBe(true);
  });

  it("allows a numeral stated in the source", () => {
    const item = { ...ITEM, title: "Релиз Linux 6.20", snippet: "Вышло ядро Linux 6.20." };
    const result = { ...goodResult(), content: "Linux 6.20 уже доступен." };
    expect(erroredOn(checkFactuality(result, item), "facts.numbers")).toBe(false);
  });

  it("ignores numerals that appear only inside the canonical source URL", () => {
    const item = { ...ITEM, url: "https://ex.com/articles/900001" };
    const result = {
      ...goodResult(),
      content: "Текст без чисел.\n\nИсточник: [Хабр](https://ex.com/articles/900001)",
    };
    expect(erroredOn(checkFactuality(result, item), "facts.numbers")).toBe(false);
  });

  it("warns on a long quote absent from the source", () => {
    const result = {
      ...goodResult(),
      content: "Разработчики заявили: «Эта модель полностью изменит рынок уже завтра».",
    };
    const findings = checkFactuality(result, ITEM);
    expect(warnedOn(findings, "facts.quotes")).toBe(true);
    // Warn, not error: rhetorical guillemets are normal RU prose, so this must
    // stay visible without failing the case.
    expect(erroredOn(findings, "facts.quotes")).toBe(false);
  });

  it("warns on an unsupported long quote in the description", () => {
    const result = {
      ...goodResult(),
      description: "Разработчики обещают: «Эта модель полностью изменит рынок уже завтра».",
    };
    expect(warnedOn(checkFactuality(result, ITEM), "facts.quotes")).toBe(true);
  });
});

describe("parseJudgeVerdict", () => {
  it("computes the total from the six quality dimensions", () => {
    expect(
      parseJudgeVerdict(
        JSON.stringify({
          headline: 18,
          hook: 13,
          readerValue: 18,
          brandVoice: 13,
          humanizer: 14,
          trust: 15,
          issues: [],
        }),
      ),
    ).toEqual({
      score: 91,
      headline: 18,
      hook: 13,
      readerValue: 18,
      brandVoice: 13,
      humanizer: 14,
      trust: 15,
      issues: [],
    });
  });

  it("rejects an incomplete or out-of-range rubric", () => {
    expect(parseJudgeVerdict('{"headline":20,"issues":[]}')).toBeNull();
    expect(
      parseJudgeVerdict(
        '{"headline":21,"hook":15,"readerValue":20,"brandVoice":15,"humanizer":15,"trust":15,"issues":[]}',
      ),
    ).toBeNull();
  });
});

describe("judge gate", () => {
  it("rejects malformed floor configuration instead of failing open", () => {
    expect(() => parseJudgeFloor("garbage")).toThrow(/EVAL_JUDGE_FLOOR/);
    expect(() => parseJudgeFloor("101")).toThrow(/EVAL_JUDGE_FLOOR/);
    expect(parseJudgeFloor(undefined)).toBe(80);
  });

  it("fails the case when the judge is unavailable", () => {
    expect(erroredOn(judgeGate(null, 80), "judge.unavailable")).toBe(true);
  });
});

describe("checkMeta", () => {
  it("errors on an empty description", () => {
    expect(erroredOn(checkMeta({ ...goodResult(), description: "" }), "desc.nonEmpty")).toBe(true);
  });
  it("warns on an over-long metaDescription", () => {
    expect(
      warnedOn(checkMeta({ ...goodResult(), metaDescription: "x".repeat(200) }), "meta.descLen"),
    ).toBe(true);
  });
});

describe("relevance checks", () => {
  it("parses a valid reply", () => {
    expect(parseRelevanceReply('{"score":3,"topic":"ии","reason":"по теме"}')).toEqual({
      score: 3,
      topic: "ии",
      reason: "по теме",
    });
  });
  it("returns null for non-JSON", () => {
    expect(parseRelevanceReply("not json")).toBeNull();
  });
  it("errors when the score is out of the expected band", () => {
    const reply = parseRelevanceReply('{"score":0,"topic":"x","reason":"y"}');
    expect(erroredOn(checkRelevance(reply, "on"), "relevance.band")).toBe(true);
  });
  it("errors on an out-of-range score", () => {
    const reply = parseRelevanceReply('{"score":9,"topic":"x","reason":"y"}');
    expect(erroredOn(checkRelevance(reply, "on"), "relevance.range")).toBe(true);
  });
  it("passes a score inside the band", () => {
    const reply = parseRelevanceReply('{"score":4,"topic":"ии","reason":"по теме"}');
    expect(isCasePassing(checkRelevance(reply, "on"))).toBe(true);
  });
  it("errors when the reply is unparsable (null)", () => {
    expect(erroredOn(checkRelevance(null, "gray"), "relevance.parse")).toBe(true);
  });
});

describe("release-confirm checks", () => {
  it("parses only a boolean release verdict", () => {
    expect(parseReleaseReply('{"release": true}')).toBe(true);
    expect(parseReleaseReply('{"release":false}')).toBe(false);
    expect(parseReleaseReply('{"release": "yes"}')).toBeNull();
    expect(parseReleaseReply("not json")).toBeNull();
    expect(parseReleaseReply(null)).toBeNull();
  });

  it("fails a wrong verdict and an unreadable reply", () => {
    expect(checkRelease(false, false).every((f) => f.ok)).toBe(true);
    expect(checkRelease(true, false).find((f) => f.id === "release.verdict")?.ok).toBe(false);
    expect(checkRelease(null, true)[0]).toMatchObject({ id: "release.parse", ok: false });
  });
});

describe("checkChannelRetell", () => {
  const LINK = "https://ex.com/agents";
  const item = {
    dedupKey: "u",
    url: "https://t.me/c/1",
    title: "t",
    snippet: "В посте 3 агента и цена $20. Подробности",
    html: `В посте <b>3 агента</b> и цена $20. <a href="${LINK}">Подробности</a>`,
    feedTitle: "@c",
    imageUrl: null,
    imageUrls: [],
    publishedAt: null,
  };
  const failed = (html: string, source = item) =>
    checkChannelRetell(html, source)
      .filter((f) => !f.ok)
      .map((f) => f.id);

  it("passes a formatted retelling with a source link and known numbers", () => {
    expect(
      failed(`<b>Автор собрал 3 агента</b> за $20. <a href="${LINK}/">Подробности</a>`),
    ).toEqual([]);
  });

  it("measures the RETELL_MAX cap on visible text, not on markup", () => {
    expect(failed(`<b>${"x".repeat(RETELL_MAX)}</b>`)).not.toContain("channel.length");
    expect(failed(`<i>${"x".repeat(RETELL_MAX + 1)}</i>`)).toContain("channel.length");
  });

  it("keeps one credit line even when the model writes its own", () => {
    expect(failed("Автор собрал 3 агента.\nИсточник: @c — https://t.me/c/1")).not.toContain(
      "channel.source",
    );
  });

  it("flags a link the source post does not have, as <a> or as bare text", () => {
    expect(failed('Собрал 3 агента, <a href="https://evil.com/x">тут</a>')).toContain(
      "channel.links",
    );
    expect(failed("Собрал 3 агента, смотрите t.me/other")).toContain("channel.links");
    expect(failed("Собрал 3 агента, смотрите www.ex.com")).toContain("channel.links");
  });

  it("flags unknown, unclosed or stray tags in the model reply", () => {
    expect(failed("<h1>Собрал 3 агента</h1>")).toContain("channel.markup");
    expect(failed("<b>Собрал 3 агента")).toContain("channel.markup");
    expect(failed("Собрал 3 агента</i>")).toContain("channel.markup");
    expect(failed('<a href="/relative">Собрал</a> 3 агента')).toContain("channel.markup");
    expect(failed("<strong>Собрал</strong> 3 агента<br/>ещё")).not.toContain("channel.markup");
  });

  it("flags new numbers and markdown in the visible text", () => {
    expect(failed("Собрал 7 агентов **жирно**")).toEqual(
      expect.arrayContaining(["channel.numbers", "channel.markdown"]),
    );
  });

  it("compares numbers after normalising decimal comma and digit-group spaces", () => {
    const priced = { ...item, snippet: "цена $0,24 и 2 500 запросов", html: "" };
    expect(failed("цена 0.24 и 2500 запросов", priced)).toEqual([]);
  });

  it("does not glue numbers from neighbouring lines (abstractDL tariff list)", () => {
    const tariffs = {
      ...item,
      snippet: "100$ = x5\n200$ = x10 (было x20 раньше)\n500$ = x25",
      html: "",
    };
    expect(
      failed("за 100 долларов — x5, за 200 долларов — x10 вместо x20, за 500 — x25", tariffs),
    ).toEqual([]);
  });
});

describe("checkDress", () => {
  const item = {
    dedupKey: "u",
    url: "https://t.me/c/1",
    title: "t",
    snippet: "Квоты: 100$ = x5, 200$ = x10 (раньше было x20).",
    feedTitle: "@c",
    imageUrl: null,
    imageUrls: [],
    publishedAt: null,
  };
  const good = {
    rubric: "инструмент",
    why: "Проверь лимиты на тарифе за $200",
    coverTitle: "Codex урезал квоты вдвое",
    coverFact: "$200: было x20, стало x10",
  };
  const failing = (dress: object) =>
    checkDress(JSON.stringify(dress), item.snippet)
      .filter((f) => !f.ok)
      .map((f) => `${f.id}:${f.severity}`);

  it("passes a dress built only from the source's facts", () => {
    expect(failing(good)).toEqual([]);
  });

  it("warns when production drops a field for an invented number", () => {
    expect(failing({ ...good, coverFact: "в 3 раза меньше" })).toEqual([
      "dress.numbers:warn",
      "dress.dropped:warn",
    ]);
  });

  it("fails an invented number in the cover title: the whole dress is lost", () => {
    expect(failing({ ...good, coverTitle: "Codex урезал квоты в 3 раза" })).toEqual([
      "dress.numbers:error",
    ]);
  });

  it("warns on a long title and fails one the cover would cut", () => {
    expect(failing({ ...good, coverTitle: "д".repeat(61) })).toEqual(["dress.title:warn"]);
    expect(failing({ ...good, coverTitle: "д".repeat(94) })).toEqual(["dress.title:error"]);
  });

  it("warns when production would drop the why line or the fact", () => {
    expect(failing({ ...good, why: "Читай https://ex.com" })).toEqual(["dress.dropped:warn"]);
    expect(failing({ ...good, coverFact: "x".repeat(51) })).toEqual(["dress.dropped:warn"]);
  });

  it("warns on a long dash", () => {
    expect(failing({ ...good, why: "Квоты урезали — проверь лимиты" })).toEqual([
      "dress.dash:warn",
    ]);
  });
});
