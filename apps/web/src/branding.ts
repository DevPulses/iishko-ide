// Renderer branding follows the packaged protocol defined by desktopIdentity.
import { IISHKO_REMOTE_DESKTOP_SCHEME } from "@iishko/shared/desktopIdentity";

export const APP_BASE_NAME = "ИИШКО IDE";
const isCanaryDesktop =
  typeof window !== "undefined" && window.location?.protocol === "iishko-canary:";
const isBetaDesktop = typeof window !== "undefined" && window.location?.protocol === "iishko-beta:";
const isRemoteDesktop =
  typeof window !== "undefined" && window.location?.protocol === `${IISHKO_REMOTE_DESKTOP_SCHEME}:`;
/** Iishko Remote shares usage and diagnostics by default. */
export const IS_REMOTE_DESKTOP = isRemoteDesktop;
export const APP_DISPLAY_NAME = isRemoteDesktop
  ? "ИИШКО IDE Remote"
  : isCanaryDesktop
    ? "ИИШКО IDE Canary"
    : isBetaDesktop
      ? "ИИШКО IDE Beta"
      : import.meta.env.DEV
        ? `${APP_BASE_NAME} (Dev)`
        : APP_BASE_NAME;
export const APP_VERSION = import.meta.env.APP_VERSION || "0.0.0";
