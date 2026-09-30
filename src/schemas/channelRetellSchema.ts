import { z } from "zod";

/**
 * The retell role's output: one Telegram post body. The prompt asks for ≤ 900
 * characters; the schema allows some slack so a slightly long answer is cut by
 * the gate (with an owner card), not thrown away as invalid.
 */
export const ChannelRetellSchema = z.object({
  text: z.string().trim().min(1).max(1200),
});

export type ChannelRetell = z.infer<typeof ChannelRetellSchema>;
