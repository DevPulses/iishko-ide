// FILE: cursorSkillsDiscovery.ts
// Purpose: Finds Cursor-compatible Agent Skill folders from project and user skill roots,
//          mirroring the roots cursor-agent scans natively.
// Layer: Server provider discovery helper
// Exports: discoverCursorSkills (generic primitives live in skillsCatalog.ts).

import * as nodePath from "node:path";

import type { ProviderSkillDescriptor } from "@iishko/contracts";
import { DEFAULT_IISHKO_HOME_DIRECTORY_NAME } from "@iishko/shared/iishkoHome";

import { collectSkillsFromRoots, providerNativeSkillRoots } from "./skillsCatalog.ts";

export interface CursorSkillDiscoveryInput {
  readonly cwd: string;
  readonly homeDir: string;
}

export async function discoverCursorSkills(
  input: CursorSkillDiscoveryInput,
): Promise<ProviderSkillDescriptor[]> {
  return collectSkillsFromRoots(
    providerNativeSkillRoots({
      cwd: input.cwd,
      homeDir: input.homeDir,
      iishkoBaseDir: nodePath.join(input.homeDir, DEFAULT_IISHKO_HOME_DIRECTORY_NAME),
      provider: "cursor",
    }),
  );
}
