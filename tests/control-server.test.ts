import type { AddressInfo } from "node:net";

import { it, expect, describe, afterEach, beforeEach } from "vitest";

import { CandidateStore } from "../src/store/index.js";
import { startControlServer } from "../src/server/controlServer.js";

const TOKEN = "test-control-token-0123456789";

// Stubbed ping so /control/model and the model-health probe never touch the
// network in tests (the real providers are OpenAI-compat and would fetch).
const okPing = async () => ({ ok: true as const });

async function makeServer(
  overrides: Partial<Parameters<typeof startControlServer>[0]> = {},
) {
  const store = new CandidateStore(":memory:");
  const handle = startControlServer({
    port: 0,
    token: TOKEN,
    store,
    nextRun: () => null,
    pingFn: okPing,
    ...overrides,
  });
  await new Promise<void>((resolve) => handle.server.once("listening", () => resolve()));
  const addr = handle.server.address() as AddressInfo;
  return { store, handle, base: `http://127.0.0.1:${addr.port}` };
}

describe("control server auth", () => {
  let ctx: Awaited<ReturnType<typeof makeServer>>;
  beforeEach(async () => {
    ctx = await makeServer();
  });
  afterEach(async () => {
    await ctx.handle.close();
    ctx.store.close();
  });

  it("401 without Authorization", async () => {
    const r = await fetch(`${ctx.base}/control/status`);
    expect(r.status).toBe(401);
  });

  it("403 with a wrong token", async () => {
    const r = await fetch(`${ctx.base}/control/status`, {
      headers: { Authorization: "Bearer wrong-token-also-16chars" },
    });
    expect(r.status).toBe(403);
  });

  it("200 + status shape with the right token", async () => {
    const r = await fetch(`${ctx.base}/control/status`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body).toMatchObject({
      provider: expect.any(String),
      model: expect.any(String),
      isMockEnabled: false,
    });
  });

  it("binds to loopback only", () => {
    const addr = ctx.handle.server.address() as AddressInfo;
    expect(addr.address === "127.0.0.1" || addr.address === "::1").toBe(true);
  });
});

describe("control server endpoints", () => {
  let ctx: Awaited<ReturnType<typeof makeServer>>;
  const auth = { Authorization: `Bearer ${TOKEN}` };
  beforeEach(async () => {
    ctx = await makeServer();
  });
  afterEach(async () => {
    await ctx.handle.close();
    ctx.store.close();
  });

  it("providers returns only glm, deepseek, openrouter (no mock — it has its own toggle)", async () => {
    const r = await fetch(`${ctx.base}/control/providers`, { headers: auth });
    const body = (await r.json()) as { providers: { name: string }[] };
    expect(body.providers.map((p) => p.name)).toEqual(["glm", "deepseek", "openrouter"]);
  });

  it("models 400s an unknown provider", async () => {
    const r = await fetch(`${ctx.base}/control/models?provider=anthropic`, { headers: auth });
    expect(r.status).toBe(400);
  });

  it("models 400s mock (removed from the dropdown)", async () => {
    const r = await fetch(`${ctx.base}/control/models?provider=mock`, { headers: auth });
    expect(r.status).toBe(400);
  });

  it("models returns enriched objects for a control provider", async () => {
    const r = await fetch(`${ctx.base}/control/models?provider=glm`, { headers: auth });
    expect(r.status).toBe(200);
    const body = (await r.json()) as { models: { id: string; tier: string }[] };
    expect(Array.isArray(body.models)).toBe(true);
    expect(body.models[0]).toHaveProperty("id");
    expect(body.models[0]).toHaveProperty("tier");
  });

  it("POST /control/model writes the override (ping stubbed ok)", async () => {
    const r = await fetch(`${ctx.base}/control/model`, {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({ provider: "glm", model: "glm-4.7-flash" }),
    });
    expect(r.status).toBe(200);
    expect(ctx.store.getModelOverride()).toEqual({ provider: "glm", model: "glm-4.7-flash" });
  });

  it("POST /control/model 400s an unknown provider", async () => {
    const r = await fetch(`${ctx.base}/control/model`, {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({ provider: "anthropic", model: "claude-haiku-4-5" }),
    });
    expect(r.status).toBe(400);
  });

  it("POST /control/model 400s mock (no longer a dropdown provider)", async () => {
    const r = await fetch(`${ctx.base}/control/model`, {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({ provider: "mock", model: "mock" }),
    });
    expect(r.status).toBe(400);
  });

  it("GET /control/models/health returns a checks array + healthy flag", async () => {
    const probeStub = async () => ({
      healthy: false,
      checks: [
        { provider: "glm", label: "GLM", model: "glm-4.7-flash", ok: true, ms: 12 },
        {
          provider: "deepseek",
          label: "DeepSeek",
          model: "deepseek-v4-flash",
          ok: false,
          ms: 8000,
          error: "timeout",
        },
      ],
    });
    const local = await makeServer({ probeModelsFn: probeStub });
    try {
      const r = await fetch(`${local.base}/control/models/health`, { headers: auth });
      expect(r.status).toBe(200);
      const body = (await r.json()) as {
        healthy: boolean;
        checks: { provider: string; ok: boolean }[];
      };
      expect(body.healthy).toBe(false);
      expect(body.checks).toHaveLength(2);
      expect(body.checks[0]).toMatchObject({ provider: "glm", ok: true });
      expect(body.checks[1]).toMatchObject({ provider: "deepseek", ok: false, error: "timeout" });
    } finally {
      await local.handle.close();
      local.store.close();
    }
  });

  it("POST /control/mock writes the override", async () => {
    const r = await fetch(`${ctx.base}/control/mock`, {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: true }),
    });
    expect(r.status).toBe(200);
    expect(ctx.store.getMockOverride()).toEqual({ enabled: true });
  });

  it("POST /control/model clears a stale mock override so the choice takes effect", async () => {
    ctx.store.setMockOverride(true); // mock currently ON
    const r = await fetch(`${ctx.base}/control/model`, {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({ provider: "glm", model: "glm-4.7-flash" }),
    });
    expect(r.status).toBe(200);
    expect(ctx.store.getModelOverride()).toEqual({ provider: "glm", model: "glm-4.7-flash" });
    expect(ctx.store.getMockOverride()).toBeNull(); // mock override cleared
  });

  it("GET /control/status isMockEnabled tracks the mock override (not env)", async () => {
    ctx.store.setMockOverride(true);
    const on = await (await fetch(`${ctx.base}/control/status`, { headers: auth })).json();
    expect((on as { isMockEnabled: boolean }).isMockEnabled).toBe(true);

    ctx.store.setMockOverride(false);
    const off = await (await fetch(`${ctx.base}/control/status`, { headers: auth })).json();
    expect((off as { isMockEnabled: boolean }).isMockEnabled).toBe(false);
  });
});
