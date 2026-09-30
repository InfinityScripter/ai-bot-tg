import { it, expect, describe } from "vitest";

import { CandidateKind, CandidateState } from "../src/enums.js";
import { renderRetellPreview } from "../src/bot/renderRetell.js";

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
  it("shows the visible text, its length and the photo count, not the markup", () => {
    const card = renderRetellPreview(
      CANDIDATE,
      { html: '<b>Заголовок</b> &amp; <a href="https://ex.com/a">ссылка</a>' },
      "glm",
      2,
    );
    expect(card).toContain("(18 симв., фото: 2)");
    expect(card).toContain("Заголовок & ссылка");
    expect(card).not.toContain("<b>");
    expect(card).not.toContain("href");
  });

  it("warns that a retelling over the caption limit goes out without its photos", () => {
    const long = { html: `<b>${"д".repeat(1030)}</b>` };
    expect(renderRetellPreview(CANDIDATE, long, "glm", 2)).toContain(
      "длиннее 1024 — уйдёт без фото",
    );
    expect(renderRetellPreview(CANDIDATE, long, "glm", 0)).not.toContain("без фото");
    expect(renderRetellPreview(CANDIDATE, { html: "<b>коротко</b>" }, "glm", 2)).not.toContain(
      "без фото",
    );
  });
});
