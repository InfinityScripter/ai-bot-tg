import { z } from "zod";

import { ChannelDressSchema } from "./channelDressSchema.js";

/**
 * The retell role's output: one Telegram post body in Telegram HTML. The prompt
 * asks for ≤ 720 visible characters; markup and long hrefs come on top, and the
 * cap leaves slack so a slightly long answer is cut by the gate (with an owner
 * card), not thrown away as invalid. `dress` is added by code after the model
 * (rubric and cover text); rows retold before it have none.
 */
export const ChannelRetellSchema = z.object({
  html: z.string().trim().min(1).max(4000),
  dress: ChannelDressSchema.optional(),
});

export type ChannelRetell = z.infer<typeof ChannelRetellSchema>;
