import { z } from "zod";

import { ChannelRubric } from "../enums.js";

/**
 * The channel-dress role's output: rubric, the "why it matters" line and the
 * cover text. Caps are loose on purpose: an over-long `why` or `coverFact` is
 * dropped by finalizeDress rather than failing the whole dress.
 */
export const ChannelDressSchema = z.object({
  rubric: z.nativeEnum(ChannelRubric),
  why: z.string().trim().max(600),
  coverTitle: z.string().trim().min(1).max(200),
  coverFact: z.string().trim().max(200),
});

export type ChannelDress = z.infer<typeof ChannelDressSchema>;
