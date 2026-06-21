import { it, expect, describe } from "vitest";

import {
  CB,
  statusText,
  encodeModel,
  modelButtons,
  parseCallback,
  encodeProvider,
  providerButtons,
  mockToggleButton,
} from "../src/bot-model.js";

describe("callback data round-trip", () => {
  it("encodes and parses a provider pick", () => {
    const data = encodeProvider("glm");
    expect(parseCallback(data)).toEqual({ kind: "provider", provider: "glm" });
  });

  it("encodes and parses a model pick, preserving dotted model ids", () => {
    const data = encodeModel("glm", "glm-4.7-flash");
    expect(parseCallback(data)).toEqual({
      kind: "model",
      provider: "glm",
      model: "glm-4.7-flash",
    });
  });

  it("parses reset and back", () => {
    expect(parseCallback(CB.RESET)).toEqual({ kind: "reset" });
    expect(parseCallback(CB.BACK)).toEqual({ kind: "back" });
  });

  it("returns null for unrelated callback data (e.g. approve_/skip_)", () => {
    expect(parseCallback("approve_12")).toBeNull();
    expect(parseCallback("skip_3")).toBeNull();
    expect(parseCallback("whatever")).toBeNull();
  });

  it("returns null for an unknown provider name", () => {
    expect(parseCallback("mp_bogus")).toBeNull();
    expect(parseCallback("mm_bogus__x")).toBeNull();
  });

  it("returns null for a model pick with no model part", () => {
    expect(parseCallback("mm_glm__")).toBeNull();
  });

  it("keeps every callback under Telegram 64-byte limit for known providers", () => {
    for (const b of providerButtons()) {
      expect(Buffer.byteLength(b.data, "utf8")).toBeLessThanOrEqual(64);
    }
    const longModel = encodeModel("deepseek", "deepseek-v4-flash-preview-extended");
    expect(Buffer.byteLength(longModel, "utf8")).toBeLessThanOrEqual(64);
  });
});

describe("button specs", () => {
  it("providerButtons marks providers without a key using 🔑", () => {
    const buttons = providerButtons();
    const labels = buttons.map((b) => b.text);
    // mock always has a "key"; it is never marked
    expect(labels.find((l) => l.startsWith("Mock"))).not.toContain("🔑");
    // every button carries a provider callback
    for (const b of buttons) expect(b.data.startsWith(CB.PROVIDER)).toBe(true);
  });

  it("modelButtons lists models (with price hints) and appends a back button", () => {
    const buttons = modelButtons("glm", ["glm-4.7-flash", "glm-4.7"]);
    // callback data stays the bare encoded id; the visible text gains a hint.
    expect(buttons.map((b) => b.data)).toEqual([
      encodeModel("glm", "glm-4.7-flash"),
      encodeModel("glm", "glm-4.7"),
      CB.BACK,
    ]);
    expect(buttons[0]!.text).toContain("glm-4.7-flash");
    expect(buttons[0]!.text).toContain("🆓"); // free model marked
    expect(buttons[1]!.text).toContain("💲"); // paid model marked
    expect(buttons.at(-1)!.text).toBe("← Провайдеры");
  });

  it("modelButtons drops a model whose callback data would exceed 64 bytes", () => {
    const tooLong = "x".repeat(70); // 'mm_glm__' + 70 > 64
    const buttons = modelButtons("glm", ["glm-4.7-flash", tooLong]);
    expect(buttons.map((b) => b.data)).toEqual([encodeModel("glm", "glm-4.7-flash"), CB.BACK]);
    // every surviving button is within the limit
    for (const b of buttons) {
      expect(Buffer.byteLength(b.data, "utf8")).toBeLessThanOrEqual(64);
    }
  });
});

describe("statusText", () => {
  it("reports env source when no override", () => {
    const text = statusText({ provider: "glm", model: "glm-4.7-flash" }, false);
    expect(text).toContain("GLM / glm-4.7-flash");
    expect(text).toContain("env");
  });

  it("reports override source when overridden", () => {
    const text = statusText({ provider: "deepseek", model: "deepseek-v4-flash" }, true);
    expect(text).toContain("override");
  });

  it("shows the mock notice when mock is active", () => {
    const text = statusText({ provider: "glm", model: "glm-4.7-flash" }, false, true);
    expect(text).toMatch(/Mock ВКЛ/i);
    expect(text).not.toContain("glm-4.7-flash"); // model line hidden under mock
  });
});

describe("mock toggle", () => {
  it("parses mmock_on / mmock_off", () => {
    expect(parseCallback(CB.MOCK_ON)).toEqual({ kind: "mockOn" });
    expect(parseCallback(CB.MOCK_OFF)).toEqual({ kind: "mockOff" });
  });

  it("mockToggleButton reflects current state and offers the opposite action", () => {
    const on = mockToggleButton(true);
    expect(on.data).toBe(CB.MOCK_OFF); // mock ON → button turns it OFF
    expect(on.text).toMatch(/выключить/i);

    const off = mockToggleButton(false);
    expect(off.data).toBe(CB.MOCK_ON);
    expect(off.text).toMatch(/включить/i);
  });

  it("mock-toggle callback data stays within Telegram 64-byte limit", () => {
    expect(Buffer.byteLength(CB.MOCK_ON, "utf8")).toBeLessThanOrEqual(64);
    expect(Buffer.byteLength(CB.MOCK_OFF, "utf8")).toBeLessThanOrEqual(64);
  });
});
