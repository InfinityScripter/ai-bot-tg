import { it, expect, describe } from "vitest";

import { renderRetellPreview } from "../src/bot/renderRetell.js";
import { CandidateKind, ChannelRubric, CandidateState } from "../src/enums.js";

import type { Candidate } from "../src/types.js";

const CANDIDATE: Candidate = {
  id: 1,
  dedupKey: "tg:ai_for_devs/640",
  sourceUrl: "https://t.me/ai_for_devs/640",
  sourceTitle: "t",
  feedTitle: "@ai_for_devs",
  imageUrl: null,
  snippet: null,
  imageUrls: null,
  sourceHtml: null,
  kind: CandidateKind.Channel,
  autoPublish: false,
  state: CandidateState.PendingReview,
  rewriteJson: null,
  tgMessageId: null,
  blogPostId: null,
  error: null,
  createdAt: "2026-09-30",
  updatedAt: "2026-09-30",
};

describe("renderRetellPreview", () => {
  it("shows the visible text, its length and the cover title, not the markup", () => {
    const card = renderRetellPreview(
      CANDIDATE,
      {
        html: '<b>Заголовок</b> &amp; <a href="https://ex.com/a">ссылка</a>',
        dress: {
          rubric: ChannelRubric.Tool,
          why: "",
          coverTitle: "Вышел_инструмент",
          coverFact: "",
        },
      },
      "glm",
    );
    expect(card).toContain("(18 симв.)");
    expect(card).toContain("Заголовок & ссылка");
    expect(card).toContain("🖼 Обложка: Вышел\\_инструмент");
    expect(card).not.toContain("<b>");
    expect(card).not.toContain("href");
  });

  it("names the first line as the cover title when there is no dress", () => {
    const card = renderRetellPreview(CANDIDATE, { html: "<b>Первая строка</b>\nдальше" }, "glm");
    expect(card).toContain("🖼 Обложка: первая строка поста");
  });

  it("warns that a retelling over the caption limit goes out without its cover", () => {
    const long = { html: `<b>${"д".repeat(1030)}</b>` };
    expect(renderRetellPreview(CANDIDATE, long, "glm")).toContain(
      "длиннее 1024 — уйдёт без обложки",
    );
    expect(renderRetellPreview(CANDIDATE, { html: "<b>коротко</b>" }, "glm")).not.toContain(
      "без обложки",
    );
  });
});
