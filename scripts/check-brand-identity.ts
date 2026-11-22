// FILE: check-brand-identity.ts
// Purpose: Prevents retired first-party identities from returning to tracked files.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const characters = (...codes: number[]): string => String.fromCharCode(...codes);
const retiredShortName = characters(116, 51);
const retiredFirstName = `${retiredShortName}${characters(99, 111, 100, 101)}`;
const retiredCompanyName = `${retiredShortName}${characters(116, 111, 111, 108, 115)}`;
const retiredSecondName = characters(100, 112, 99, 111, 100, 101);
const retiredPredecessorName = characters(99, 111, 100, 101, 116, 104, 105, 110, 103);
const incorrectBundleDomain = characters(99, 111, 109, 46, 115, 121, 110, 97, 114, 97);
const retiredCompanyDisplayName = `${characters(84, 51)} ${characters(84, 111, 111, 108, 115)}`;
const retiredUpstreamName = characters(115, 121, 110, 97, 114, 97);
const retiredAuthorName = characters(101, 109, 97, 110, 117, 101, 108, 101);
const retiredAuthorDisplayName = `${characters(69, 109, 97, 110, 117, 101, 108, 101)} Di Pietro`;

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const joinedWithOptionalSeparator = (left: string, right: string): string =>
  `${escapeRegExp(left)}[\\s._/@:-]*${escapeRegExp(right)}`;

const forbiddenPatterns = [
  new RegExp(
    joinedWithOptionalSeparator(retiredShortName, retiredFirstName.slice(retiredShortName.length)),
    "i",
  ),
  new RegExp(
    joinedWithOptionalSeparator(
      retiredShortName,
      retiredCompanyName.slice(retiredShortName.length),
    ),
    "i",
  ),
  new RegExp(
    joinedWithOptionalSeparator(retiredSecondName.slice(0, 2), retiredSecondName.slice(2)),
    "i",
  ),
  new RegExp(escapeRegExp(retiredPredecessorName), "i"),
  new RegExp(`@${escapeRegExp(retiredCompanyName)}`, "i"),
  new RegExp(
    `(?:^|[\\s"'\\x60./:@_-])${escapeRegExp(retiredShortName)}(?:$|[\\s"'\\x60./:@_-])`,
    "i",
  ),
  new RegExp(escapeRegExp(incorrectBundleDomain), "i"),
  new RegExp(escapeRegExp(retiredUpstreamName), "i"),
  new RegExp(escapeRegExp(retiredAuthorName), "i"),
] as const;

interface ApprovedIdentityLine {
  readonly path: string;
  readonly line: string;
  readonly markdownSection?: string;
}

const approvedIdentityLines: readonly ApprovedIdentityLine[] = [
  // The original MIT copyright notices must stay in LICENSE; nothing else is exempt.
  {
    path: "LICENSE",
    line: `Copyright (c) 2026 ${retiredCompanyDisplayName} Inc.`,
  },
  {
    path: "LICENSE",
    line: `Copyright (c) 2026 ${retiredAuthorDisplayName}`,
  },
  // These two terms are the cubic time coefficient in the reviewed native
  // patch. Keep the patch and its recorded checksum unchanged.
  ...[0, 1].map((axis) => ({
    path: "apps/desktop/patches/cua-driver/0001-iishko-native.patch",
    line: `+                            + ${retiredShortName} * self.to.${axis}`,
  })),
];

// Raster images cannot be searched for embedded text. Keep reviewed user-facing
// screenshots behind digests so changing one requires another visual identity audit.
const approvedVisualAssetDigests = new Map<string, string>();

export interface BrandIdentityFile {
  readonly path: string;
  readonly contents: string;
}

export interface BrandIdentityViolation {
  readonly path: string;
  readonly line: number | null;
  readonly text: string;
}

export interface BrandIdentityBinaryFile {
  readonly path: string;
  readonly contents: Uint8Array;
}

function containsForbiddenIdentity(value: string): boolean {
  return forbiddenPatterns.some((pattern) => pattern.test(value));
}

function findApprovedIdentityLine(
  path: string,
  line: string,
  markdownSection: string | null,
  consumedLines: ReadonlySet<number>,
): number | null {
  const index = approvedIdentityLines.findIndex(
    (approved, candidateIndex) =>
      !consumedLines.has(candidateIndex) &&
      approved.path === path &&
      approved.line === line.trim() &&
      (approved.markdownSection === undefined || approved.markdownSection === markdownSection),
  );
  return index === -1 ? null : index;
}

