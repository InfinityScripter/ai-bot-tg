import { tmpdir } from "node:os";
import { join } from "node:path";
import { it, expect, describe } from "vitest";
import { rmSync, chmodSync, mkdtempSync, writeFileSync } from "node:fs";

// A stand-in for the codex binary, set before src/config.ts is first imported.
// It ignores SIGTERM and leaves a background child holding stderr open — what a
// stuck codex or a wrapper script does — or, when an "exit-now" file sits next
// to it, quits at once without reading its stdin. A flag file, not an env var:
// codexEnv() strips everything but PATH-level variables from the child.
const dir = mkdtempSync(join(tmpdir(), "fake-codex-"));
const bin = join(dir, "codex");
writeFileSync(
  bin,
  '#!/bin/sh\nif [ -f "$(dirname "$0")/exit-now" ]; then exit 3; fi\ntrap "" TERM\nsleep 30 &\nwait\nwait\n',
);
chmodSync(bin, 0o755);
process.env.CHAT_REPLY_CODEX_BIN = bin;
process.env.CHAT_REPLY_TIMEOUT_MS = "300";

const { runCodex } = await import("../src/chatReply/runCodex.js");

describe("runCodex process handling", () => {
  it("gives up at the timeout even when a grandchild keeps the pipes open", async () => {
    const started = Date.now();
    await expect(runCodex("hi")).rejects.toThrow(/codex exited/);
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it("rejects instead of crashing when codex exits before reading a large prompt", async () => {
    const flag = join(dir, "exit-now");
    writeFileSync(flag, "");
    try {
      await expect(runCodex("x".repeat(2_000_000))).rejects.toThrow(/codex exited 3/);
    } finally {
      rmSync(flag);
    }
  });
});
