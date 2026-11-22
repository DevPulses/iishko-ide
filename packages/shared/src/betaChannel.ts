// FILE: betaChannel.ts
// Purpose: Shared constants and types for the Stable ↔ Iishko Beta handoff flow.
// Layer: Shared contracts (consumed by desktop main, server, and web settings UI)

import { Schema } from "effect";

/** Beta's data home; stable writes the import marker here, the beta server consumes it. */
export const IISHKO_BETA_HOME_DIR_NAME = ".iishko-beta";
export const BETA_IMPORT_REQUEST_FILE_NAME = "import-requested.json";
export const BETA_IMPORT_RESULT_FILE_NAME = "import-result.json";

/**
 * electron-builder NSIS `guid` for beta builds. The uninstall registry key is
 * the raw GUID (no braces — see app-builder-lib NsisTarget / multiUser.nsh).
 */
export const IISHKO_BETA_WINDOWS_INSTALLER_GUID = "3a471df2-0011-4c20-a535-4899fca3e658";

/** Public release listing; the newest `v*-beta.N` prerelease is the current beta build. */
export const IISHKO_BETA_RELEASES_URL =
  "https://git.reformboss.com/reform/iishko-ide/releases?q=prerelease%3Atrue";

/** Latest stable release, offered from beta when stable Iishko is not installed. */
export const IISHKO_STABLE_RELEASES_URL =
  "https://git.reformboss.com/reform/iishko-ide/releases/latest";

/** electron-builder NSIS `guid` for stable (production) builds. */
export const IISHKO_STABLE_WINDOWS_INSTALLER_GUID = "78a2e88b-9366-403e-bb71-35bbf98ef9e5";

/** GitHub API releases endpoint probed for the newest `v*-beta.N` tag. */
export const IISHKO_BETA_RELEASES_API_URL =
  "https://disabled.invalid/repos/reform/iishko-ide/releases?per_page=30";

/**
 * Environment overrides for the beta install flow. `IISHKO_BETA_HOME` moves the
 * beta data home everywhere it is resolved (stable's import marker, beta's own
 * base dir, the running-probe). `IISHKO_BETA_FEED_URL` points at a base URL
 * serving `beta-mac.yml` plus the files it lists; `IISHKO_BETA_INSTALL_DIR` and
 * `IISHKO_BETA_USER_DATA` relocate the app bundle and its Electron profile.
 */
export const IISHKO_BETA_HOME_ENV = "IISHKO_BETA_HOME";
export const IISHKO_BETA_FEED_URL_ENV = "IISHKO_BETA_FEED_URL";
export const IISHKO_BETA_INSTALL_DIR_ENV = "IISHKO_BETA_INSTALL_DIR";
export const IISHKO_BETA_USER_DATA_ENV = "IISHKO_BETA_USER_DATA";

/**
 * Set by stable when it launches beta, so "Switch back to Iishko" reopens that
 * exact stable app with its own data home instead of guessing install paths.
 */
export const IISHKO_STABLE_EXECUTABLE_ENV = "IISHKO_STABLE_EXECUTABLE";
export const IISHKO_STABLE_HOME_ENV = "IISHKO_STABLE_HOME";

/** Tag shape of a beta release: `v<version>-beta.<N>`. */
export const BETA_RELEASE_TAG_PATTERN = /^v\d+\.\d+\.\d+-beta\.\d+$/;

export const BetaImportRequest = Schema.Struct({
  version: Schema.Literal(1),
  requestedAt: Schema.String,
  /** Absolute path of the requesting install's Iishko home (e.g. `~/.iishko`). */
  sourceHomeDir: Schema.String,
});
export type BetaImportRequest = typeof BetaImportRequest.Type;

export const BetaImportResult = Schema.Struct({
  version: Schema.Literal(1),
  completedAt: Schema.String,
  ok: Schema.Boolean,
  error: Schema.optional(Schema.String),
});
export type BetaImportResult = typeof BetaImportResult.Type;

export const decodeBetaImportRequest = Schema.decodeUnknownSync(BetaImportRequest);
export const decodeBetaImportResult = Schema.decodeUnknownSync(BetaImportResult);
