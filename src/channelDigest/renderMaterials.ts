import { escapeHtml } from "../feeds/telegramHtml.js";
import { isExternalSourceUrl, sourceLinksFromHtml } from "../sourceLinks.js";

import type { IssueItem } from "./types.js";

/** Added after the 450-character editorial text; both message budgets count this line. */
export function renderMaterials(item: IssueItem): string {
  // Match the same trailing-slash tolerance as the model's source allow-list.
  const present = new Set(
    sourceLinksFromHtml(item.html).map(({ url }) => new URL(url).href.replace(/\/+$/, "")),
  );
  const missing = (item.sourceLinks ?? []).filter(
    ({ url }) => isExternalSourceUrl(url) && !present.has(new URL(url).href.replace(/\/+$/, "")),
  );
  const links = missing.map(
    ({ url, label }) => `<a href="${escapeHtml(url)}">${escapeHtml(label)}</a>`,
  );
  return links.length ? `Материалы: ${links.join(" · ")}` : "";
}
