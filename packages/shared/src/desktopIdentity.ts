// FILE: desktopIdentity.ts
// Purpose: Defines the canonical desktop application identity across packaging and runtime.

export const IISHKO_DESKTOP_SCHEME = "iishko";
export const IISHKO_DESKTOP_ORIGIN = `${IISHKO_DESKTOP_SCHEME}://app`;
export const IISHKO_DESKTOP_ENTRY_URL = `${IISHKO_DESKTOP_ORIGIN}/index.html`;
export const IISHKO_DESKTOP_UPDATE_CHANNEL = "iishko";
export const IISHKO_PRODUCTION_BUNDLE_ID = "com.reformboss.iishko";
export const IISHKO_DEVELOPMENT_BUNDLE_ID = `${IISHKO_PRODUCTION_BUNDLE_ID}.dev`;
export const IISHKO_CANARY_BUNDLE_ID = `${IISHKO_PRODUCTION_BUNDLE_ID}.canary`;
/** Display/setup identity of the GUI host; this value does not confer native authority. */
export const IISHKO_DESKTOP_BUNDLE_ID_ENV = "IISHKO_DESKTOP_BUNDLE_ID";
export const IISHKO_CANARY_DESKTOP_SCHEME = "iishko-canary";
export const IISHKO_CANARY_DESKTOP_ORIGIN = `${IISHKO_CANARY_DESKTOP_SCHEME}://app`;
export const IISHKO_CANARY_DESKTOP_ENTRY_URL = `${IISHKO_CANARY_DESKTOP_ORIGIN}/index.html`;
export const IISHKO_CUA_BUNDLE_ID = `${IISHKO_PRODUCTION_BUNDLE_ID}.cua`;
export const IISHKO_CUA_DESKTOP_SCHEME = "iishko-cua";
export const IISHKO_CUA_DESKTOP_ORIGIN = `${IISHKO_CUA_DESKTOP_SCHEME}://app`;
export const IISHKO_CUA_DESKTOP_ENTRY_URL = `${IISHKO_CUA_DESKTOP_ORIGIN}/index.html`;
export const IISHKO_BETA_BUNDLE_ID = `${IISHKO_PRODUCTION_BUNDLE_ID}.beta`;
export const IISHKO_BETA_DESKTOP_SCHEME = "iishko-beta";
export const IISHKO_BETA_DESKTOP_ORIGIN = `${IISHKO_BETA_DESKTOP_SCHEME}://app`;
export const IISHKO_BETA_DESKTOP_ENTRY_URL = `${IISHKO_BETA_DESKTOP_ORIGIN}/index.html`;
export const IISHKO_REMOTE_BUNDLE_ID = `${IISHKO_PRODUCTION_BUNDLE_ID}.remote`;
export const IISHKO_REMOTE_DESKTOP_SCHEME = "iishko-remote";
export const IISHKO_REMOTE_DESKTOP_ORIGIN = `${IISHKO_REMOTE_DESKTOP_SCHEME}://app`;
export const IISHKO_REMOTE_DESKTOP_ENTRY_URL = `${IISHKO_REMOTE_DESKTOP_ORIGIN}/index.html`;
export const IISHKO_SOURCE_DESKTOP_BUILD_MARKER = "iishko-source-desktop-build-v2";
export const IISHKO_DESKTOP_SMOKE_USER_DATA_ENV = "IISHKO_DESKTOP_SMOKE_USER_DATA";

export type IishkoDesktopFlavor =
  | "production"
  | "development"
  | "canary"
  | "cua"
  | "beta"
  | "remote";
export const IISHKO_PACKAGED_DESKTOP_FLAVORS = [
  "production",
  "canary",
  "cua",
  "beta",
  "remote",
] as const;
export type IishkoPackagedDesktopFlavor = (typeof IISHKO_PACKAGED_DESKTOP_FLAVORS)[number];

