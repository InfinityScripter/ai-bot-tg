import { it, vi, expect, describe } from "vitest";

// The same token as the news bot (tests/setup.ts TELEGRAM_BOT_TOKEN), set before config loads.
process.env.AVATAR_BOT_TOKEN = "test:telegram-token";

const { CandidateStore } = await import("../src/store/index.js");
const { startAvatarSide } = await import("../src/avatar/index.js");

describe("starting the avatar side", () => {
  it("refuses the news bot's own token and tells the owner, so both bots do not get 409", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const notifyOwner = vi.fn(async (_text: string) => undefined);
    const hope = { speaker: { canSpeak: vi.fn(), speak: vi.fn() }, onPostComment: vi.fn() };
    expect(startAvatarSide(new CandidateStore(":memory:"), hope, notifyOwner)).toBeNull();
    expect(notifyOwner).toHaveBeenCalledWith(expect.stringContaining("токен новостного бота"));
    expect(hope.onPostComment).not.toHaveBeenCalled();
  });
});
