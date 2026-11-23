// FILE: bundledPiGuard.test.ts
// Purpose: The built-in IISHKO provider (bundled Pi, no binary path) never resolves an external `pi`.
// Layer: Server unit tests

import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { DEFAULT_SERVER_SETTINGS, type ServerSettings } from "@iishko/contracts";
import { afterEach, expect, it } from "vitest";

import { deriveManagedTerminalProfiles, usesBundledPi } from "./providerTerminalProfiles.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fakePiOnPath() {
  const dir = mkdtempSync(path.join(tmpdir(), "iishko-pi-guard-"));
  dirs.push(dir);
  const name = process.platform === "win32" ? "pi.cmd" : "pi";
  writeFileSync(
    path.join(dir, name),
    process.platform === "win32" ? "@echo off\r\n" : "#!/bin/sh\n",
  );
  chmodSync(path.join(dir, name), 0o755);
  return dir;
}

function settingsWithPi(config: Record<string, unknown>): ServerSettings {
  return {
    ...DEFAULT_SERVER_SETTINGS,
    providerInstances: {
      ...DEFAULT_SERVER_SETTINGS.providerInstances,
      pi: { driver: "pi", ...config },
    },
  } as ServerSettings;
}

async function piProfiles(settings: ServerSettings, binDir: string) {
  const stateDir = mkdtempSync(path.join(tmpdir(), "iishko-pi-state-"));
  dirs.push(stateDir);
  const profiles = await deriveManagedTerminalProfiles({
    settings,
    onlyInstanceId: "pi",
    baseEnv: { PATH: binDir, PATHEXT: ".CMD;.EXE" },
    homeDir: stateDir,
    stateDir,
  });
  return profiles.filter((profile) => profile.instanceId === "pi");
}

it("treats the default Pi instance without an explicit binary path as the bundled runtime", () => {
  expect(usesBundledPi("pi", {}, true)).toBe(true);
  expect(usesBundledPi("pi", { binaryPath: "  " }, true)).toBe(true);
  expect(usesBundledPi("pi", { binaryPath: "C:/tools/pi.exe" }, true)).toBe(false);
  expect(usesBundledPi("claudeAgent", {}, true)).toBe(false);
  // Custom Pi instances are CLI agents even without a binary path.
  expect(usesBundledPi("pi", {}, false)).toBe(false);
});

it("derives no CLI profile for the bundled Pi even when a global pi is on PATH", async () => {
  const binDir = fakePiOnPath();
  expect(await piProfiles(settingsWithPi({}), binDir)).toEqual([]);
});
