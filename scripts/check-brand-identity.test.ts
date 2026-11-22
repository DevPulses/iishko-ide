import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  findBrandIdentityViolations,
  findVisualBrandAssetViolations,
  readTrackedFiles,
} from "./check-brand-identity";

const characters = (...codes: number[]): string => String.fromCharCode(...codes);
const shortName = characters(116, 51);
const firstName = `${shortName}${characters(99, 111, 100, 101)}`;
const secondName = characters(100, 112, 99, 111, 100, 101);
const companyDisplayName = `${characters(84, 51)} ${characters(84, 111, 111, 108, 115)}`;
const upstreamName = characters(115, 121, 110, 97, 114, 97);
const upstreamDisplayName = characters(83, 121, 110, 97, 114, 97);
const authorName = characters(101, 109, 97, 110, 117, 101, 108, 101);
const authorDisplayName = `${characters(69, 109, 97, 110, 117, 101, 108, 101)} Di Pietro`;
const companyNotice = `Copyright (c) 2026 ${companyDisplayName} Inc.`;
const authorNotice = `Copyright (c) 2026 ${authorDisplayName}`;

describe("brand identity guard", () => {
  it("scans owned files while ignoring initialized and absent gitlinks", () => {
    const cwd = mkdtempSync(join(tmpdir(), "iishko-brand-"));
    const git = (...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
    try {
      git("init", "--quiet");
      const path = "source with spaces.ts";
      writeFileSync(join(cwd, path), `const value = "${secondName}:state";`);
      git("add", "--", path);
      const oid = git("hash-object", "-w", path);
      git("update-index", "--add", "--cacheinfo", `160000,${oid},nested`);
      git("update-index", "--add", "--cacheinfo", `160000,${oid},absent`);
      mkdirSync(join(cwd, "nested"));
      writeFileSync(join(cwd, "nested", "outside.ts"), firstName);

      const files = readTrackedFiles(cwd);
      expect(files.map((file) => file.path)).toEqual([path]);
      expect(
        findBrandIdentityViolations(
          files.map((file) => ({ ...file, contents: Buffer.from(file.contents).toString("utf8") })),
        ),
      ).toHaveLength(1);

      // A tracked file missing from the working tree is still checked through its index content.
      rmSync(join(cwd, path));
      const stillChecked = readTrackedFiles(cwd);
      expect(stillChecked.map((file) => file.path)).toEqual([path]);
      expect(
        findBrandIdentityViolations(
          stillChecked.map((file) => ({
            path: file.path,
            contents: Buffer.from(file.contents).toString("utf8"),
          })),
        ),
      ).toHaveLength(1);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("reports retired names in untracked, non-ignored paths", () => {
    const cwd = mkdtempSync(join(tmpdir(), "iishko-brand-paths-"));
    const git = (...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
    try {
      git("init", "--quiet");
      writeFileSync(join(cwd, ".gitignore"), "ignored/\n");
      mkdirSync(join(cwd, "ignored"));
      writeFileSync(join(cwd, "ignored", `${upstreamName}.txt`), "x");
      writeFileSync(join(cwd, "clean.txt"), "x");
      writeFileSync(join(cwd, `${upstreamName}-notes.md`), "x");
      const violations = findBrandIdentityViolations(
        readTrackedFiles(cwd).map((file) => ({
          path: file.path,
          contents: Buffer.from(file.contents).toString("utf8"),
        })),
      );
      expect(violations.map((violation) => violation.path)).toEqual([`${upstreamName}-notes.md`]);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("detects retired names in paths and text", () => {
    const violations = findBrandIdentityViolations([
      { path: `docs/${firstName}.md`, contents: "IISHKO" },
      { path: "source.ts", contents: `const value = "${secondName}:state";` },
    ]);
    expect(violations).toHaveLength(2);
  });

  it.each([
    upstreamName,
    upstreamDisplayName,
    `try${upstreamName}.com`,
    `com.${authorName}dipietro.${upstreamName}`,
    authorName,
    authorDisplayName,
  ])("rejects the upstream product and author identity %s in text and paths", (token) => {
    expect(
      findBrandIdentityViolations([{ path: "source.ts", contents: `const brand = "${token}";` }]),
    ).toHaveLength(1);
    expect(findBrandIdentityViolations([{ path: `docs/${token}.md`, contents: "IISHKO" }])).toEqual(
      [{ path: `docs/${token}.md`, line: null, text: `docs/${token}.md` }],
    );
  });

  it("does not match ordinary numeric type names or canonical IISHKO text", () => {
    expect(
      findBrandIdentityViolations([
        { path: "source.ts", contents: "const value = new Uint32Array(); // IISHKO IDE" },
      ]),
    ).toEqual([]);
  });

  it("allows the original copyright notices once each, only in LICENSE", () => {
    const license = `${companyNotice}\n${authorNotice}`;
    expect(findBrandIdentityViolations([{ path: "LICENSE", contents: license }])).toEqual([]);
    expect(
      findBrandIdentityViolations([{ path: "docs/license-copy.md", contents: license }]),
    ).toHaveLength(2);
    expect(
      findBrandIdentityViolations([{ path: "LICENSE", contents: `${license}\n${companyNotice}` }]),
    ).toHaveLength(1);
    expect(
      findBrandIdentityViolations([
        { path: "LICENSE", contents: `${license}\nUse ${upstreamDisplayName}` },
      ]),
    ).toHaveLength(1);
  });

  it("allows only the two reviewed cubic expressions in the native patch", () => {
    const path = "apps/desktop/patches/cua-driver/0001-iishko-native.patch";
    const firstExpression = `+                            + ${shortName} * self.to.0`;
    const expressions = [firstExpression, firstExpression.replace("self.to.0", "self.to.1")];
    expect(findBrandIdentityViolations([{ path, contents: expressions.join("\n") }])).toEqual([]);
    for (const contents of [
      `${firstExpression}\n${firstExpression}`,
      firstExpression.replace("self.to.0", "self.from.0"),
      `${firstExpression} // ${firstName}`,
      `${expressions.join("\n")}\n+ ${secondName}`,
    ]) {
      expect(findBrandIdentityViolations([{ path, contents }])).toHaveLength(1);
    }
    expect(
      findBrandIdentityViolations([
        { path: "apps/desktop/patches/cua-driver/other.patch", contents: expressions.join("\n") },
      ]),
    ).toHaveLength(2);
  });

  it("requires user-facing raster assets to match a visually approved digest", () => {
    const approvedContents = new TextEncoder().encode("approved IISHKO screenshot");
    const approvedDigest = "d3b0eef1cbf7e5ee2caad0d8bb0a2f2dbc1ae0dc6bd7b2d8b1bb7d3d7d7e4c1c";
    const approvedDigests = new Map([["screenshot.jpeg", approvedDigest]]);

    expect(
      findVisualBrandAssetViolations(
        [{ path: "screenshot.jpeg", contents: new TextEncoder().encode("changed") }],
        approvedDigests,
      ),
    ).toHaveLength(1);
    expect(
      findVisualBrandAssetViolations(
        [{ path: "screenshot.jpeg", contents: approvedContents }],
        new Map(),
      ),
    ).toEqual([]);
    expect(findVisualBrandAssetViolations([], approvedDigests)).toHaveLength(1);
  });
});