/**
 * electron-updater matches the update channel against the release tag's
 * prerelease identifier. Beta and Remote each follow their own lane;
 * neither may fall through to the Stable payload.
 *
 * The channel stays architecture-independent: electron-updater derives
 * `<channel>-linux[-arch]` (`iishko-linux.yml` for x64, `iishko-linux-arm64.yml`
 * for arm64), and the release pipeline publishes those names beside
 * electron-builder's `latest-linux[-arm64].yml`.
 */
export function desktopUpdateChannel(flavor: IishkoDesktopFlavor): string {
  return flavor === "beta" || flavor === "remote" ? flavor : IISHKO_DESKTOP_UPDATE_CHANNEL;
}

export interface IishkoDesktopIdentity {
  readonly flavor: IishkoDesktopFlavor;
  readonly displayName: string;
  /** File-system and installer identity (executable, app bundle, artifact names). */
  readonly productName: string;
  readonly bundleId: string;
  readonly scheme: string;
  readonly origin: string;
  readonly entryUrl: string;
  readonly userDataDirectoryName: string;
  readonly defaultHomeDirectoryName: string;
  /** Hosted account service for this flavor, unless the operator explicitly overrides it. */
  readonly defaultAccountUrl?: string;
  readonly usesScriptedUpdates: boolean;
}

export function resolveIishkoDesktopFlavor(input: {
  readonly isDevelopment: boolean;
  readonly requestedFlavor?: string | undefined;
  readonly allowDevelopmentOverride?: boolean | undefined;
}): IishkoDesktopFlavor {
  const requestedFlavor = input.requestedFlavor?.trim().toLowerCase();
  if (requestedFlavor === "cua") {
    return "cua";
  }
  if (requestedFlavor === "canary") {
    return "canary";
  }
  if (requestedFlavor === "beta" || requestedFlavor === "remote") {
    return requestedFlavor;
  }
  if (
    requestedFlavor === "development" &&
    (input.isDevelopment || input.allowDevelopmentOverride === true)
  ) {
    return "development";
  }
  return input.isDevelopment ? "development" : "production";
}

/** Packaged identity is fixed when the artifact is staged, before it is signed. */
export function resolveIishkoDesktopRuntimeFlavor(input: {
  readonly isPackaged: boolean;
  readonly isDevelopment: boolean;
  readonly packagedFlavor?: unknown;
  readonly requestedFlavor?: string | undefined;
  readonly allowDevelopmentOverride?: boolean | undefined;
}): IishkoDesktopFlavor {
  if (input.isPackaged && input.packagedFlavor !== undefined) {
    const flavor = input.packagedFlavor;
    if (
      flavor === "production" ||
      flavor === "canary" ||
      flavor === "cua" ||
      flavor === "beta" ||
      flavor === "remote"
    ) {
      return flavor;
    }
    throw new Error("The packaged IISHKO desktop flavor is invalid. Rebuild the application.");
  }
  // Source launchers also use an app bundle on macOS. Their build marker keeps
  // the existing environment-based routing, while legacy packaged apps remain
  // Stable even when a developer shell happens to export a different flavor.
  if (input.isPackaged && input.allowDevelopmentOverride !== true) {
    return "production";
  }
  return resolveIishkoDesktopFlavor(input);
}

export function canOverrideDesktopSmokeUserData(input: {
  readonly packagedFlavor?: unknown;
  readonly sourceBuildMarker?: string | undefined;
}): boolean {
  return (
    input.packagedFlavor === "cua" ||
    input.packagedFlavor === "beta" ||
    input.packagedFlavor === "remote" ||
    (input.packagedFlavor === undefined &&
      input.sourceBuildMarker === IISHKO_SOURCE_DESKTOP_BUILD_MARKER)
  );
}

