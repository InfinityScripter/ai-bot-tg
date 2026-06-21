import type { AddressInfo } from "node:net";

import { it, expect, describe, afterEach, beforeEach } from "vitest";

import { CandidateStore } from "../src/store.js";
import { startControlServer } from "../src/control-server.js";

const TOKEN = "test-control-token-0123456789";

async function makeServer() {
  const store = new CandidateStore(":memory:");
  const handle = startControlServer({ port: 0, token: TOKEN, store, nextRun: () => null });
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

  it("providers returns only glm, deepseek, mock", async () => {
    const r = await fetch(`${ctx.base}/control/providers`, { headers: auth });
    const body = (await r.json()) as { providers: { name: string }[] };
    expect(body.providers.map((p) => p.name)).toEqual(["glm", "deepseek", "mock"]);
  });

  it("models 400s an unknown provider", async () => {
    const r = await fetch(`${ctx.base}/control/models?provider=anthropic`, { headers: auth });
    expect(r.status).toBe(400);
  });

  it("models returns enriched objects for mock", async () => {
    const r = await fetch(`${ctx.base}/control/models?provider=mock`, { headers: auth });
    expect(r.status).toBe(200);
    const body = (await r.json()) as { models: { id: string; tier: string }[] };
    expect(Array.isArray(body.models)).toBe(true);
    expect(body.models[0]).toHaveProperty("id");
    expect(body.models[0]).toHaveProperty("tier");
  });

  it("POST /control/model writes the override (mock pings ok)", async () => {
    const r = await fetch(`${ctx.base}/control/model`, {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({ provider: "mock", model: "mock" }),
    });
    expect(r.status).toBe(200);
    expect(ctx.store.getModelOverride()).toEqual({ provider: "mock", model: "mock" });
  });

  it("POST /control/model 400s an unknown provider", async () => {
    const r = await fetch(`${ctx.base}/control/model`, {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({ provider: "anthropic", model: "claude-haiku-4-5" }),
    });
    expect(r.status).toBe(400);
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
      body: JSON.stringify({ provider: "mock", model: "mock" }),
    });
    expect(r.status).toBe(200);
    expect(ctx.store.getModelOverride()).toEqual({ provider: "mock", model: "mock" });
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
