import { it, expect, describe } from "vitest";

const { AvatarStore } = await import("../src/avatar/avatarStore.js");
const { buildSearchQuery } = await import("../src/avatar/searchQuery.js");

describe("buildSearchQuery", () => {
  it("turns words into quoted 6-letter prefixes joined by OR", () => {
    expect(buildSearchQuery(["Как ты пишешь про нейроагентов?"])).toBe('"пишешь"* OR "нейроа"*');
  });

  it("dedups prefixes and drops stop words and short words", () => {
    expect(buildSearchQuery(["агенты Агенты агентов просто это ты"])).toBe(
      '"агенты"* OR "агенто"*',
    );
  });

  it("keeps the short terms an AI blog lives on: 3-letter words and 2-letter acronyms", () => {
    expect(buildSearchQuery(["Что думаешь про ИИ, RAG и LLM?"])).toBe(
      '"думаеш"* OR "ии"* OR "rag"* OR "llm"*',
    );
  });

  it("caps the number of terms at 12", () => {
    // Digits first, so every word has its own 6-character prefix.
    const words = Array.from({ length: 20 }, (_, i) => `${String(i).padStart(2, "0")}слово`);
    expect(buildSearchQuery([words.join(" ")]).split(" OR ")).toHaveLength(12);
  });

  it("returns an empty string when nothing is searchable", () => {
    expect(buildSearchQuery(["ок, да"])).toBe("");
  });

  it("never lets chat text break the FTS5 syntax", () => {
    const store = new AvatarStore(":memory:");
    store.replaceChunks([{ title: "t", url: "u", body: "текст" }]);
    const hostile = buildSearchQuery(['NEAR(title: "x" AND body:^ * ) OR "кавычка']);
    expect(() => store.search(hostile, 5)).not.toThrow();
  });

  it("finds a post by a different word form", () => {
    const store = new AvatarStore(":memory:");
    store.replaceChunks([{ title: "Агенты", url: "u", body: "Я пишу про нейроагентов" }]);
    expect(store.search(buildSearchQuery(["что думаешь про нейроагенты?"]), 5)).toHaveLength(1);
  });
});
