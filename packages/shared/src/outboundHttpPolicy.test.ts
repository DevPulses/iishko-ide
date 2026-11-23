import { describe, expect, it } from "vitest";

import {
  assertExactLoopbackIpAddress,
  assertOutboundUrlAllowed,
  assertPrivateLanEndpointAddress,
  assertPublicIpAddress,
  isBenchmarkIpAddress,
  isLoopbackOrPrivateLanIpAddress,
  isPublicIpAddress,
  normalizeOutboundOrigin,
  OutboundPolicyError,
} from "./outboundHttpPolicy";

describe("outbound HTTP URL policy", () => {
  it("keeps HTTPS as the default", () => {
    expect(normalizeOutboundOrigin("https://api.example.com/path")).toBe("https://api.example.com");
    expect(() => normalizeOutboundOrigin("http://localhost:3000")).toThrowError(
      OutboundPolicyError,
    );
  });

  it.each(["http://localhost:3000", "http://127.0.0.1:3000", "http://[::1]:3000"])(
    "allows opted-in exact loopback origin %s",
    (url) => {
      expect(normalizeOutboundOrigin(url, { allowLoopbackHttp: true })).toBe(new URL(url).origin);
      expect(
        assertOutboundUrlAllowed({
          url: `${url}/status`,
          allowedOrigins: [new URL(url).origin],
          allowLoopbackHttp: true,
        }).pathname,
      ).toBe("/status");
    },
  );

  it.each([
    "http://api.example.com",
    "http://localhost.example.com",
    "http://dev.localhost:3000",
    "http://127.0.0.2:3000",
    "http://192.168.1.5:3000",
  ])("rejects opted-in non-loopback HTTP origin %s", (url) => {
    expect(() => normalizeOutboundOrigin(url, { allowLoopbackHttp: true })).toThrowError(
      OutboundPolicyError,
    );
  });

  it("rejects URL credentials with the loopback opt-in", () => {
    expect(() =>
      assertOutboundUrlAllowed({
        url: "http://user:password@localhost:3000/status",
        allowedOrigins: ["http://localhost:3000"],
        allowLoopbackHttp: true,
      }),
    ).toThrowError(OutboundPolicyError);
  });

  it("accepts only exact loopback addresses for opted-in transport pinning", () => {
    expect(() => assertExactLoopbackIpAddress("127.0.0.1")).not.toThrow();
    expect(() => assertExactLoopbackIpAddress("::1")).not.toThrow();
    expect(() => assertExactLoopbackIpAddress("127.0.0.2")).toThrowError(OutboundPolicyError);
    expect(() => assertExactLoopbackIpAddress("192.168.1.5")).toThrowError(OutboundPolicyError);
  });

  it("permits the loopback IPv4 subnet only under the explicit MCP policy", () => {
    expect(
      normalizeOutboundOrigin("http://127.42.0.7/mcp", { allowLoopbackHttp: "ipv4-subnet" }),
    ).toBe("http://127.42.0.7");
    expect(() => assertExactLoopbackIpAddress("127.42.0.7", true)).not.toThrow();
    expect(() => assertExactLoopbackIpAddress("192.168.1.1", true)).toThrow();
    expect(() =>
      normalizeOutboundOrigin("http://localhost.example.com", { allowLoopbackHttp: "ipv4-subnet" }),
    ).toThrow();
  });
});

describe("isPublicIpAddress", () => {
  it("rejects every textual form of an IPv4-mapped IPv6 address", () => {
    expect(isPublicIpAddress("::ffff:8.8.8.8")).toBe(false);
    expect(isPublicIpAddress("0:0:0:0:0:ffff:8.8.8.8")).toBe(false);
    expect(isPublicIpAddress("::ffff:0808:0808")).toBe(false);
    expect(isPublicIpAddress("0:0:0:0:0:ffff:0808:0808")).toBe(false);
  });

  it("still accepts ordinary public IPv4 and IPv6 addresses", () => {
    expect(isPublicIpAddress("8.8.8.8")).toBe(true);
    expect(isPublicIpAddress("2001:4860:4860::8888")).toBe(true);
  });
});

