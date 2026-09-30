import { it, vi, expect, describe, beforeEach } from "vitest";

const fetchHtml = vi.fn();
vi.mock("../src/feeds/fetchHtml.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/feeds/fetchHtml.js")>();
  return { ...actual, fetchHtml: (...a: unknown[]) => fetchHtml(...a) };
});

const { fetchChannelPages } = await import("../src/feeds/fetchChannelPages.js");

const PAGE = `<div class="tgme_widget_message_wrap js-widget_message_wrap"><div class="tgme_widget_message text_not_supported_wrap js-widget_message" data-post="chan/5" data-view="x"> <div class="tgme_widget_message_bubble"> <div class="tgme_widget_message_text js-message_text" dir="auto">Hello world</div> <div class="tgme_widget_message_footer compact js-message_footer"> <div class="tgme_widget_message_info short js-message_info"> <span class="tgme_widget_message_views">1.2K</span><span class="copyonly"> views</span><span class="tgme_widget_message_meta"><a class="tgme_widget_message_date" href="https://t.me/chan/5"><time datetime="2026-09-30T07:37:00+00:00" class="time">07:37</time></a></span> </div> </div> </div></div></div>`;

const channels = [{ name: "chan", priority: false }];
const callsFor = (name: string) =>
  fetchHtml.mock.calls.filter((c) => String(c[0]).endsWith(`/${name}`)).length;

describe("fetchChannelPages retry", () => {
  beforeEach(() => {
    fetchHtml.mockReset();
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  it("retries a rejected page once and keeps it when the retry succeeds", async () => {
    fetchHtml.mockRejectedValueOnce(new Error("fetch failed")).mockResolvedValueOnce(PAGE);
    const { pages, failed } = await fetchChannelPages(channels, 0);
    expect(pages).toHaveLength(1);
    expect(failed).toEqual([]);
    expect(callsFor("chan")).toBe(2);
  });

  it("marks the page failed when the retry rejects too", async () => {
    fetchHtml.mockRejectedValue(new Error("fetch failed"));
    const { pages, failed } = await fetchChannelPages(channels, 0);
    expect(pages).toEqual([]);
    expect(failed).toEqual(["chan"]);
    expect(callsFor("chan")).toBe(2);
  });

  it("does not retry a page that fetched but has no posts", async () => {
    fetchHtml.mockResolvedValue("<html></html>");
    const { pages, failed } = await fetchChannelPages(channels, 0);
    expect(pages).toEqual([]);
    expect(failed).toEqual(["chan"]);
    expect(callsFor("chan")).toBe(1);
  });
});
