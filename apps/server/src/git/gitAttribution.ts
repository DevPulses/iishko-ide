// FILE: gitAttribution.ts
// Purpose: The optional "Created with Iishko" footer appended to the description of a
//          pull request Iishko creates.
// Layer: Git text helpers (pure)
// Exports: PULL_REQUEST_ATTRIBUTION_FOOTER, appendPullRequestAttribution

/** Last line of a pull request description Iishko creates. */
export const PULL_REQUEST_ATTRIBUTION_FOOTER = "Created with [IISHKO](https://reformboss.com)";

// The linked footer, its plain form, and small URL variations all count as already attributed.
const PULL_REQUEST_FOOTER_PATTERN =
  /^created with (?:iishko|\[iishko\]\(https?:\/\/(?:www\.)?reformboss\.com\/?\))$/i;

/**
 * Ends a pull request description with the Iishko footer, separated by a blank line.
 * A description that already carries the footer anywhere is returned unchanged.
 */
export function appendPullRequestAttribution(body: string): string {
  if (body.split(/\r?\n/).some((line) => PULL_REQUEST_FOOTER_PATTERN.test(line.trim()))) {
    return body;
  }
  const trimmed = body.trimEnd();
  return trimmed.length > 0
    ? `${trimmed}\n\n${PULL_REQUEST_ATTRIBUTION_FOOTER}`
    : PULL_REQUEST_ATTRIBUTION_FOOTER;
}
