import { z } from "zod";

/**
 * The group responder's reply: speak or stay silent. `text` is present in both
 * shapes because the Codex `--output-schema` (strict mode) requires every
 * property; a silent reply carries an empty string that is never sent.
 */
export const ChatReplySchema = z.object({
  action: z.enum(["reply", "silent"]),
  text: z.string().trim().max(4000).default(""),
});

export type ChatReply = z.infer<typeof ChatReplySchema>;

/** The same contract as JSON Schema, for `codex exec --output-schema`. */
export const CHAT_REPLY_JSON_SCHEMA = {
  type: "object",
  properties: {
    action: { type: "string", enum: ["reply", "silent"] },
    text: { type: "string" },
  },
  required: ["action", "text"],
  additionalProperties: false,
} as const;

/** One remembered exchange; rows that fail it are dropped on load. */
export const ChatTurnSchema = z.object({
  at: z.number(),
  userId: z.number(),
  name: z.string(),
  text: z.string(),
  reply: z.string(),
});
