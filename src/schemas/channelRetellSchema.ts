import { z } from "zod";

/**
 * The retell role's output: one Telegram post body in Telegram HTML. The prompt
 * asks for ≤ 900 visible characters; markup and long hrefs come on top, and the
 * cap leaves slack so a slightly long answer is cut by the gate (with an owner
 * card), not thrown away as invalid.
 */
export const ChannelRetellSchema = z.object({
  html: z.string().trim().min(1).max(4000),
});

export type ChannelRetell = z.infer<typeof ChannelRetellSchema>;
