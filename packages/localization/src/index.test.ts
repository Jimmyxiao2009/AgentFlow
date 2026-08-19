import { describe, expect, it } from "vitest";
import { messages, supportedLocales, t } from "./index.js";

describe("localization", () => {
  it("keeps launch locales keyed and provides an English fallback", () => {
    for (const locale of supportedLocales)
      for (const key of [
        "Navigation.NewConversation",
        "Navigation.SearchConversations",
        "Navigation.OpenProject",
        "Navigation.Settings",
        "Action.ApproveAndRun",
      ])
        expect(messages[locale][key]).toBeTruthy();
    expect(t("zh-CN", "Missing.Key")).toBe("Missing.Key");
  });

  it("keeps semantic key parity across every prepared locale", () => {
    const expected = Object.keys(messages["en-US"]).sort();
    for (const locale of supportedLocales)
      expect(Object.keys(messages[locale]).sort()).toEqual(expected);
  });
});
