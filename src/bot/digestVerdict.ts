/**
 * The `{{ВЕРДИКТ}}` slot the LLM leaves verbatim in the digest HTML (see
 * llm/prompts.ts). The owner fills it with an editorial verdict before the
 * digest may go out; an unfilled slot must NEVER reach subscribers. Kept in its
 * own module so digestFlow.ts stays small and the placeholder text lives in one
 * place shared by the fill step and the send-time safety gate.
 */

/** The literal placeholder token, matched globally so a repeat is filled too. */
const VERDICT_PLACEHOLDER = /\{\{ВЕРДИКТ\}\}/g;

/** True if the html still contains at least one unfilled `{{ВЕРДИКТ}}` slot. */
export function hasVerdictPlaceholder(html: string): boolean {
  // Fresh regex per call: a /g RegExp carries lastIndex, so reusing the module
  // constant with .test() would alternate true/false across calls.
  return /\{\{ВЕРДИКТ\}\}/.test(html);
}

/** Replaces every `{{ВЕРДИКТ}}` slot with the owner-supplied verdict text. */
export function fillVerdict(html: string, verdict: string): string {
  return html.replace(VERDICT_PLACEHOLDER, verdict);
}
