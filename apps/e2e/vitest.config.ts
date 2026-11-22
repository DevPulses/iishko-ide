import { defineConfig, mergeConfig } from "vitest/config";

import baseConfig from "../../vitest.config";

export default mergeConfig(
  baseConfig,
  defineConfig({
    test: {
      env: { IISHKO_REMOTE_CONNECTIONS: "1", IISHKO_DESKTOP_BUNDLE_ID: "" },
      hookTimeout: 90_000,
      testTimeout: 90_000,
    },
  }),
);
