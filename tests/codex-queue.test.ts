import { tmpdir } from "node:os";
import { join } from "node:path";
import { it, expect, describe } from "vitest";
import { chmodSync, existsSync, mkdtempSync, writeFileSync } from "node:fs";

// A stand-in codex that takes 200 ms and leaves an "overlap" file when it
// finds another run still busy. Set before src/config.ts is first imported.
const dir = mkdtempSync(join(tmpdir(), "fake-codex-queue-"));
const bin = join(dir, "codex");
writeFileSync(
  bin,
  [
    "#!/bin/sh",
    'out=""; prev=""',
    'for a in "$@"; do [ "$prev" = "--output-last-message" ] && out="$a"; prev="$a"; done',
    'd="$(dirname "$0")"',
    'if [ -f "$d/busy" ]; then touch "$d/overlap"; fi',
    'touch "$d/busy"; sleep 0.2; rm -f "$d/busy"',
    "cat > /dev/null",
    'echo ok > "$out"',
    "",
  ].join("\n"),
);
chmodSync(bin, 0o755);
process.env.CHAT_REPLY_CODEX_BIN = bin;

const { runCodex } = await import("../src/llm/runCodex.js");

describe("runCodex queue", () => {
  it("runs one codex at a time even when callers do not wait for each other", async () => {
    const replies = await Promise.all([runCodex("a"), runCodex("b"), runCodex("c")]);
    expect(replies.map((r) => r.trim())).toEqual(["ok", "ok", "ok"]);
    expect(existsSync(join(dir, "overlap"))).toBe(false);
  });
});
