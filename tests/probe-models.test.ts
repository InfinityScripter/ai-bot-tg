import { it, vi, expect, describe } from "vitest";

import { probeAllModels } from "../src/health/index.js";
import { PROVIDERS, CONTROL_PROVIDERS } from "../src/llm/index.js";

describe("probeAllModels", () => {
  it("probes the default model of every control provider", async () => {
    const pingFn = vi.fn(async () => ({ ok: true as const }));
    const report = await probeAllModels({ pingFn });

    expect(report.healthy).toBe(true);
    expect(report.checks).toHaveLength(CONTROL_PROVIDERS.length);
    // Each control provider is probed once, with its DEFAULT model.
    for (const name of CONTROL_PROVIDERS) {
      const probe = report.checks.find((c) => c.provider === name);
      expect(probe).toBeDefined();
      expect(probe!.model).toBe(PROVIDERS[name].defaultModel);
      expect(probe!.label).toBe(PROVIDERS[name].label);
      expect(probe!.ok).toBe(true);
      expect(typeof probe!.ms).toBe("number");
    }
    expect(pingFn).toHaveBeenCalledTimes(CONTROL_PROVIDERS.length);
  });

  it("maps a failed ping to ok:false + error, and healthy:false overall", async () => {
    // First provider ok, the rest fail.
    let call = 0;
    const pingFn = vi.fn(async () => {
      call += 1;
      return call === 1 ? { ok: true as const } : { ok: false as const, error: "fetch failed" };
    });
    const report = await probeAllModels({ pingFn });

    expect(report.healthy).toBe(false);
    const failed = report.checks.filter((c) => !c.ok);
    expect(failed.length).toBeGreaterThan(0);
    expect(failed[0]!.error).toBe("fetch failed");
  });

  it("isolates a throwing ping into an error result, not a rejection", async () => {
    const pingFn = vi.fn(async () => {
      throw new Error("boom");
    });
    const report = await probeAllModels({ pingFn });

    expect(report.healthy).toBe(false);
    expect(report.checks.every((c) => !c.ok)).toBe(true);
    expect(report.checks[0]!.error).toMatch(/boom/);
  });
});
