// Protects packaged app identity, immutable flavor routing and separate storage contracts.
import { describe, expect, it } from "vitest";

import {
  desktopUpdateChannel,
  resolveIishkoDesktopFlavor,
  resolveIishkoDesktopRuntimeFlavor,
  canOverrideDesktopSmokeUserData,
  IISHKO_SOURCE_DESKTOP_BUILD_MARKER,
  IISHKO_BETA_BUNDLE_ID,
  IISHKO_BETA_DESKTOP_ENTRY_URL,
  IISHKO_BETA_DESKTOP_ORIGIN,
  IISHKO_CANARY_BUNDLE_ID,
  IISHKO_CANARY_DESKTOP_ENTRY_URL,
  IISHKO_CANARY_DESKTOP_ORIGIN,
  IISHKO_CUA_BUNDLE_ID,
  IISHKO_CUA_DESKTOP_ENTRY_URL,
  IISHKO_CUA_DESKTOP_ORIGIN,
  IISHKO_DESKTOP_ENTRY_URL,
  IISHKO_DESKTOP_ORIGIN,
  IISHKO_DESKTOP_UPDATE_CHANNEL,
  IISHKO_DEVELOPMENT_BUNDLE_ID,
  IISHKO_PRODUCTION_BUNDLE_ID,
  IISHKO_REMOTE_BUNDLE_ID,
  iishkoDesktopIdentity,
  iishkoSourceDesktopIdentity,
} from "./desktopIdentity";

