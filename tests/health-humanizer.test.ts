import { it, vi, expect, describe, afterEach } from "vitest";

import type { HumanizeOutcome } from "../src/llm/humanize.js";

const config = vi.hoisted(() => ({ HEMMINGWAY_API_KEY: "test-hemmingway-key" as string }));
vi.mock("../src/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/config.js")>();
  return {
    CONFIG: new Proxy(actual.CONFIG, {
      get: (t, k) => (k in config ? config[k as "HEMMINGWAY_API_KEY"] : t[k as keyof typeof t]),
    }),
  };
});
const last = vi.hoisted(() => ({ outcome: null as HumanizeOutcome | null }));
vi.mock("../src/llm/humanize.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/llm/humanize.js")>();
  return { ...actual, lastHumanizeOutcome: () => last.outcome };
});

const { checkHumanizer } = await import("../src/health/probeChecks.js");

const accepted = (async () => new Response("{}", { status: 200 })) as unknown as typeof fetch;
const AT = new Date("2026-09-30T09:00:00Z");

afterEach(() => {
  config.HEMMINGWAY_API_KEY = "test-hemmingway-key";
  last.outcome = null;
});

describe("checkHumanizer", () => {
  it("is ok and says off when no key is set", async () => {
    config.HEMMINGWAY_API_KEY = "";
    const check = await checkHumanizer(accepted);
    expect(check).toMatchObject({ ok: true, detail: expect.stringContaining("выключен") });
  });

  it("fails when Hemmingway rejects the key", async () => {
    const denied = (async () => new Response("", { status: 401 })) as unknown as typeof fetch;
    expect(await checkHumanizer(denied)).toMatchObject({
      ok: false,
      detail: expect.stringContaining("401"),
    });
  });

  it("fails when the latest pass fell back to the original text", async () => {
    last.outcome = { ok: false, at: AT, error: "длина 900 → 200 вне допуска" };
    expect(await checkHumanizer(accepted)).toMatchObject({
      ok: false,
      detail: expect.stringContaining("вне допуска"),
    });
  });

  it("is ok with an accepted key and a successful latest pass", async () => {
    last.outcome = { ok: true, at: AT };
    expect(await checkHumanizer(accepted)).toMatchObject({ ok: true });
  });
});
