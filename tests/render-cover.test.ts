import { it, vi, expect, describe } from "vitest";

import { ChannelRubric } from "../src/enums.js";
import {
  coverSvg,
  wrapTitle,
  renderCover,
  coverSpecFor,
  tryRenderCover,
} from "../src/blog/renderCover.js";

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47];

describe("wrapTitle", () => {
  it("fits a short title on one line", () => {
    expect(wrapTitle("Codex урезал квоты вдвое", 24, 3)).toEqual(["Codex урезал квоты вдвое"]);
  });

  it("breaks between words, never inside one that fits", () => {
    expect(wrapTitle("Anthropic выпустила Claude Opus 5.5 для всех", 20, 3)).toEqual([
      "Anthropic выпустила",
      "Claude Opus 5.5 для",
      "всех",
    ]);
  });

  it("hard-splits a word longer than a line", () => {
    expect(wrapTitle("Суперкалифрагилистический", 10, 3)).toEqual([
      "Суперкалиф",
      "рагилистич",
      "еский",
    ]);
  });

  it("ends the last allowed line with an ellipsis when the title does not fit", () => {
    const lines = wrapTitle("один два три четыре пять шесть семь восемь", 10, 2);
    expect(lines).toHaveLength(2);
    expect(lines[1]!.endsWith("…")).toBe(true);
    expect(lines.every((line) => line.length <= 10)).toBe(true);
  });
});

describe("coverSvg", () => {
  it("escapes model text so it cannot break out of the SVG", () => {
    const svg = coverSvg({
      title: `<script>alert(1)</script> & "q"`,
      fact: "x < y",
      rubric: ChannelRubric.Tool,
      date: "01.10",
    });
    expect(svg).not.toContain("<script>");
    expect(svg).toContain("&lt;script&gt;");
    expect(svg).toContain("&amp;");
    expect(svg).toContain("x &lt; y");
  });

  it("shows the rubric, the date and the fact line", () => {
    const svg = coverSvg({
      title: "Codex урезал квоты вдвое",
      fact: "$200: было x20, стало x10",
      rubric: ChannelRubric.Tool,
      date: "01.10",
    });
    expect(svg).toContain("&gt; инструмент");
    expect(svg).toContain("01.10");
    expect(svg).toContain("$200: было x20, стало x10");
  });

  it("falls back to the channel name without a rubric and drops an empty fact", () => {
    const svg = coverSvg({ title: "Заголовок", fact: "", rubric: null, date: "01.10" });
    expect(svg).toContain("&gt; ai first");
    expect(svg.match(/<text/g)).toHaveLength(4);
  });

  it("shrinks the font for a long title instead of cutting it", () => {
    const short = coverSvg({ title: "Коротко", fact: "", rubric: null, date: "01.10" });
    const long = coverSvg({
      title: "Очень длинный заголовок, который не помещается в три строки крупным шрифтом",
      fact: "",
      rubric: null,
      date: "01.10",
    });
    expect(short).toContain('font-size="76"');
    expect(long).toContain('font-size="60"');
    expect(long).not.toContain("…");
  });
});

describe("renderCover", () => {
  it("renders a PNG with Cyrillic text", () => {
    const png = renderCover({
      title: "Codex урезал квоты вдвое",
      fact: "$200: было x20, стало x10",
      rubric: ChannelRubric.Tool,
      date: "01.10",
    });
    expect([...png.subarray(0, 4)]).toEqual(PNG_MAGIC);
    expect(png.length).toBeGreaterThan(5000);
  });
});

describe("coverSpecFor", () => {
  const NOW = new Date("2026-09-30T22:30:00Z");

  it("takes the title, fact and rubric from the dress and dates in Moscow time", () => {
    const dress = {
      rubric: ChannelRubric.Model,
      why: "",
      coverTitle: "Вышла модель",
      coverFact: "в 2 раза быстрее",
    };
    expect(coverSpecFor(dress, "Длинный заголовок статьи", NOW)).toEqual({
      title: "Вышла модель",
      fact: "в 2 раза быстрее",
      rubric: ChannelRubric.Model,
      date: "01.10",
    });
  });

  it("falls back to the post title, cut to three small lines, without a rubric", () => {
    const spec = coverSpecFor(null, `  ${"слово ".repeat(40)}`, NOW);
    expect(spec.rubric).toBeNull();
    expect(spec.fact).toBe("");
    expect(spec.title.length).toBeLessThanOrEqual(91);
    expect(spec.title.endsWith("…")).toBe(true);
  });
});

describe("tryRenderCover", () => {
  it("returns null and logs instead of throwing", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const broken = {
      fact: "",
      rubric: null,
      date: "01.10",
      get title(): string {
        throw new Error("boom");
      },
    };
    expect(tryRenderCover(broken)).toBeNull();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("boom"));
    warn.mockRestore();
  });
});

describe("cover text hygiene", () => {
  it("drops characters XML forbids and emoji the font cannot draw", () => {
    const svg = coverSvg({
      title: "⚡️ GLM\u0000 вышла\u0008 🚀",
      fact: "",
      rubric: null,
      date: "01.10",
    });
    expect(svg).toContain(">GLM вышла</text>");
    expect(() =>
      renderCover({ title: "a\u0000b", fact: "", rubric: null, date: "01.10" }),
    ).not.toThrow();
  });
});

describe("renderCover without its fonts", () => {
  it("throws instead of drawing a cover with no text", async () => {
    vi.resetModules();
    vi.doMock("node:fs", async (importOriginal) => ({
      ...(await importOriginal<typeof import("node:fs")>()),
      existsSync: () => false,
    }));
    const { renderCover: render } = await import("../src/blog/renderCover.js");
    expect(() => render({ title: "x", fact: "", rubric: null, date: "01.10" })).toThrow(/font/);
    vi.doUnmock("node:fs");
  });
});
