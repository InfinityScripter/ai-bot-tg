/**
 * Single source of truth for the tag vocabulary the REWRITE prompt shows the
 * model. Derived from {@link TAG_WHITELIST} so the prompt and the deterministic
 * `normalizeTags` safety net can never drift (they used to be two hand-copied
 * lists — R1 in the prompt-rework spec).
 *
 * `новости` is force-added first by `normalizeTags` on every post, so it is
 * EXCLUDED here: the model must not spend a slot on it. Everything else the model
 * may choose from is exactly what the whitelist accepts.
 */

import { NEWS_TAG, TAG_WHITELIST } from "../blog/normalizeTags.js";

/**
 * The topical tags the model may choose from, in whitelist order, minus the
 * mandatory `новости`. This is what gets interpolated into the rewrite prompt.
 */
export const MODEL_TAGS: readonly string[] = TAG_WHITELIST.filter((tag) => tag !== NEWS_TAG);

/**
 * The comma-joined vocabulary string interpolated into the rewrite prompt's
 * `tags` instruction, e.g. "технологии, наука, …". Lowercase, exactly the set
 * `normalizeTags` keeps (sans `новости`), so a model that obeys the prompt
 * produces tags that survive normalization unchanged.
 */
export const MODEL_TAG_LIST = MODEL_TAGS.join(", ");
