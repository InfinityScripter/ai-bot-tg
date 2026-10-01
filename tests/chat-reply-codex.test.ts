import { it, expect, describe } from "vitest";

import { codexEnv, codexArgs, DISABLED_CODEX_FEATURES } from "../src/chatReply/runCodex.js";

describe("codex run for the public group is tool-less and secret-free", () => {
  it("switches off every tool that could touch the host", () => {
    const args = codexArgs("/tmp/w", "/tmp/w/schema.json", "/tmp/w/out.txt");
    for (const feature of ["shell_tool", "unified_exec", "browser_use", "plugins", "apps"]) {
      const i = args.indexOf(feature);
      expect(i, feature).toBeGreaterThan(0);
      expect(args[i - 1]).toBe("--disable");
    }
    expect(args.filter((a) => a === "--disable")).toHaveLength(DISABLED_CODEX_FEATURES.length);
  });

  it("runs read-only, ephemeral, without the owner's config, rules or a git repo", () => {
    const args = codexArgs("/tmp/w", "/tmp/w/schema.json", "/tmp/w/out.txt");
    expect(args[args.indexOf("--sandbox") + 1]).toBe("read-only");
    expect(args).toEqual(
      expect.arrayContaining(["--ephemeral", "--ignore-user-config", "--ignore-rules"]),
    );
    expect(args[args.indexOf("--cd") + 1]).toBe("/tmp/w");
    expect(args.at(-1)).toBe("-");
  });

  it("passes only PATH/HOME-level variables, never the bot's tokens", () => {
    const env = codexEnv({
      PATH: "/usr/bin",
      HOME: "/home/bot",
      TELEGRAM_BOT_TOKEN: "secret",
      OPENROUTER_API_KEY: "secret",
      BOT_API_TOKEN: "secret",
    });
    expect(env).toEqual({ PATH: "/usr/bin", HOME: "/home/bot" });
  });
});
