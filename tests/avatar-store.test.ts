import { it, expect, describe } from "vitest";

const { AvatarStore } = await import("../src/avatar/avatarStore.js");

const chunk = (title: string, body: string) => ({ title, url: `https://b/post/${title}`, body });

describe("AvatarStore", () => {
  it("remembers allowed chats and forgets them", () => {
    const s = new AvatarStore(":memory:");
    expect(s.isAllowed(-100)).toBe(false);
    s.allowChat(-100, "AI-чат");
    s.allowChat(-100, "AI-чат (новое имя)");
    expect(s.isAllowed(-100)).toBe(true);
    expect(s.listChats()).toEqual([{ chatId: -100, title: "AI-чат (новое имя)" }]);
    s.forgetChat(-100);
    expect(s.isAllowed(-100)).toBe(false);
  });

  it("stores the profile", () => {
    const s = new AvatarStore(":memory:");
    expect(s.getProfile()).toBe("");
    s.setProfile("Пишу про ИИ в разработке.");
    expect(s.getProfile()).toBe("Пишу про ИИ в разработке.");
  });

  it("is on by default and remembers the owner's switch", () => {
    const s = new AvatarStore(":memory:");
    expect(s.isEnabled()).toBe(true);
    s.setEnabled(false);
    expect(s.isEnabled()).toBe(false);
    s.setEnabled(true);
    expect(s.isEnabled()).toBe(true);
  });

  it("counts calls per chat per day", () => {
    const s = new AvatarStore(":memory:");
    expect(s.countCall(-1, "2026-10-09")).toBe(1);
    expect(s.countCall(-1, "2026-10-09")).toBe(2);
    expect(s.countCall(-2, "2026-10-09")).toBe(1);
    expect(s.callsOn(-1, "2026-10-10")).toBe(0);
    expect(s.callsOn(-1, "2026-10-09")).toBe(2);
  });

  it("searches the blog index by Russian word prefixes and swaps it whole", () => {
    const s = new AvatarStore(":memory:");
    s.replaceChunks([
      chunk("a", "Я пишу про нейроагентов каждый день"),
      chunk("b", "Рецепт пирога"),
    ]);
    expect(s.chunkCount()).toBe(2);
    expect(s.search('"нейроа"*', 5).map((c) => c.title)).toEqual(["a"]);
    s.replaceChunks([chunk("c", "Только новое")]);
    expect(s.search('"нейроа"*', 5)).toEqual([]);
    expect(s.chunkCount()).toBe(1);
  });

  it("finds nothing for an empty expression", () => {
    const s = new AvatarStore(":memory:");
    s.replaceChunks([chunk("a", "текст")]);
    expect(s.search("", 5)).toEqual([]);
  });

  it("adds all chunks of missing posts once and preserves existing profile and content", () => {
    const s = new AvatarStore(":memory:");
    s.setProfile("Synthetic voice only");
    s.replaceChunks([chunk("old", "Old evidence")]);
    s.addChunks([chunk("new", "First new paragraph"), chunk("new", "Second new paragraph")]);
    s.addChunks([chunk("old", "Unwanted replacement"), chunk("new", "Unwanted duplicate")]);
    expect(s.chunkCount()).toBe(3);
    expect([...s.indexedUrls()].sort()).toEqual(["https://b/post/new", "https://b/post/old"]);
    expect(s.search('"old"*', 5)[0]?.body).toBe("Old evidence");
    expect(s.search('"paragraph"*', 5)).toHaveLength(2);
    expect(s.getProfile()).toBe("Synthetic voice only");
    s.close();
  });
});
