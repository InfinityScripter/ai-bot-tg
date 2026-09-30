import { z } from "zod";

import { ChannelRubric } from "../enums.js";

/**
 * The digest item writer's reply: "not news, skip it" or one card. Caps are
 * loose on purpose: the 80-character title and the 450-character text are
 * enforced by code after cleaning, so a slightly long reply is cut or
 * shortened instead of being thrown away as invalid.
 */
const SkippedItem = z.object({ skip: z.literal(true) });

const WrittenItem = z.object({
  skip: z.literal(false),
  emoji: z.string().trim().max(32),
  rubric: z.nativeEnum(ChannelRubric),
  title: z.string().trim().min(1).max(200),
  html: z.string().trim().min(1).max(4000),
});

export const DigestItemReplySchema = z.discriminatedUnion("skip", [SkippedItem, WrittenItem]);

export type DigestItem = Omit<z.infer<typeof WrittenItem>, "skip">;
