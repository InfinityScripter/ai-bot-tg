import { it, expect, describe } from "vitest";

import { MenuAction } from "../src/enums.js";
import { MENU_CALLBACK } from "../src/consts.js";
import {
  COMMANDS,
  helpText,
  menuKeyboard,
  nativeCommands,
  parseMenuCallback,
} from "../src/bot/menu.js";

describe("helpText", () => {
  it("lists every command with its description", () => {
    const text = helpText();
    for (const c of COMMANDS) {
      expect(text).toContain(`/${c.command}`);
      expect(text).toContain(c.description);
    }
  });
});

describe("nativeCommands", () => {
  it("maps every command to the Telegram {command, description} shape", () => {
    const native = nativeCommands();
    expect(native).toHaveLength(COMMANDS.length);
    expect(native.every((n) => n.command && n.description)).toBe(true);
  });
});

describe("menuKeyboard", () => {
  it("has one button per actionable command, carrying a menu_ callback", () => {
    const actionable = COMMANDS.filter((c) => c.action && c.buttonTitle);
    const kb = menuKeyboard();
    const buttons = kb.inline_keyboard.flat();
    expect(buttons).toHaveLength(actionable.length);
    for (const b of buttons) {
      expect("callback_data" in b && b.callback_data.startsWith(MENU_CALLBACK)).toBe(true);
    }
  });
});

describe("parseMenuCallback", () => {
  it("parses a valid menu callback to its MenuAction", () => {
    expect(parseMenuCallback(`${MENU_CALLBACK}${MenuAction.Health}`)).toBe(MenuAction.Health);
    expect(parseMenuCallback(`${MENU_CALLBACK}${MenuAction.Fetch}`)).toBe(MenuAction.Fetch);
  });

  it("returns null for a non-menu or unknown callback", () => {
    expect(parseMenuCallback("approve_42")).toBeNull();
    expect(parseMenuCallback(`${MENU_CALLBACK}bogus`)).toBeNull();
    expect(parseMenuCallback("")).toBeNull();
  });
});