export function findBrandIdentityViolations(
  files: readonly BrandIdentityFile[],
): BrandIdentityViolation[] {
  const violations: BrandIdentityViolation[] = [];
  for (const file of files) {
    if (containsForbiddenIdentity(file.path)) {
      violations.push({ path: file.path, line: null, text: file.path });
    }
    const consumedLines = new Set<number>();
    let markdownSection: string | null = null;
    for (const [index, line] of file.contents.split(/\r?\n/).entries()) {
      if (/^#{1,2}\s+/.test(line)) markdownSection = line.trim();
      if (!containsForbiddenIdentity(line)) continue;
      const approvedLine = findApprovedIdentityLine(
        file.path,
        line,
        markdownSection,
        consumedLines,
      );
      if (approvedLine !== null) {
        consumedLines.add(approvedLine);
        continue;
      }
      violations.push({ path: file.path, line: index + 1, text: line.trim() });
    }
  }
  return violations;
}

export function findVisualBrandAssetViolations(
  files: readonly BrandIdentityBinaryFile[],
  approvedDigests: ReadonlyMap<string, string> = approvedVisualAssetDigests,
): BrandIdentityViolation[] {
  const filesByPath = new Map(files.map((file) => [file.path, file]));
  const violations: BrandIdentityViolation[] = [];
  for (const [path, approvedDigest] of approvedDigests) {
    const file = filesByPath.get(path);
    if (!file) {
      violations.push({
        path,
        line: null,
        text: "Required visual brand asset is missing.",
      });
      continue;
    }
    const digest = createHash("sha256").update(file.contents).digest("hex");
    if (digest !== approvedDigest) {
      violations.push({
        path,
        line: null,
        text: "Visual brand asset changed; perform a visual identity review before approving it.",
      });
    }
  }
  return violations;
}

export function readTrackedFiles(cwd = process.cwd()): BrandIdentityBinaryFile[] {
  const list = (...args: string[]): string[] =>
    execFileSync("git", ["ls-files", ...args, "-z"], { cwd, encoding: "utf8" })
      .split("\0")
      .filter(Boolean);
  // Gitlinks name another repository, not a file owned by this checkout. They may
  // exist as directories or be absent when submodules have not been initialized.
  const tracked = list("--stage")
    .filter((entry) => !entry.startsWith("160000 "))
    .map((entry) => {
      const [meta = "", ...pathParts] = entry.split("\t");
      return { path: pathParts.join("\t"), hash: meta.split(" ")[1] ?? "" };
    });
  const files: BrandIdentityBinaryFile[] = [];
  const trackedPaths = new Set<string>();
  for (const { path, hash } of tracked) {
    trackedPaths.add(path);
    // A tracked file missing from the working tree is still committed from the index,
    // so its indexed content is what gets checked.
    files.push({
      path,
      contents: existsSync(resolve(cwd, path))
        ? readFileSync(resolve(cwd, path))
        : execFileSync("git", ["cat-file", "blob", hash], {
            cwd,
            maxBuffer: 512 * 1024 * 1024,
          }),
    });
  }
  for (const path of list("--others", "--exclude-standard")) {
    if (trackedPaths.has(path) || !existsSync(resolve(cwd, path))) continue;
    files.push({ path, contents: readFileSync(resolve(cwd, path)) });
  }
  return files;
}

function main(): void {
  const trackedFiles = readTrackedFiles();
  const searchableFiles = trackedFiles.map((file) => ({
    path: file.path,
    contents: file.contents.includes(0) ? "" : Buffer.from(file.contents).toString("utf8"),
  }));
  const trackedPaths = new Set(trackedFiles.map((file) => file.path));
  const violations = [
    ...findBrandIdentityViolations(searchableFiles),
    ...findVisualBrandAssetViolations(trackedFiles),
  ];
  if (violations.length === 0) {
    console.log("Iishko identity check passed.");
    return;
  }

  console.error("Retired first-party identity found:");
  for (const violation of violations) {
    const location =
      violation.line === null ? violation.path : `${violation.path}:${violation.line}`;
    console.error(`- ${location}: ${violation.text}`);
  }
  process.exitCode = 1;
}

if (import.meta.main) main();
