// FILE: storageOriginMigration.ts
// Purpose: Imports Iishko browser state before renderer stores hydrate after a desktop origin move.

import type { IishkoStorageSnapshot } from "@iishko/contracts";

import { parseStoredThemeState, serializeThemeState } from "./theme/theme.logic";

const THEME_STORAGE_KEY = "iishko:theme";
const MAX_SNAPSHOT_ENTRIES = 2_048;
const MAX_SNAPSHOT_KEY_LENGTH = 512;
const MAX_SNAPSHOT_VALUE_LENGTH = 16 * 1024 * 1024;
const MAX_SNAPSHOT_BYTES = 16 * 1024 * 1024;

function isCanonicalStorageKey(key: string): boolean {
  return key.startsWith("iishko:") || key.startsWith("iishko.");
}

function getLocalStorage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

/** An imported theme goes through the same normalization as a stored one (a mode that was never chosen stays light). */
export function normalizeImportedStorageValue(key: string, value: string): string {
  if (key !== THEME_STORAGE_KEY) return value;
  try {
    return serializeThemeState(parseStoredThemeState(value));
  } catch {
    return value;
  }
}

export function importIishkoStorageSnapshot(
  snapshot: IishkoStorageSnapshot | null,
  storage = getLocalStorage(),
): boolean {
  if (!snapshot || !storage || snapshot.version !== 1 || !snapshot.entries) return false;
  const entries = Object.entries(snapshot.entries);
  if (entries.length > MAX_SNAPSHOT_ENTRIES) return false;

  try {
    if (
      !Number.isFinite(Date.parse(snapshot.exportedAt)) ||
      new TextEncoder().encode(JSON.stringify(snapshot)).byteLength > MAX_SNAPSHOT_BYTES
    ) {
      return false;
    }
    for (const [key, value] of entries) {
      if (
        !isCanonicalStorageKey(key) ||
        key.length > MAX_SNAPSHOT_KEY_LENGTH ||
        typeof value !== "string" ||
        value.length > MAX_SNAPSHOT_VALUE_LENGTH
      ) {
        return false;
      }
    }
    for (const [key, value] of entries) {
      if (storage.getItem(key) === null) {
        storage.setItem(key, normalizeImportedStorageValue(key, value));
      }
    }
    return true;
  } catch {
    return false;
  }
}

export function bootstrapIishkoStorageOriginMigration(): void {
  const bridge = globalThis.window?.desktopBridge?.storageMigration;
  if (!bridge) return;

  try {
    const snapshot = bridge.readSnapshot();
    if (snapshot && importIishkoStorageSnapshot(snapshot)) {
      void bridge.acknowledgeSnapshot().catch(() => undefined);
    }
  } catch {
    // Keep the snapshot for a later retry if preload or storage is unavailable.
  }
}

bootstrapIishkoStorageOriginMigration();