describe("isBenchmarkIpAddress", () => {
  it("matches the RFC 2544 benchmarking range only", () => {
    expect(isBenchmarkIpAddress("198.18.0.0")).toBe(true);
    expect(isBenchmarkIpAddress("198.18.0.1")).toBe(true);
    expect(isBenchmarkIpAddress("198.19.255.255")).toBe(true);
    expect(isBenchmarkIpAddress("198.17.255.255")).toBe(false);
    expect(isBenchmarkIpAddress("198.20.0.0")).toBe(false);
    expect(isBenchmarkIpAddress("8.8.8.8")).toBe(false);
    expect(isBenchmarkIpAddress("::1")).toBe(false);
    expect(isBenchmarkIpAddress("not-an-address")).toBe(false);
  });

  it("keeps the range on the shared blocklist for ordinary callers", () => {
    expect(isPublicIpAddress("198.18.0.1")).toBe(false);
    expect(() => assertPublicIpAddress("198.18.0.1")).toThrowError(OutboundPolicyError);
    expect(() => assertPublicIpAddress("198.19.255.255")).toThrowError(/private/u);
  });
});

describe("isLoopbackOrPrivateLanIpAddress", () => {
  it.each([
    "127.0.0.1",
    "127.42.0.7",
    "::1",
    "10.0.0.1",
    "10.255.255.255",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.20",
    "192.168.255.255",
    "fd00::1",
    "fc00::abcd",
    "::ffff:10.0.0.1",
    "::ffff:c0a8:0101",
  ])("accepts loopback/private LAN %s", (address) => {
    expect(isLoopbackOrPrivateLanIpAddress(address)).toBe(true);
  });

  it.each([
    "8.8.8.8",
    "1.1.1.1",
    "169.254.1.1",
    "fe80::1",
    "100.64.0.1",
    "172.15.0.1",
    "172.32.0.1",
    "192.167.1.1",
    "192.0.2.1",
    "198.51.100.1",
    "203.0.113.1",
    "224.0.0.1",
    "::ffff:8.8.8.8",
    "not-an-address",
  ])("rejects non-LAN %s", (address) => {
    expect(isLoopbackOrPrivateLanIpAddress(address)).toBe(false);
  });
});

describe("assertPrivateLanEndpointAddress", () => {
  it("permits HTTP only to loopback and private LAN addresses", () => {
    expect(() => assertPrivateLanEndpointAddress("192.168.1.20", "http:")).not.toThrow();
    expect(() => assertPrivateLanEndpointAddress("10.1.2.3", "http:")).not.toThrow();
    expect(() => assertPrivateLanEndpointAddress("127.0.0.1", "http:")).not.toThrow();
    expect(() => assertPrivateLanEndpointAddress("fd00::1", "http:")).not.toThrow();
    expect(() => assertPrivateLanEndpointAddress("8.8.8.8", "http:")).toThrowError(
      OutboundPolicyError,
    );
    expect(() => assertPrivateLanEndpointAddress("169.254.1.1", "http:")).toThrowError(
      OutboundPolicyError,
    );
  });

  it("permits HTTPS to public and private LAN addresses", () => {
    expect(() => assertPrivateLanEndpointAddress("8.8.8.8", "https:")).not.toThrow();
    expect(() => assertPrivateLanEndpointAddress("192.168.1.20", "https:")).not.toThrow();
    expect(() => assertPrivateLanEndpointAddress("169.254.1.1", "https:")).toThrowError(
      OutboundPolicyError,
    );
    expect(() => assertPrivateLanEndpointAddress("100.64.0.1", "https:")).toThrowError(
      OutboundPolicyError,
    );
  });
});

describe("allowPrivateLanAddresses URL policy", () => {
  const options = { allowPrivateLanAddresses: true };

  it.each([
    "http://192.168.1.20:8080/v1",
    "http://10.0.0.5:11434",
    "http://172.16.3.4:8000",
    "http://127.0.0.1:8080",
    "http://localhost:8080",
    "http://my-server.local:8080",
    "http://[fd00::1]:8080",
    "https://192.168.1.20:8443",
    "https://api.example.com",
  ])("allows opted-in endpoint origin %s", (url) => {
    expect(normalizeOutboundOrigin(url, options)).toBe(new URL(url).origin);
  });

  it.each([
    "http://8.8.8.8:80",
    "http://169.254.1.1:80",
    "http://192.0.2.1:80",
    "http://[fe80::1]:80",
    "http://user:pass@192.168.1.20:8080",
  ])("rejects opted-in unsafe origin %s", (url) => {
    expect(() => normalizeOutboundOrigin(url, options)).toThrowError(OutboundPolicyError);
  });
});
