import { it, vi, expect, describe, afterEach } from "vitest";

// A mutable CONFIG so one case can switch the key off; everything else is real.
const config = vi.hoisted(() => ({ HEMMINGWAY_API_KEY: "test-hemmingway-key" as string }));
vi.mock("../src/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/config.js")>();
  return {
    CONFIG: new Proxy(actual.CONFIG, {
      get: (t, k) => (k in config ? config[k as "HEMMINGWAY_API_KEY"] : t[k as keyof typeof t]),
    }),
  };
});

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

const { humanizeText, probeHemmingway, lastHumanizeOutcome } =
  await import("../src/llm/humanize.js");

const ORIGINAL = "Компания OpenAI представила новую модель — она вдвое быстрее прошлой.";
const REWRITTEN = "OpenAI показала новую модель. Она вдвое быстрее прошлой версии.";

function reply(content: string, status = 200, finish = "stop"): Response {
  return new Response(
    JSON.stringify({ choices: [{ finish_reason: finish, message: { content } }] }),
    { status },
  );
}

afterEach(() => {
  fetchMock.mockReset();
  config.HEMMINGWAY_API_KEY = "test-hemmingway-key";
});

describe("humanizeText", () => {
  it("returns the Hemmingway rewrite, asking hemmingway-27b at low reasoning effort", async () => {
    fetchMock.mockResolvedValueOnce(reply(`\n\n${REWRITTEN}`));
    expect(await humanizeText(ORIGINAL)).toBe(REWRITTEN);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://hemmingway.io/v1/chat/completions");
    const body = JSON.parse(init.body as string);
    expect(body.model).toBe("hemmingway-27b");
    expect(body.reasoning_effort).toBe("low");
    expect(body.messages[1].content).toBe(ORIGINAL);
    expect((init.headers as Record<string, string>).Authorization).toBe(
      "Bearer test-hemmingway-key",
    );
  });

  it("is off without a key: no request, original text", async () => {
    config.HEMMINGWAY_API_KEY = "";
    expect(await humanizeText(ORIGINAL)).toBe(ORIGINAL);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("keeps the original on an HTTP error", async () => {
    fetchMock.mockResolvedValueOnce(reply("", 500));
    expect(await humanizeText(ORIGINAL)).toBe(ORIGINAL);
  });

  it("keeps the original when the request throws (timeout, network)", async () => {
    fetchMock.mockRejectedValueOnce(new Error("The operation was aborted due to timeout"));
    expect(await humanizeText(ORIGINAL)).toBe(ORIGINAL);
  });

  it("keeps the original when the reply lost too much text (facts dropped)", async () => {
    fetchMock.mockResolvedValueOnce(reply("OpenAI показала модель."));
    expect(await humanizeText(ORIGINAL)).toBe(ORIGINAL);
  });

  it("keeps the original when the reply grew too much (content added)", async () => {
    fetchMock.mockResolvedValueOnce(reply(`${REWRITTEN} ${REWRITTEN}`));
    expect(await humanizeText(ORIGINAL)).toBe(ORIGINAL);
  });

  it("keeps the original on an empty reply", async () => {
    fetchMock.mockResolvedValueOnce(reply(""));
    expect(await humanizeText(ORIGINAL)).toBe(ORIGINAL);
  });

  it("keeps the original when the reply was cut at the token limit", async () => {
    fetchMock.mockResolvedValueOnce(reply(REWRITTEN, 200, "length"));
    expect(await humanizeText(ORIGINAL)).toBe(ORIGINAL);
  });

  it("remembers the latest outcome for /health", async () => {
    fetchMock.mockResolvedValueOnce(reply("", 401));
    await humanizeText(ORIGINAL);
    expect(lastHumanizeOutcome()).toMatchObject({
      ok: false,
      error: expect.stringContaining("401"),
    });
    fetchMock.mockResolvedValueOnce(reply(REWRITTEN));
    await humanizeText(ORIGINAL);
    expect(lastHumanizeOutcome()).toMatchObject({ ok: true });
  });
});

describe("probeHemmingway", () => {
  it("is null for an accepted key and names the status for a rejected one", async () => {
    const ok = vi.fn(async () => new Response("{}", { status: 200 }));
    expect(await probeHemmingway("k", ok as unknown as typeof fetch)).toBeNull();
    expect(ok).toHaveBeenCalledWith("https://hemmingway.io/v1/models", expect.anything());
    const denied = vi.fn(async () => new Response("", { status: 401 }));
    expect(await probeHemmingway("k", denied as unknown as typeof fetch)).toBe("ответил 401");
  });
});