describe("desktopIdentity", () => {
  it("uses the exact canonical production and development bundle IDs", () => {
    expect(IISHKO_PRODUCTION_BUNDLE_ID).toBe("com.reformboss.iishko");
    expect(IISHKO_DEVELOPMENT_BUNDLE_ID).toBe("com.reformboss.iishko.dev");
    expect(iishkoDesktopIdentity("production").bundleId).toBe(IISHKO_PRODUCTION_BUNDLE_ID);
    expect(iishkoDesktopIdentity("development").bundleId).toBe(IISHKO_DEVELOPMENT_BUNDLE_ID);
  });

  it("keeps source Beta and Remote launches off the installed apps' privacy identity", () => {
    const remote = iishkoSourceDesktopIdentity(iishkoDesktopIdentity("remote"));
    expect(remote).toEqual({
      ...iishkoDesktopIdentity("remote"),
      displayName: "ИИШКО IDE Remote (Source)",
      bundleId: `${IISHKO_REMOTE_BUNDLE_ID}.source`,
    });
    expect(iishkoSourceDesktopIdentity(iishkoDesktopIdentity("beta")).bundleId).toBe(
      `${IISHKO_BETA_BUNDLE_ID}.source`,
    );
    for (const flavor of ["development", "canary", "cua"] as const) {
      expect(iishkoSourceDesktopIdentity(iishkoDesktopIdentity(flavor))).toEqual(
        iishkoDesktopIdentity(flavor),
      );
    }
  });

  it("uses the exact packaged renderer origin and entry URL", () => {
    expect(IISHKO_DESKTOP_ORIGIN).toBe("iishko://app");
    expect(IISHKO_DESKTOP_ENTRY_URL).toBe("iishko://app/index.html");
  });

  it("matches the beta update channel to prerelease tags and keeps iishko otherwise", () => {
    expect(desktopUpdateChannel("beta")).toBe("beta");
    expect(desktopUpdateChannel("remote")).toBe("remote");
    expect(desktopUpdateChannel("production")).toBe(IISHKO_DESKTOP_UPDATE_CHANNEL);
    expect(desktopUpdateChannel("canary")).toBe(IISHKO_DESKTOP_UPDATE_CHANNEL);
    expect(desktopUpdateChannel("development")).toBe(IISHKO_DESKTOP_UPDATE_CHANNEL);
  });

  it("gives Canary a fully separate desktop identity and storage profile", () => {
    expect(IISHKO_CANARY_BUNDLE_ID).toBe("com.reformboss.iishko.canary");
    expect(IISHKO_CANARY_DESKTOP_ORIGIN).toBe("iishko-canary://app");
    expect(IISHKO_CANARY_DESKTOP_ENTRY_URL).toBe("iishko-canary://app/index.html");
    expect(iishkoDesktopIdentity("canary")).toEqual({
      flavor: "canary",
      displayName: "ИИШКО IDE Canary",
      productName: "IISHKO IDE Canary",
      bundleId: IISHKO_CANARY_BUNDLE_ID,
      scheme: "iishko-canary",
      origin: IISHKO_CANARY_DESKTOP_ORIGIN,
      entryUrl: IISHKO_CANARY_DESKTOP_ENTRY_URL,
      userDataDirectoryName: "iishko-canary",
      defaultHomeDirectoryName: ".iishko-canary",
      usesScriptedUpdates: true,
    });
  });

  it("gives Cua a fully separate desktop identity and storage profile", () => {
    expect(IISHKO_CUA_BUNDLE_ID).toBe("com.reformboss.iishko.cua");
    expect(IISHKO_CUA_DESKTOP_ORIGIN).toBe("iishko-cua://app");
    expect(IISHKO_CUA_DESKTOP_ENTRY_URL).toBe("iishko-cua://app/index.html");
    expect(iishkoDesktopIdentity("cua")).toEqual({
      flavor: "cua",
      displayName: "ИИШКО IDE Cua",
      productName: "IISHKO IDE Cua",
      bundleId: IISHKO_CUA_BUNDLE_ID,
      scheme: "iishko-cua",
      origin: IISHKO_CUA_DESKTOP_ORIGIN,
      entryUrl: IISHKO_CUA_DESKTOP_ENTRY_URL,
      userDataDirectoryName: "iishko-cua",
      defaultHomeDirectoryName: ".iishko-cua",
      usesScriptedUpdates: true,
    });
  });

  it("gives Beta a fully separate desktop identity and storage profile", () => {
    expect(IISHKO_BETA_BUNDLE_ID).toBe("com.reformboss.iishko.beta");
    expect(IISHKO_BETA_DESKTOP_ORIGIN).toBe("iishko-beta://app");
    expect(IISHKO_BETA_DESKTOP_ENTRY_URL).toBe("iishko-beta://app/index.html");
    expect(iishkoDesktopIdentity("beta")).toEqual({
      flavor: "beta",
      displayName: "ИИШКО IDE Beta",
      productName: "IISHKO IDE Beta",
      bundleId: IISHKO_BETA_BUNDLE_ID,
      scheme: "iishko-beta",
      origin: IISHKO_BETA_DESKTOP_ORIGIN,
      entryUrl: IISHKO_BETA_DESKTOP_ENTRY_URL,
      userDataDirectoryName: "iishko-beta",
      defaultHomeDirectoryName: ".iishko-beta",
      usesScriptedUpdates: false,
    });
  });

  it("gives Remote its own app, account service, protocol, storage and updater identity", () => {
    expect(iishkoDesktopIdentity("remote")).toEqual({
      flavor: "remote",
      displayName: "ИИШКО IDE Remote",
      productName: "IISHKO IDE Remote",
      bundleId: "com.reformboss.iishko.remote",
      scheme: "iishko-remote",
      origin: "iishko-remote://app",
      entryUrl: "iishko-remote://app/index.html",
      userDataDirectoryName: "iishko-remote",
      defaultHomeDirectoryName: ".iishko-remote",
      defaultAccountUrl: "https://disabled.invalid",
      usesScriptedUpdates: false,
    });
    expect(IISHKO_REMOTE_BUNDLE_ID).toBe("com.reformboss.iishko.remote");
    expect(resolveIishkoDesktopFlavor({ isDevelopment: false, requestedFlavor: "remote" })).toBe(
      "remote",
    );
  });

  it("selects explicit source flavors without changing packaged Stable", () => {
    expect(resolveIishkoDesktopFlavor({ isDevelopment: false })).toBe("production");
    expect(resolveIishkoDesktopFlavor({ isDevelopment: true })).toBe("development");
    expect(
      resolveIishkoDesktopFlavor({ isDevelopment: false, requestedFlavor: "development" }),
    ).toBe("production");
    expect(
      resolveIishkoDesktopFlavor({
        isDevelopment: false,
        requestedFlavor: "development",
        allowDevelopmentOverride: true,
      }),
    ).toBe("development");
    expect(resolveIishkoDesktopFlavor({ isDevelopment: false, requestedFlavor: " canary " })).toBe(
      "canary",
    );
    expect(resolveIishkoDesktopFlavor({ isDevelopment: true, requestedFlavor: "canary" })).toBe(
      "canary",
    );
    expect(resolveIishkoDesktopFlavor({ isDevelopment: false, requestedFlavor: "cua" })).toBe(
      "cua",
    );
    expect(resolveIishkoDesktopFlavor({ isDevelopment: true, requestedFlavor: "CUA" })).toBe("cua");
    expect(resolveIishkoDesktopFlavor({ isDevelopment: false, requestedFlavor: "beta" })).toBe(
      "beta",
    );
    expect(resolveIishkoDesktopFlavor({ isDevelopment: false, requestedFlavor: " beta " })).toBe(
      "beta",
    );
    expect(resolveIishkoDesktopFlavor({ isDevelopment: true, requestedFlavor: "beta" })).toBe(
      "beta",
    );
  });

  it("isolates development and Canary homes from packaged Stable", () => {
    expect(iishkoDesktopIdentity("development").defaultHomeDirectoryName).toBe(".iishko-dev");
    expect(iishkoDesktopIdentity("canary").defaultHomeDirectoryName).toBe(".iishko-canary");
    expect(iishkoDesktopIdentity("cua").defaultHomeDirectoryName).toBe(".iishko-cua");
    expect(iishkoDesktopIdentity("beta").defaultHomeDirectoryName).toBe(".iishko-beta");
    expect(iishkoDesktopIdentity("production").defaultHomeDirectoryName).toBe(".iishko-ide");
  });

  it.each(["production", "canary", "cua", "beta", "remote"] as const)(
    "uses the immutable %s package flavor despite inherited source settings",
    (packagedFlavor) => {
      expect(
        resolveIishkoDesktopRuntimeFlavor({
          isPackaged: true,
          isDevelopment: true,
          packagedFlavor,
          requestedFlavor: "development",
          allowDevelopmentOverride: true,
        }),
      ).toBe(packagedFlavor);
    },
  );

  it("keeps legacy packaged Stable independent from a source shell's flavor", () => {
    expect(
      resolveIishkoDesktopRuntimeFlavor({
        isPackaged: true,
        isDevelopment: false,
        requestedFlavor: "cua",
      }),
    ).toBe("production");
  });

  it("preserves source launcher routing, including its bundled macOS bootstrap", () => {
    expect(
      resolveIishkoDesktopRuntimeFlavor({
        isPackaged: true,
        isDevelopment: false,
        requestedFlavor: "development",
        allowDevelopmentOverride: true,
      }),
    ).toBe("development");
    expect(
      resolveIishkoDesktopRuntimeFlavor({
        isPackaged: false,
        isDevelopment: true,
        requestedFlavor: "canary",
      }),
    ).toBe("canary");
  });

  it.each(["development", "CUA", null])(
    "rejects malformed packaged identity %j before opening any profile",
    (packagedFlavor) => {
      expect(() =>
        resolveIishkoDesktopRuntimeFlavor({
          isPackaged: true,
          isDevelopment: false,
          packagedFlavor,
        }),
      ).toThrow("packaged IISHKO desktop flavor is invalid");
    },
  );

  it("isolates smoke profiles only for source launches or isolated packages", () => {
    expect(canOverrideDesktopSmokeUserData({ packagedFlavor: "cua" })).toBe(true);
    expect(canOverrideDesktopSmokeUserData({ packagedFlavor: "beta" })).toBe(true);
    expect(canOverrideDesktopSmokeUserData({ packagedFlavor: "remote" })).toBe(true);
    expect(
      canOverrideDesktopSmokeUserData({
        sourceBuildMarker: IISHKO_SOURCE_DESKTOP_BUILD_MARKER,
      }),
    ).toBe(true);
    for (const packagedFlavor of ["production", "canary", "development", null]) {
      expect(
        canOverrideDesktopSmokeUserData({
          packagedFlavor,
          sourceBuildMarker: IISHKO_SOURCE_DESKTOP_BUILD_MARKER,
        }),
      ).toBe(false);
    }
    expect(canOverrideDesktopSmokeUserData({})).toBe(false);
  });
});
