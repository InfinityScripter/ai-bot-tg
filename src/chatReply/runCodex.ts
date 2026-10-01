import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { rm, mkdtemp, readFile, writeFile } from "node:fs/promises";

import { CONFIG } from "../config.js";
import { CHAT_REPLY_JSON_SCHEMA } from "../schemas/chatReplySchema.js";

/**
 * Codex features switched off for every group reply. With them off the model
 * has no shell, browser, plugins or apps — only text in, text out. A live
 * probe (2026-10-01): asked to `cat ~/.codex/auth.json`, the tool-less run
 * answered "no tools"; the same prompt without these flags went straight to a
 * shell command. A public chat must never reach a shell, so this list is the
 * security boundary, not the prompt.
 */
export const DISABLED_CODEX_FEATURES = [
  "shell_tool",
  "unified_exec",
  "apps",
  "plugins",
  "remote_plugin",
  "browser_use",
  "in_app_browser",
] as const;

/** `codex exec` arguments; the prompt itself goes through stdin. */
export function codexArgs(workDir: string, schemaFile: string, outFile: string): string[] {
  return [
    "exec",
    "--skip-git-repo-check",
    "--ephemeral",
    "--ignore-user-config",
    "--ignore-rules",
    "--sandbox",
    "read-only",
    "--cd",
    workDir,
    "--model",
    CONFIG.CHAT_REPLY_MODEL,
    "-c",
    "model_reasoning_effort=low",
    ...DISABLED_CODEX_FEATURES.flatMap((f) => ["--disable", f]),
    "--output-schema",
    schemaFile,
    "--output-last-message",
    outFile,
    "-",
  ];
}

/**
 * The child's environment: only what codex needs to start and find its login.
 * The bot's process.env holds the Telegram token and the blog/LLM keys; none of
 * them may reach a process that a public chat talks to.
 */
export function codexEnv(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const keep = ["PATH", "HOME", "CODEX_HOME", "LANG", "TMPDIR"];
  return Object.fromEntries(keep.filter((k) => source[k]).map((k) => [k, source[k]]));
}

/** Runs one tool-less Codex turn and returns its final message text. */
export async function runCodex(prompt: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "chat-reply-"));
  const schemaFile = join(dir, "schema.json");
  const outFile = join(dir, "out.txt");
  try {
    await writeFile(schemaFile, JSON.stringify(CHAT_REPLY_JSON_SCHEMA));
    await new Promise<void>((resolve, reject) => {
      const child = spawn(CONFIG.CHAT_REPLY_CODEX_BIN, codexArgs(dir, schemaFile, outFile), {
        cwd: dir,
        env: codexEnv(),
        stdio: ["pipe", "ignore", "pipe"],
        // SIGKILL, not the default SIGTERM: a process that ignores SIGTERM would
        // otherwise outlive the timeout and hold the one-at-a-time answer queue.
        timeout: CONFIG.CHAT_REPLY_TIMEOUT_MS,
        killSignal: "SIGKILL",
      });
      let stderr = "";
      child.stderr.on("data", (chunk: Buffer) => {
        stderr = (stderr + chunk.toString()).slice(-2000);
      });
      child.on("error", reject);
      // "exit", not "close": close also waits for every pipe, and a grandchild
      // (a wrapper script's codex) can keep stderr open long after the kill.
      child.on("exit", (code, signal) => {
        if (code === 0) resolve();
        else reject(new Error(`codex exited ${code ?? signal}: ${stderr.trim().slice(-500)}`));
      });
      // A codex that exits before reading the prompt makes the write fail with
      // EPIPE; unhandled, that error would crash the bot. The exit code above
      // already reports the failure.
      child.stdin.on("error", () => {});
      child.stdin.end(prompt);
    });
    return await readFile(outFile, "utf8");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
