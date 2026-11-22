// FILE: betaFeatureGate.test.ts
// Purpose: Verify the server host's shared Beta-only feature policy.
import { afterEach, expect, it, vi } from "vitest";
import {
  IISHKO_BETA_BUNDLE_ID,
  IISHKO_DESKTOP_BUNDLE_ID_ENV,
  IISHKO_PRODUCTION_BUNDLE_ID,
} from "@iishko/shared/desktopIdentity";
import { ACCOUNT_INBOX_BETA_FEATURE } from "@iishko/shared/betaFeatures";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

it.each([
  [IISHKO_PRODUCTION_BUNDLE_ID, true],
  [IISHKO_BETA_BUNDLE_ID, true],
] as const)("allows saved Inbox recaps on the host bundle (%s)", async (bundleId, enabled) => {
  vi.stubEnv(IISHKO_DESKTOP_BUNDLE_ID_ENV, bundleId);
  vi.resetModules();
  const { isServerBetaFeatureEnabled } = await import("./betaFeatureGate");
  expect(isServerBetaFeatureEnabled(ACCOUNT_INBOX_BETA_FEATURE)).toBe(enabled);
});
