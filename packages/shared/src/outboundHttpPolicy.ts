// FILE: outboundHttpPolicy.ts
// Purpose: Defines runtime-neutral outbound URL, address, redirect, and JSON safety policy.
// Layer: Shared security policy used by server and desktop transports

import * as Net from "node:net";

export type OutboundPolicyErrorCode =
  | "invalid-url"
  | "origin-not-allowed"
  | "private-address"
  | "json-depth"
  | "json-nodes";

export class OutboundPolicyError extends Error {
  readonly code: OutboundPolicyErrorCode;

  constructor(code: OutboundPolicyErrorCode, message: string) {
    super(message);
    this.name = "OutboundPolicyError";
    this.code = code;
  }
}

const blockedAddresses = new Net.BlockList();
const ipv4MappedAddresses = new Net.BlockList();
ipv4MappedAddresses.addSubnet("0.0.0.0", 0, "ipv4");

// RFC 2544 benchmarking. Fake-ip DNS modes (Clash/Mihomo, Surge) answer lookups
// with addresses from this range; the issuing proxy intercepts the connection.
const benchmarkAddresses = new Net.BlockList();
benchmarkAddresses.addSubnet("198.18.0.0", 15, "ipv4");

for (const [network, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const) {
  blockedAddresses.addSubnet(network, prefix, "ipv4");
}

for (const [network, prefix] of [
  ["::", 128],
  ["::1", 128],
  ["64:ff9b::", 96],
  ["100::", 64],
  ["2001:db8::", 32],
  ["2001:10::", 28],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
] as const) {
  blockedAddresses.addSubnet(network, prefix, "ipv6");
}

export function isPublicIpAddress(address: string): boolean {
  const family = Net.isIP(address);
  if (family === 4) {
    return !blockedAddresses.check(address, "ipv4");
  }
  if (family === 6) {
    if (ipv4MappedAddresses.check(address, "ipv6")) return false;
    return !blockedAddresses.check(address, "ipv6");
  }
  return false;
}

export function assertPublicIpAddress(address: string): void {
  if (!isPublicIpAddress(address)) {
    throw new OutboundPolicyError(
      "private-address",
      "Outbound destination resolved to a private, local, reserved, or invalid address.",
    );
  }
}

export function assertExactLoopbackIpAddress(address: string, allowIpv4Subnet = false): void {
  if (
    address !== "127.0.0.1" &&
    address.toLowerCase() !== "::1" &&
    !(allowIpv4Subnet && Net.isIP(address) === 4 && address.startsWith("127."))
  ) {
    throw new OutboundPolicyError(
      "private-address",
      "Outbound loopback destination resolved to a non-loopback address.",
    );
  }
}

/**
 * Whether an IPv4 address sits in the RFC 2544 benchmarking range
 * (198.18.0.0/15). It stays on the shared blocklist; callers pinned to
 * hard-coded origins can opt in per request because the only listener on these
 * addresses is the fake-ip proxy that issued them.
 */
export function isBenchmarkIpAddress(address: string): boolean {
  return Net.isIP(address) === 4 && benchmarkAddresses.check(address, "ipv4");
}

// Loopback plus the private LAN ranges local model servers live on. Link-local
// (169.254/16, fe80::/10), CGNAT, documentation, and multicast ranges stay out.
const privateLanAddresses = new Net.BlockList();
for (const [network, prefix] of [
  ["10.0.0.0", 8],
  ["172.16.0.0", 12],
  ["192.168.0.0", 16],
  ["127.0.0.0", 8],
] as const) {
  privateLanAddresses.addSubnet(network, prefix, "ipv4");
}
for (const [network, prefix] of [
  ["::1", 128],
  ["fc00::", 7],
] as const) {
  privateLanAddresses.addSubnet(network, prefix, "ipv6");
}

function embeddedIpv4OfMappedIpv6(address: string): string | undefined {
  const lower = address.toLowerCase();
  if (!lower.startsWith("::ffff:")) return undefined;
  const rest = lower.slice("::ffff:".length);
  if (Net.isIP(rest) === 4) return rest;
  const parts = rest.split(":");
  if (parts.length === 2 && parts.every((part) => /^[0-9a-f]{1,4}$/u.test(part))) {
    const high = Number.parseInt(parts[0]!, 16);
    const low = Number.parseInt(parts[1]!, 16);
    return `${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`;
  }
  return undefined;
}

export function isLoopbackOrPrivateLanIpAddress(address: string): boolean {
  const family = Net.isIP(address);
  if (family === 4) return privateLanAddresses.check(address, "ipv4");
  if (family === 6) {
    const embedded = embeddedIpv4OfMappedIpv6(address);
    if (embedded !== undefined) return privateLanAddresses.check(embedded, "ipv4");
    return privateLanAddresses.check(address, "ipv6");
  }
  return false;
}

// Plain HTTP is only meaningful on loopback/LAN destinations. IP literals are
// classified here; DNS names defer to the pinned-address assertion, which
// re-checks every resolved address before connecting.
function isPrivateLanHttpHostname(hostname: string): boolean {
  const host =
    hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
  const family = Net.isIP(host);
  if (family === 4 || family === 6) return isLoopbackOrPrivateLanIpAddress(host);
  return true;
}

/**
 * Address gate for user-configured endpoints (custom model servers): plain
 * HTTP reaches only loopback/private-LAN addresses; HTTPS additionally
 * reaches public addresses. Everything else stays rejected.
 */
export function assertPrivateLanEndpointAddress(address: string, protocol: string): void {
  const privateLan = isLoopbackOrPrivateLanIpAddress(address);
  const allowed = protocol === "http:" ? privateLan : privateLan || isPublicIpAddress(address);
  if (!allowed) {
    throw new OutboundPolicyError(
      "private-address",
      "Outbound destination resolved to a private, local, reserved, or invalid address.",
    );
  }
}

function isExactLoopbackHostname(hostname: string, allowIpv4Subnet = false): boolean {
  return (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "[::1]" ||
    (allowIpv4Subnet && Net.isIP(hostname) === 4 && hostname.startsWith("127."))
  );
}

export function normalizeOutboundOrigin(
  value: string | URL,
  options: {
    readonly allowLoopbackHttp?: boolean | "ipv4-subnet";
    readonly allowPrivateLanAddresses?: boolean;
  } = {},
): string {
  let url: URL;
  try {
    url = value instanceof URL ? value : new URL(value);
  } catch {
    throw new OutboundPolicyError("invalid-url", "Outbound destination is not a valid URL.");
  }
  const allowedProtocol =
    url.protocol === "https:" ||
    (Boolean(options.allowLoopbackHttp) &&
      url.protocol === "http:" &&
      isExactLoopbackHostname(url.hostname, options.allowLoopbackHttp === "ipv4-subnet")) ||
    (options.allowPrivateLanAddresses === true &&
      url.protocol === "http:" &&
      isPrivateLanHttpHostname(url.hostname));
  if (!allowedProtocol || url.username || url.password) {
    throw new OutboundPolicyError(
      "invalid-url",
      "Outbound destinations must use HTTPS without URL credentials unless loopback HTTP is explicitly allowed.",
    );
  }
  return url.origin;
}

export function assertOutboundUrlAllowed(input: {
  readonly url: string | URL;
  readonly allowedOrigins: ReadonlySet<string> | ReadonlyArray<string>;
  readonly allowLoopbackHttp?: boolean | "ipv4-subnet";
  readonly allowPrivateLanAddresses?: boolean;
}): URL {
  let url: URL;
  try {
    url = input.url instanceof URL ? new URL(input.url) : new URL(input.url);
  } catch {
    throw new OutboundPolicyError("invalid-url", "Outbound destination is not a valid URL.");
  }
  const options = {
    allowLoopbackHttp: input.allowLoopbackHttp ?? false,
    allowPrivateLanAddresses: input.allowPrivateLanAddresses === true,
  };
  const origin = normalizeOutboundOrigin(url, options);
  const allowedOrigins = new Set(
    Array.from(input.allowedOrigins, (allowedOrigin) =>
      normalizeOutboundOrigin(allowedOrigin, options),
    ),
  );
  if (!allowedOrigins.has(origin)) {
    throw new OutboundPolicyError(
      "origin-not-allowed",
      `Outbound destination origin '${origin}' is not allowed by this service policy.`,
    );
  }
  return url;
}

export function assertJsonWithinLimits(
  value: unknown,
  limits: { readonly maxDepth: number; readonly maxNodes: number },
): void {
  const stack: Array<{ readonly value: unknown; readonly depth: number }> = [{ value, depth: 0 }];
  const seen = new Set<object>();
  let nodes = 0;

  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) break;
    nodes += 1;
    if (nodes > limits.maxNodes) {
      throw new OutboundPolicyError(
        "json-nodes",
        `Outbound JSON exceeded the ${limits.maxNodes}-node limit.`,
      );
    }
    if (current.depth > limits.maxDepth) {
      throw new OutboundPolicyError(
        "json-depth",
        `Outbound JSON exceeded the depth limit of ${limits.maxDepth}.`,
      );
    }
    if (typeof current.value !== "object" || current.value === null) continue;
    if (seen.has(current.value)) continue;
    seen.add(current.value);
    const children = Array.isArray(current.value)
      ? current.value
      : Object.values(current.value as Record<string, unknown>);
    for (const child of children) {
      stack.push({ value: child, depth: current.depth + 1 });
    }
  }
}

export const OUTBOUND_SENSITIVE_HEADER_NAMES = new Set([
  "authorization",
  "cookie",
  "proxy-authorization",
]);

export function stripOutboundSensitiveHeaders(headers: Headers): Headers {
  const stripped = new Headers(headers);
  for (const name of OUTBOUND_SENSITIVE_HEADER_NAMES) {
    stripped.delete(name);
  }
  return stripped;
}
