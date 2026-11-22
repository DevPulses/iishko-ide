import * as FS from "node:fs";
import * as OS from "node:os";
import * as Path from "node:path";

import { describe, expect, it } from "vitest";

import {
  acknowledgeIishkoStorageSnapshot,
  readIishkoStorageSnapshot,
  IISHKO_STORAGE_SNAPSHOT_MAX_BYTES,
  validateIishkoStorageSnapshot,
} from "./desktopStorageMigration";

const snapshot = () => ({
  version: 1 as const,
  exportedAt: "2026-07-09T00:00:00.000Z",
  entries: {
    "iishko:theme": "dark",
    "iishko.openUsage.enabled": "true",
  },
});

describe("desktopStorageMigration", () => {
  it("reads a legacy snapshot and removes it after acknowledgement", async () => {
    const directory = FS.mkdtempSync(Path.join(OS.tmpdir(), "iishko-storage-migration-"));
    const target = Path.join(directory, "snapshot.json");
    try {
      FS.writeFileSync(target, `${JSON.stringify(snapshot())}\n`);
      expect(readIishkoStorageSnapshot(target)).toEqual(snapshot());

      await acknowledgeIishkoStorageSnapshot(target);
      expect(readIishkoStorageSnapshot(target)).toBeNull();
    } finally {
      FS.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rejects malformed, disallowed, and oversized snapshots", () => {
    expect(validateIishkoStorageSnapshot({ version: 1 })).toBeNull();
    expect(
      validateIishkoStorageSnapshot({
        ...snapshot(),
        entries: { "foreign:theme": "dark" },
      }),
    ).toBeNull();
    expect(
      validateIishkoStorageSnapshot({
        ...snapshot(),
        entries: { "iishko:large": "x".repeat(IISHKO_STORAGE_SNAPSHOT_MAX_BYTES) },
      }),
    ).toBeNull();
  });

  it("accepts renderer snapshots containing large composer drafts", () => {
    const largeDraft = "x".repeat(2 * 1024 * 1024);

    expect(
      validateIishkoStorageSnapshot({
        ...snapshot(),
        entries: { "iishko:composer-drafts:v1": largeDraft },
      })?.entries["iishko:composer-drafts:v1"],
    ).toBe(largeDraft);
  });

  it("treats missing and malformed files as absent", () => {
    const directory = FS.mkdtempSync(Path.join(OS.tmpdir(), "iishko-storage-migration-"));
    const target = Path.join(directory, "snapshot.json");
    try {
      expect(readIishkoStorageSnapshot(target)).toBeNull();
      FS.writeFileSync(target, "not json");
      expect(readIishkoStorageSnapshot(target)).toBeNull();
    } finally {
      FS.rmSync(directory, { recursive: true, force: true });
    }
  });
});
