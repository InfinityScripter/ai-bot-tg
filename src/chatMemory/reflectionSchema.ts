import { z } from "zod";

import type { Side } from "../debate/types.js";

const NOTE_KINDS = ["discussion", "joke", "material", "participant"] as const;
const sourceMessageIds = z.array(z.number().int().safe().positive()).min(1).max(8);
const NoteSchema = z
  .object({
    kind: z.enum(NOTE_KINDS),
    text: z.string().trim().min(1).max(1200),
    sourceMessageIds,
  })
  .strict();
const OpinionSchema = z
  .object({
    topic: z.string().trim().min(1).max(160),
    stance: z.string().trim().min(1).max(1200),
    reason: z.string().trim().min(1).max(1000),
    sourceMessageIds,
  })
  .strict();
const ReflectionSchema = z
  .object({
    side: z.enum(["hope", "avatar"]),
    notes: z.array(NoteSchema).max(12),
    opinions: z.array(OpinionSchema).max(8),
  })
  .strict();

export type Reflection = z.infer<typeof ReflectionSchema>;
export type ReflectionNote = z.infer<typeof NoteSchema>;
export type ReflectionOpinion = z.infer<typeof OpinionSchema>;

/** The runtime validator stays authoritative even if the model ignores its output schema. */
export function parseReflection(text: string | null, side: Side, sources: Set<number>): Reflection {
  if (text === null || text.length > 100_000) throw new Error("invalid reflection");
  const result = ReflectionSchema.parse(JSON.parse(text) as unknown);
  if (result.side !== side) throw new Error("wrong reflection side");
  const topics = result.opinions.map((opinion) => opinion.topic.toLowerCase());
  if (new Set(topics).size !== topics.length) throw new Error("duplicate opinion topic");
  for (const item of [...result.notes, ...result.opinions]) {
    if (
      new Set(item.sourceMessageIds).size !== item.sourceMessageIds.length ||
      item.sourceMessageIds.some((id) => !sources.has(id))
    ) {
      throw new Error("invalid reflection source");
    }
  }
  return result;
}

const sourceSchema = { type: "array", items: { type: "integer" } };
const noteProperties = {
  kind: { type: "string", enum: NOTE_KINDS },
  text: { type: "string" },
  sourceMessageIds: sourceSchema,
};
const opinionProperties = {
  topic: { type: "string" },
  stance: { type: "string" },
  reason: { type: "string" },
  sourceMessageIds: sourceSchema,
};

export const REFLECTION_JSON_SCHEMA = {
  type: "object",
  properties: {
    side: { type: "string", enum: ["hope", "avatar"] },
    notes: {
      type: "array",
      items: {
        type: "object",
        properties: noteProperties,
        required: Object.keys(noteProperties),
        additionalProperties: false,
      },
    },
    opinions: {
      type: "array",
      items: {
        type: "object",
        properties: opinionProperties,
        required: Object.keys(opinionProperties),
        additionalProperties: false,
      },
    },
  },
  required: ["side", "notes", "opinions"],
  additionalProperties: false,
} as const;
