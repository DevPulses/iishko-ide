import { describe, expect, it } from "vitest";

import { resolveLiteMotion, type MotionEnvironment } from "./motionMode";

const STRONG: MotionEnvironment = {
  prefersReducedMotion: false,
  hardwareConcurrency: 8,
  deviceMemory: 8,
};

describe("resolveLiteMotion", () => {
  it("honours an explicit choice over the environment", () => {
    expect(resolveLiteMotion("lite", STRONG)).toBe(true);
    expect(resolveLiteMotion("full", { ...STRONG, prefersReducedMotion: true })).toBe(false);
  });

  it("stays full on a capable machine in auto mode", () => {
    expect(resolveLiteMotion("auto", STRONG)).toBe(false);
    expect(
      resolveLiteMotion("auto", {
        prefersReducedMotion: false,
        hardwareConcurrency: undefined,
        deviceMemory: undefined,
      }),
    ).toBe(false);
  });

  it.each([
    { ...STRONG, prefersReducedMotion: true },
    { ...STRONG, hardwareConcurrency: 2 },
    { ...STRONG, hardwareConcurrency: 1 },
    { ...STRONG, deviceMemory: 4 },
    { ...STRONG, deviceMemory: 2 },
  ])("switches to lite in auto mode for %j", (environment) => {
    expect(resolveLiteMotion("auto", environment)).toBe(true);
  });
});