export function iishkoDesktopIdentity(flavor: IishkoDesktopFlavor): IishkoDesktopIdentity {
  if (flavor === "cua") {
    return {
      flavor,
      displayName: "ИИШКО IDE Cua",
      productName: "IISHKO IDE Cua",
      bundleId: IISHKO_CUA_BUNDLE_ID,
      scheme: IISHKO_CUA_DESKTOP_SCHEME,
      origin: IISHKO_CUA_DESKTOP_ORIGIN,
      entryUrl: IISHKO_CUA_DESKTOP_ENTRY_URL,
      userDataDirectoryName: "iishko-cua",
      defaultHomeDirectoryName: ".iishko-cua",
      usesScriptedUpdates: true,
    };
  }
  if (flavor === "canary") {
    return {
      flavor,
      displayName: "ИИШКО IDE Canary",
      productName: "IISHKO IDE Canary",
      bundleId: IISHKO_CANARY_BUNDLE_ID,
      scheme: IISHKO_CANARY_DESKTOP_SCHEME,
      origin: IISHKO_CANARY_DESKTOP_ORIGIN,
      entryUrl: IISHKO_CANARY_DESKTOP_ENTRY_URL,
      userDataDirectoryName: "iishko-canary",
      defaultHomeDirectoryName: ".iishko-canary",
      usesScriptedUpdates: true,
    };
  }
  if (flavor === "beta") {
    return {
      flavor,
      displayName: "ИИШКО IDE Beta",
      productName: "IISHKO IDE Beta",
      bundleId: IISHKO_BETA_BUNDLE_ID,
      scheme: IISHKO_BETA_DESKTOP_SCHEME,
      origin: IISHKO_BETA_DESKTOP_ORIGIN,
      entryUrl: IISHKO_BETA_DESKTOP_ENTRY_URL,
      userDataDirectoryName: "iishko-beta",
      defaultHomeDirectoryName: ".iishko-beta",
      usesScriptedUpdates: false,
    };
  }
  if (flavor === "remote") {
    return {
      flavor,
      displayName: "ИИШКО IDE Remote",
      productName: "IISHKO IDE Remote",
      bundleId: IISHKO_REMOTE_BUNDLE_ID,
      scheme: IISHKO_REMOTE_DESKTOP_SCHEME,
      origin: IISHKO_REMOTE_DESKTOP_ORIGIN,
      entryUrl: IISHKO_REMOTE_DESKTOP_ENTRY_URL,
      userDataDirectoryName: "iishko-remote",
      defaultHomeDirectoryName: ".iishko-remote",
      defaultAccountUrl: "https://disabled.invalid",
      usesScriptedUpdates: false,
    };
  }
  if (flavor === "development") {
    return {
      flavor,
      displayName: "ИИШКО IDE (Dev)",
      productName: "IISHKO IDE (Dev)",
      bundleId: IISHKO_DEVELOPMENT_BUNDLE_ID,
      scheme: IISHKO_DESKTOP_SCHEME,
      origin: IISHKO_DESKTOP_ORIGIN,
      entryUrl: IISHKO_DESKTOP_ENTRY_URL,
      userDataDirectoryName: "iishko-dev",
      defaultHomeDirectoryName: ".iishko-dev",
      usesScriptedUpdates: false,
    };
  }
  return {
    flavor,
    displayName: "ИИШКО IDE",
    productName: "IISHKO IDE",
    bundleId: IISHKO_PRODUCTION_BUNDLE_ID,
    scheme: IISHKO_DESKTOP_SCHEME,
    origin: IISHKO_DESKTOP_ORIGIN,
    entryUrl: IISHKO_DESKTOP_ENTRY_URL,
    userDataDirectoryName: "iishko-ide",
    defaultHomeDirectoryName: ".iishko-ide",
    usesScriptedUpdates: false,
  };
}

/**
 * Source launches run an ad-hoc signed Electron copy. Sharing an installed
 * release's identifier makes macOS check that release's privacy grants against
 * the wrong signature, and the launcher's re-sign reset clears them, so source
 * copies of the separately installed Beta and Remote apps get their own.
 */
export function iishkoSourceDesktopIdentity(
  identity: IishkoDesktopIdentity,
): IishkoDesktopIdentity {
  if (identity.flavor !== "beta" && identity.flavor !== "remote") return identity;
  return {
    ...identity,
    displayName: `${identity.displayName} (Source)`,
    bundleId: `${identity.bundleId}.source`,
  };
}
