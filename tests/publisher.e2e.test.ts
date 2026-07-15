import type { AddressInfo } from "node:net";

import http from "node:http";
import { it, vi, expect, afterAll, describe, beforeAll } from "vitest";

import { DEFAULT_COVERS } from "../src/blog/defaultCovers.js";

import type { RewriteResult } from "../src/types.js";

// Live e2e for the bot's publisher: instead of mocking fetch, it sends a REAL
// HTTP request over the wire to a throwaway server that asserts the exact
// contract the blog backend enforces (POST /api/post/new, Bearer BOT_API_TOKEN,
// the buildNewPostPayload body shape) and replies 201 with { post: { id } }.
// This is the client-side half of the cross-repo contract; the server-side half
// is proved by the backend's bot-publish.e2e.test.ts against the real route.

const REWRITE: RewriteResult = {
  title: "E2E новость",
  description: "Краткое резюме",
  content: "# Тело\n\nАбзац. Источник: Feed",
  tags: ["новости", "тест"],
  metaTitle: "E2E новость",
  metaDescription: "SEO описание",
};

interface CapturedRequest {
  method?: string;
  authorization?: string;
  contentType?: string;
  body: unknown;
}

let server: http.Server;
let port: number;
let captured: CapturedRequest | null = null;

beforeAll(async () => {
  // The bot's config reads these at import; set BLOG_API_URL after we know the
  // port via vi.stubEnv before importing the publisher.
  server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c as Buffer));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      captured = {
        method: req.method,
        authorization: req.headers.authorization,
        contentType: req.headers["content-type"],
        body: raw ? JSON.parse(raw) : null,
      };
      // Mimic the backend's success envelope.
      res.writeHead(201, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: true, post: { id: "e2e-post-1" } }));
    });
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      ({ port } = server.address() as AddressInfo);
      resolve();
    });
  });
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("E2E: publishToBlog sends the real request over the wire", () => {
  it("POSTs the correct contract and returns the post id", async () => {
    // Point the publisher at our live server (BOT_API_TOKEN comes from setup.ts).
    vi.stubEnv("BLOG_API_URL", `http://127.0.0.1:${port}`);
    vi.resetModules();
    const { publishToBlog } = await import("../src/blog/publishPost.js");

    const id = await publishToBlog(REWRITE);
    expect(id).toBe("e2e-post-1");

    expect(captured).not.toBeNull();
    expect(captured!.method).toBe("POST");
    expect(captured!.authorization).toBe("Bearer test-bot-api-token-value");
    expect(captured!.contentType).toBe("application/json");
    // No cover passed → publisher always fills a themed default keyed off title.
    const body = captured!.body as Record<string, unknown>;
    expect(DEFAULT_COVERS).toContain(body.coverUrl);
    const { coverUrl: _coverUrl, ...rest } = body;
    expect(rest).toEqual({
      title: "E2E новость",
      description: "Краткое резюме",
      content: "# Тело\n\nАбзац. Источник: Feed",
      tags: ["новости", "тест"],
      metaTitle: "E2E новость",
      metaDescription: "SEO описание",
      metaKeywords: ["новости", "тест"],
      publish: "published",
    });

    vi.unstubAllEnvs();
  });
});
