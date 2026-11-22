import { describe, expect, it } from "vitest";

import { buildTelegramAppUrl, chooseTelegramLaunchUrl } from "./telegramLink.ts";

const LINK = "https://t.me/iishkogatewaybot?start=ide_AbC123-xyz_9";

describe("buildTelegramAppUrl", () => {
  it("builds a tg:// resolve link from the https link", () => {
    expect(buildTelegramAppUrl(LINK)).toBe(
      "tg://resolve?domain=iishkogatewaybot&start=ide_AbC123-xyz_9",
    );
    expect(buildTelegramAppUrl("https://t.me/my_iishko_bot")).toBe(
      "tg://resolve?domain=my_iishko_bot",
    );
  });

  it.each([
    "http://t.me/iishkogatewaybot?start=ide_x",
    "https://example.com/iishkogatewaybot?start=ide_x",
    "https://t.me/iishkogatewaybot/extra?start=ide_x",
    "https://t.me/ab?start=ide_x",
    "https://t.me/iishkogatewaybot?start=a%26b",
    "https://user:pw@t.me/iishkogatewaybot?start=ide_x",
    "not a url",
  ])("rejects %s", (value) => {
    expect(buildTelegramAppUrl(value)).toBeNull();
  });
});

describe("chooseTelegramLaunchUrl", () => {
  it("uses the app link only when a tg handler exists", () => {
    expect(chooseTelegramLaunchUrl(LINK, true)).toBe(
      "tg://resolve?domain=iishkogatewaybot&start=ide_AbC123-xyz_9",
    );
    expect(chooseTelegramLaunchUrl(LINK, false)).toBe(LINK);
  });

  it("keeps non-Telegram links untouched", () => {
    expect(chooseTelegramLaunchUrl("https://example.com/x", true)).toBe("https://example.com/x");
  });
});
