// FILE: navigation.test.ts
// Purpose: The hosts pane is deliberately not shipped in this build — stale
//          deep links still normalize to a real section instead of breaking.
// Layer: Web remote-access feature tests.

import { describe, expect, it } from "vitest";

import {
  normalizeSettingsSection,
  SETTINGS_NAV_ITEMS,
  SETTINGS_SECTION_IDS,
} from "~/settingsNavigation";
import { SETTINGS_SEARCH_ENTRIES } from "~/settingsSearchIndex";

describe("the hosts settings pane", () => {
  it("stays a known section so deep links resolve", () => {
    expect(SETTINGS_SECTION_IDS).toContain("connections");
    expect(normalizeSettingsSection("connections")).toBe("general");
  });

  it("has no nav entry in this build", () => {
    expect(SETTINGS_NAV_ITEMS.find((entry) => entry.id === "connections")).toBeUndefined();
  });

  it("keeps every search entry on a real section", () => {
    for (const entry of SETTINGS_SEARCH_ENTRIES) {
      expect(SETTINGS_SECTION_IDS).toContain(entry.section);
    }
  });
});
