// FILE: desktop-artifact-identity.ts
// Purpose: Keeps packaged metadata, native identity and artifact names aligned.
import {
  iishkoDesktopIdentity,
  type IishkoPackagedDesktopFlavor,
} from "@iishko/shared/desktopIdentity";

export function createDesktopArtifactIdentity(input: {
  readonly platform: "mac" | "linux" | "win";
  readonly flavor: IishkoPackagedDesktopFlavor;
}) {
  // Stable's NSIS GUID deliberately survives public bundle ID changes. An
  // experimental installer must not register itself as that same product;
  // Beta and Remote have their own installer GUIDs.
  if (input.platform === "win" && !["production", "beta", "remote"].includes(input.flavor)) {
    throw new Error("Isolated desktop flavors are currently supported on macOS and Linux only.");
  }
  const identity = iishkoDesktopIdentity(input.flavor);
  const suffix = input.flavor === "production" ? "" : `-${input.flavor}`;
  return {
    identity,
    packageMetadata: {
      name: `iishko-desktop${suffix}`,
      productName: identity.productName,
      iishkoDesktopFlavor: input.flavor,
    },
    buildConfig: {
      appId: identity.bundleId,
      productName: identity.productName,
      artifactName: `${identity.productName.replaceAll(" ", "-")}-\${version}-\${arch}.\${ext}`,
      ...(input.flavor !== "production"
        ? { protocols: [{ name: identity.displayName, schemes: [identity.scheme] }] }
        : {}),
    },
    releaseDirectoryName: `release${suffix}`,
  };
}
