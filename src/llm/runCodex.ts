import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { rm, mkdtemp, readFile, writeFile } from "node:fs/promises";

import { CONFIG } from "../config.js";

/**
 * Codex features switched off for every run: group replies and the rewrite
 * provider alike carry untrusted text (chat messages, feed items). With them
 * off the model has no shell, browser, plugins or apps — only text in, text
 * out. A live probe (2026-10-01): asked to `cat ~/.codex/auth.json`, the
 * tool-less run answered "no tools"; the same prompt without these flags went
 * straight to a shell command. This list is the security boundary, not the
 * prompt. `memories` is off too: Codex's own cross-session memory would keep
 * what group members wrote in CODEX_HOME.
 */
export const DISABLED_CODEX_FEATURES = [
  "shell_tool",
  "unified_exec",
  "code_mode_host",
  "apps",
  "plugins",
  "remote_plugin",
  "browser_use",
  "in_app_browser",
  "memories",
  "hooks",
] as const;

export interface CodexOptions {
  /** Model for `--model`; defaults to CHAT_REPLY_MODEL. */
  model?: string;
  /** JSON Schema for `--output-schema`; omitted = free text, the caller extracts the JSON. */
  schema?: object;
}

/** `codex exec` arguments; the prompt itself goes through stdin. */
export function codexArgs(
  workDir: string,
  schemaFile: string | null,
  outFile: string,
  model: string = CONFIG.CHAT_REPLY_MODEL,
): string[] {
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
    model,
    "-c",
    "model_reasoning_effort=low",
    ...DISABLED_CODEX_FEATURES.flatMap((f) => ["--disable", f]),
    ...(schemaFile ? ["--output-schema", schemaFile] : []),
    "--output-last-message",
    outFile,
    "-",
  ];
}

/**
 * The child's environment: only what codex needs to start and find its login.
 * The bot's process.env holds the Telegram token and the blog/LLM keys; none of
 * them may reach a process that untrusted text talks to.
 */
export function codexEnv(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const keep = ["PATH", "HOME", "CODEX_HOME", "LANG", "TMPDIR"];
  return Object.fromEntries(keep.filter((k) => source[k]).map((k) => [k, source[k]]));
}

async function runOnce(prompt: string, options: CodexOptions): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "codex-run-"));
  const schemaFile = options.schema ? join(dir, "schema.json") : null;
  const outFile = join(dir, "out.txt");
  try {
    if (schemaFile) await writeFile(schemaFile, JSON.stringify(options.schema));
    await new Promise<void>((resolve, reject) => {
      const child = spawn(
        CONFIG.CHAT_REPLY_CODEX_BIN,
        codexArgs(dir, schemaFile, outFile, options.model),
        {
          cwd: dir,
          env: codexEnv(),
          stdio: ["pipe", "ignore", "pipe"],
          // SIGKILL, not the default SIGTERM: a process that ignores SIGTERM would
          // otherwise outlive the timeout and hold the one-at-a-time queue.
          timeout: CONFIG.CHAT_REPLY_TIMEOUT_MS,
          killSignal: "SIGKILL",
        },
      );
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

// One run at a time per process: the group responder, the avatar and the
// rewrite provider share one auth.json, and OpenAI supports one login per
// serialized job stream — two parallel token refreshes could corrupt it.
let queue: Promise<unknown> = Promise.resolve();

/** Runs one tool-less Codex turn after the previous one finished; returns its final message. */
export function runCodex(prompt: string, options: CodexOptions = {}): Promise<string> {
  const next = queue.then(() => runOnce(prompt, options));
  queue = next.catch(() => undefined);
  return next;
}
