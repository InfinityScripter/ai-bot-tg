import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { it, expect, describe, afterEach, beforeEach } from "vitest";

import { CandidateStore } from "../src/store/index.js";
import { markAsTrial, dryRunTarget, copyRuntimeOverrides } from "../scripts/dryRunGuards.js";

describe("dryRunTarget", () => {
  it("returns the owner chat", () => {
    expect(dryRunTarget(123456789, undefined)).toBe(123456789);
    expect(dryRunTarget(123456789, "-1001234567890")).toBe(123456789);
  });

  it("refuses the channel chat id, however it is written", () => {
    expect(() => dryRunTarget(777, "777")).toThrow(/канал/);
    expect(() => dryRunTarget(777, " 777 ")).toThrow(/канал/);
  });

  it("refuses a target that is not a private chat", () => {
    expect(() => dryRunTarget(-1001234567890, "@ai_first_news")).toThrow(/канал/);
  });
});

describe("markAsTrial", () => {
  const assembled = {
    slot: { key: "2026-10-01/evening", title: "AI за вечер · 1 октября" },
    article: { html: "<h3>AI за вечер · 1 октября</h3>\n<ol></ol>", photos: [], items: [] },
    fallbackText: "<b>AI за вечер · 1 октября</b>\n\ncards",
  };

  it("prefixes the title of the article and of the text fallback, not the slot", () => {
    const marked = markAsTrial(assembled);
    expect(marked.article.html).toContain("<h3>[проба] AI за вечер · 1 октября</h3>");
    expect(marked.fallbackText).toContain("<b>[проба] AI за вечер · 1 октября</b>");
    expect(marked.slot).toEqual(assembled.slot);
  });

  it("throws when the title is not where it is expected, instead of sending an unmarked issue", () => {
    expect(() =>
      markAsTrial({ ...assembled, article: { ...assembled.article, html: "<p/>" } }),
    ).toThrow(/заголовок/);
  });
});

describe("copyRuntimeOverrides", () => {
  let dir: string;
  let ledgerPath: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "dry-run-"));
    ledgerPath = path.join(dir, "candidates.db");
    const ledger = new CandidateStore(ledgerPath);
    ledger.setModelOverride("openrouter", "openai/gpt-6-luna");
    ledger.setMockOverride(false);
    ledger.close();
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("copies the model and mock overrides into the in-memory store", () => {
    const memory = new CandidateStore(":memory:");
    expect(copyRuntimeOverrides(memory, ledgerPath)).toBe(2);
    expect(memory.getModelOverride()).toEqual({
      provider: "openrouter",
      model: "openai/gpt-6-luna",
    });
    expect(memory.getMockOverride()).toEqual({ enabled: false });
    memory.close();
  });

  it("leaves the ledger database file byte for byte untouched, and later writes stay in memory", () => {
    const before = fs.readFileSync(ledgerPath);
    const memory = new CandidateStore(":memory:");
    copyRuntimeOverrides(memory, ledgerPath);
    memory.setModelOverride("claude", "other");
    memory.close();
    expect(fs.readFileSync(ledgerPath).equals(before)).toBe(true);
  });

  it("opens the ledger read-only: a missing file is an error, not a new empty ledger", () => {
    const memory = new CandidateStore(":memory:");
    const missing = path.join(dir, "absent.db");
    expect(() => copyRuntimeOverrides(memory, missing)).toThrow();
    expect(fs.existsSync(missing)).toBe(false);
    memory.close();
  });

  it("copies nothing when the ledger has no overrides", () => {
    const empty = path.join(dir, "empty.db");
    new CandidateStore(empty).close();
    const memory = new CandidateStore(":memory:");
    expect(copyRuntimeOverrides(memory, empty)).toBe(0);
    expect(memory.getModelOverride()).toBeNull();
    memory.close();
  });
});
