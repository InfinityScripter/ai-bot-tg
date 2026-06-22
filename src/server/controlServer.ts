import { timingSafeEqual } from "node:crypto";
import { type Server, createServer, type ServerResponse, type IncomingMessage } from "node:http";

import { probeAllModels } from "../health/index.js";
import { pingModel, PROVIDERS ,
  listModels,
  MODEL_PRICES,
  isMockActive,
  CONTROL_PROVIDERS,
  isControlProvider,
  resolveActiveProvider,
} from "../llm/index.js";

import type { CandidateStore } from "../store/index.js";

export interface ControlServerOptions {
  port: number;
  token: string;
  store: CandidateStore;
  /** Next scheduled run, or null. Kept for future use; not in the V1 status body. */
  nextRun: () => Date | null;
  /** Model ping, injectable for tests; defaults to the real pingModel. */
  pingFn?: typeof pingModel;
  /** Full-matrix model health, injectable for tests; defaults to probeAllModels. */
  probeModelsFn?: typeof probeAllModels;
}

export interface ControlServerHandle {
  server: Server;
  close: () => Promise<void>;
}

interface EnrichedModel {
  id: string;
  tier: "free" | "paid";
  note?: string;
}

/** Constant-time token comparison; false on any length mismatch. */
function tokenMatches(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** Joins listModels output with MODEL_PRICES into {id,tier,note} objects. */
function enrich(models: string[]): EnrichedModel[] {
  return models.map((id) => {
    const price = MODEL_PRICES[id];
    if (!price) return { id, tier: "paid" };
    return price.note ? { id, tier: price.tier, note: price.note } : { id, tier: price.tier };
  });
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

/** Reads a JSON request body, capped at 64KB. Resolves {} on empty/invalid. */
function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > 64_000) raw = raw.slice(0, 64_000);
    });
    req.on("end", () => {
      if (!raw) {
        resolve({});
        return;
      }
      try {
        const parsed: unknown = JSON.parse(raw);
        resolve(
          typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {},
        );
      } catch {
        resolve({});
      }
    });
    req.on("error", () => resolve({}));
  });
}

/**
 * The localhost-only admin control server. Binds 127.0.0.1 (never 0.0.0.0),
 * authenticates every request with a constant-time Bearer check, and exposes a
 * minimal surface to read/set the active model + the mock toggle. Reuses the
 * rewriter's own provider/model logic so the panel and the bot can never drift.
 * Never logs the Authorization header or request bodies.
 */
export function startControlServer(opts: ControlServerOptions): ControlServerHandle {
  const { port, token, store } = opts;
  const pingFn = opts.pingFn ?? pingModel;
  const probeModelsFn = opts.probeModelsFn ?? probeAllModels;

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const auth = req.headers.authorization;
    if (!auth || !auth.startsWith("Bearer ")) {
      return send(res, 401, { error: "Unauthorized" });
    }
    if (!tokenMatches(auth.slice("Bearer ".length), token)) {
      return send(res, 403, { error: "Forbidden" });
    }

    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const path = url.pathname;
    const method = req.method ?? "GET";

    if (method === "GET" && path === "/control/status") {
      const { provider, model } = resolveActiveProvider(store);
      // Single source of truth for the mock toggle state, shared with the bot's
      // /model menu so the panel and Telegram never disagree.
      return send(res, 200, { provider, model, isMockEnabled: isMockActive(store) });
    }

    if (method === "GET" && path === "/control/providers") {
      const providers = CONTROL_PROVIDERS.map((name) => ({
        name,
        label: PROVIDERS[name].label,
        hasKey: Boolean(PROVIDERS[name].apiKey()),
      }));
      return send(res, 200, { providers });
    }

    if (method === "GET" && path === "/control/models") {
      const provider = url.searchParams.get("provider") ?? "";
      if (!isControlProvider(provider)) {
        return send(res, 400, { error: "Unknown provider" });
      }
      const models = enrich(await listModels(provider));
      return send(res, 200, { provider, models });
    }

    if (method === "GET" && path === "/control/models/health") {
      // Pings the default model of every admin-controllable provider so the panel
      // can show which actually work. Slow (one ping per provider) — the panel
      // refreshes it on demand, not on a poll.
      const report = await probeModelsFn();
      return send(res, 200, report);
    }

    if (method === "POST" && path === "/control/model") {
      const body = await readJson(req);
      const provider = typeof body.provider === "string" ? body.provider : "";
      const model = typeof body.model === "string" ? body.model : "";
      if (!isControlProvider(provider) || !model) {
        return send(res, 400, { error: "Unknown provider or empty model" });
      }
      const ping = await pingFn(provider, model);
      if (!ping.ok) {
        return send(res, 400, { error: ping.error });
      }
      store.setModelOverride(provider, model);
      // Selecting a model is an explicit "use this provider" intent; clear any
      // mock override so the choice actually takes effect (mock otherwise wins
      // in resolveActiveProvider and the switch would be a silent no-op).
      store.clearMockOverride();
      return send(res, 200, { ok: true, validation: "pinged" });
    }

    if (method === "POST" && path === "/control/mock") {
      const body = await readJson(req);
      if (typeof body.enabled !== "boolean") {
        return send(res, 400, { error: "enabled must be a boolean" });
      }
      store.setMockOverride(body.enabled);
      return send(res, 200, { ok: true, isMockEnabled: body.enabled });
    }

    return send(res, 404, { error: "Not found" });
  }

  const server = createServer((req, res) => {
    void handle(req, res).catch((err: unknown) => {
      // Never log headers/body — only the method, path, and error message.
      // eslint-disable-next-line no-console
      console.error(
        `[control] ${req.method} ${req.url} failed: ${err instanceof Error ? err.message : "error"}`,
      );
      if (!res.headersSent) send(res, 500, { error: "Internal error" });
    });
  });

  // A bind failure (EADDRINUSE if the port is taken, EACCES, …) is emitted
  // asynchronously as an 'error' event; with no listener Node rethrows it as an
  // uncaught exception that kills the WHOLE bot. The control server is optional,
  // so swallow + log instead — the news pipeline must keep running regardless.
  server.on("error", (err: NodeJS.ErrnoException) => {
    // eslint-disable-next-line no-console
    console.error(
      `[control] failed to bind 127.0.0.1:${port}: ${err.message}; control server disabled`,
    );
  });

  server.listen(port, "127.0.0.1");

  return {
    server,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}
