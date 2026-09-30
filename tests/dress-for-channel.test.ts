import { it, vi, expect, describe, afterEach } from "vitest";

const completeChatJson = vi.fn();
vi.mock("../src/llm/chatCompletion.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/llm/chatCompletion.js")>();
  return { ...actual, completeChatJson: (...a: unknown[]) => completeChatJson(...a) };
});

const { dressForChannel, finalizeDress, dropInventions, WHY_MAX, FACT_MAX, DRESS_TIMEOUT_MS } =
  await import("../src/llm/dressForChannel.js");
const { buildDressUserContent, DRESS_INPUT_MAX } = await import("../src/llm/dressPrompt.js");
const { CandidateStore } = await import("../src/store/index.js");
import { ChannelRubric } from "../src/enums.js";

const DRESS = {
  rubric: "инструмент",
  why: "Сидишь на тарифе за $200 и упираешься в лимиты? Проверь баланс кредитов.",
  coverTitle: "Codex урезал квоты вдвое",
  coverFact: "$200: было x20, стало x10",
};
const POST = { title: "", text: "OpenAI поменяли квоты Codex: $200 теперь x10 вместо x20." };

afterEach(() => {
  completeChatJson.mockReset();
});

describe("finalizeDress", () => {
  it("accepts a valid dress and trims the strings", () => {
    const dress = finalizeDress(JSON.stringify({ ...DRESS, coverTitle: "  Codex урезал квоты  " }));
    expect(dress).toEqual({
      ...DRESS,
      rubric: ChannelRubric.Tool,
      coverTitle: "Codex урезал квоты",
    });
  });

  it("rejects an unknown rubric and the code-only digest rubric", () => {
    expect(() => finalizeDress(JSON.stringify({ ...DRESS, rubric: "новости" }))).toThrow(
      /валидацию/,
    );
    expect(() => finalizeDress(JSON.stringify({ ...DRESS, rubric: "дайджест" }))).toThrow(
      /дайджест/,
    );
  });

  it("rejects a missing or broken reply with a readable error", () => {
    expect(() => finalizeDress(null)).toThrow(/не вернул JSON/);
    expect(() => finalizeDress("{oops")).toThrow(/невалидный JSON/);
  });

  it("drops a why line that is too long or carries a link or a handle", () => {
    const long = finalizeDress(JSON.stringify({ ...DRESS, why: "а".repeat(WHY_MAX + 1) }));
    expect(long.why).toBe("");
    for (const why of ["Читай https://ex.com", "Подпишись на @some_channel", "Смотри www.ex.com"]) {
      expect(finalizeDress(JSON.stringify({ ...DRESS, why })).why).toBe("");
    }
  });

  it("drops a cover fact longer than one cover line", () => {
    const dress = finalizeDress(JSON.stringify({ ...DRESS, coverFact: "1".repeat(FACT_MAX + 1) }));
    expect(dress.coverFact).toBe("");
  });
});

describe("dropInventions", () => {
  const dress = { ...DRESS, rubric: ChannelRubric.Tool };
  const SOURCE = "Квоты Codex: 100$ = x5, 200$ = x10 (было x20), кредиты на 2 500$.";

  it("keeps a dress whose numbers all come from the post", () => {
    expect(dropInventions(dress, SOURCE)).toEqual(dress);
  });

  it("drops only the why line or the fact that invents a number", () => {
    expect(dropInventions({ ...dress, why: "Сэкономишь 30%" }, SOURCE)?.why).toBe("");
    expect(dropInventions({ ...dress, coverFact: "1000+ текстов" }, SOURCE)).toEqual({
      ...dress,
      coverFact: "",
    });
  });

  it("drops a why line with a domain or a handle the post does not have", () => {
    expect(dropInventions({ ...dress, why: "Обнови Node.js до свежей версии" }, SOURCE)?.why).toBe(
      "",
    );
    expect(dropInventions({ ...dress, why: "Спроси у @openai_devs" }, SOURCE)?.why).toBe("");
    const known = "Вышел Node.js 22, спрашивайте @openai_devs";
    expect(dropInventions({ ...dress, why: "Обнови Node.js" }, known)?.why).toBe("Обнови Node.js");
  });

  it("drops the whole dress when the cover title invents a number", () => {
    expect(
      dropInventions({ ...dress, coverTitle: "Codex урезал квоты в 3 раза" }, SOURCE),
    ).toBeNull();
  });
});

describe("buildDressUserContent", () => {
  it("wraps the post as JSON data and caps its length", () => {
    const user = buildDressUserContent({
      title: "Заголовок",
      text: "я".repeat(DRESS_INPUT_MAX * 2),
    });
    expect(user.startsWith("<post_json>\n")).toBe(true);
    const json = JSON.parse(user.replace(/^<post_json>\n|\n<\/post_json>$/g, ""));
    expect(json.title).toBe("Заголовок");
    expect(json.text.length).toBeLessThanOrEqual(DRESS_INPUT_MAX + 1);
  });
});

describe("dressForChannel", () => {
  it("drops a cover fact with a number the post does not have", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    completeChatJson.mockResolvedValue(JSON.stringify({ ...DRESS, coverFact: "в 5 раз меньше" }));
    const store = new CandidateStore(":memory:");
    expect((await dressForChannel(POST, store))?.coverFact).toBe("");
    store.close();
  });

  it("returns the model's dress", async () => {
    completeChatJson.mockResolvedValue(JSON.stringify(DRESS));
    const store = new CandidateStore(":memory:");
    expect(await dressForChannel(POST, store)).toEqual({ ...DRESS, rubric: ChannelRubric.Tool });
    const [, , req] = completeChatJson.mock.calls[0] as [unknown, unknown, { user: string }];
    expect(req.user).toContain("OpenAI поменяли квоты Codex");
    store.close();
  });

  it("returns null instead of failing the post when the model errors or answers garbage", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const store = new CandidateStore(":memory:");
    completeChatJson.mockRejectedValueOnce(new Error("timeout"));
    expect(await dressForChannel(POST, store)).toBeNull();
    completeChatJson.mockResolvedValueOnce(JSON.stringify({ html: "не то" }));
    expect(await dressForChannel(POST, store)).toBeNull();
    expect(warn).toHaveBeenCalledTimes(2);
    store.close();
    warn.mockRestore();
  });

  it("returns null when even the active model cannot be resolved", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const store = new CandidateStore(":memory:");
    store.close();
    expect(await dressForChannel(POST, store)).toBeNull();
    expect(completeChatJson).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("gives up after DRESS_TIMEOUT_MS instead of holding the post", async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    completeChatJson.mockReturnValue(new Promise(() => {}));
    const store = new CandidateStore(":memory:");

    const pending = dressForChannel(POST, store);
    await vi.advanceTimersByTimeAsync(DRESS_TIMEOUT_MS);

    expect(await pending).toBeNull();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("timed out"));
    store.close();
    warn.mockRestore();
    vi.useRealTimers();
  });

  it("makes no call and returns null in mock mode", async () => {
    const store = new CandidateStore(":memory:");
    store.setMockOverride(true);
    expect(await dressForChannel(POST, store)).toBeNull();
    expect(completeChatJson).not.toHaveBeenCalled();
    store.close();
  });
});
