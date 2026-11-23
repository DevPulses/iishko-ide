// FILE: iishkoSession.ts
// Purpose: Exchanges the long-lived IISHKO device token for short-lived gateway session tokens.
// Layer: Server account service
//
// Sessions live in memory only. One refresh runs at a time per device token, and a
// revoked device is remembered so the account can show «Сессия завершена».

import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { decodeOutboundJson, outboundHttp } from "@iishko/shared/outboundHttp";

export const IISHKO_DEFAULT_ACCOUNT_API_BASE = "https://api.reformboss.com/webapp/api/ide";
export const IISHKO_ACCOUNT_API_BASE_ENV = "IISHKO_ACCOUNT_API_BASE";
// Outside the IISHKO_ namespace: provider child environments strip IISHKO_* keys.
export const IISHKO_DEVICE_TOKEN_ENV = "REFORMBOSS_DEVICE_TOKEN";
export const LEGACY_IISHKO_DEVICE_TOKEN_ENV = "IISHKO_DEVICE_TOKEN";
const REFRESH_MARGIN_MS = 120_000;
/** Device sessions reach the gateway through the Mini App backend proxy, not the public API. */
export const IISHKO_SESSION_BASE_URL = "https://api.reformboss.com/webapp/api/ide/v1";
const MAX_SESSION_LIFETIME_MS = 24 * 60 * 60_000;
const MS_EPOCH_THRESHOLD = 1e12;

export class IishkoDeviceRevokedError extends Error {
  override readonly name = "IishkoDeviceRevokedError";
}

interface CachedSession {
  readonly token: string;
  readonly baseUrl: string | null;
  readonly refreshAtMs: number;
  /** False when the session is already inside the refresh margin: usable once, never cached. */
  readonly cacheable: boolean;
}

let deviceTokenPath: string | undefined;

/** The IISHKO data home (`$IISHKO_HOME` or `~/.iishko-ide`); user-level files live under it. */
export function iishkoHomeDir(): string {
  return (
    process.env.IISHKO_HOME?.trim() ||
    join(process.env.HOME ?? process.env.USERPROFILE ?? ".", ".iishko-ide")
  );
}

/** The device token lives only in this server-side file (mode 0600), never in a process env. */
export function iishkoDeviceTokenPath(): string {
  if (deviceTokenPath) return deviceTokenPath;
  const home = iishkoHomeDir();
  return join(home, process.env.VITE_DEV_SERVER_URL ? "dev" : "userdata", "iishko", "device.json");
}

export function setIishkoDeviceTokenPath(path: string | undefined): void {
  deviceTokenPath = path;
}

export async function readIishkoDeviceToken(): Promise<string | undefined> {
  try {
    const parsed = record(JSON.parse(await readFile(iishkoDeviceTokenPath(), "utf8")));
    const token = typeof parsed?.deviceToken === "string" ? parsed.deviceToken.trim() : "";
    return token || undefined;
  } catch {
    return undefined;
  }
}

export async function writeIishkoDeviceToken(token: string | null): Promise<void> {
  const path = iishkoDeviceTokenPath();
  if (token === null) {
    await rm(path, { force: true });
    return;
  }
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${process.pid}.tmp`;
  await writeFile(temp, `${JSON.stringify({ deviceToken: token })}\n`, { mode: 0o600 });
  await chmod(temp, 0o600).catch(() => undefined);
  await rename(temp, path);
}

export interface IishkoSessionOptions {
  readonly env?: Readonly<NodeJS.ProcessEnv> | undefined;
  readonly request?: typeof outboundHttp.request | undefined;
  readonly now?: (() => number) | undefined;
}

let lastDeviceToken: string | undefined;
const sessions = new Map<string, CachedSession>();
const inflight = new Map<string, Promise<CachedSession>>();
const revoked = new Set<string>();

const fingerprint = (deviceToken: string): string =>
  createHash("sha256").update(deviceToken).digest("hex");

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function resolveIishkoAccountApiBase(
  env: Readonly<NodeJS.ProcessEnv> = process.env,
): string {
  const override = env[IISHKO_ACCOUNT_API_BASE_ENV]?.trim();
  if (override) {
    try {
      const url = new URL(override);
      const loopback = url.hostname === "127.0.0.1" || url.hostname === "localhost";
      if (
        (url.protocol === "https:" || (url.protocol === "http:" && loopback)) &&
        !url.username &&
        !url.password &&
        !url.search
      ) {
        return url.href.replace(/\/+$/u, "");
      }
    } catch {
      // An invalid override keeps the production endpoint.
    }
  }
  return IISHKO_DEFAULT_ACCOUNT_API_BASE;
}

/** The edge proxy on the apex host drops Authorization, so the token also travels in a custom header. */
export function deviceHeaders(deviceToken: string): Record<string, string> {
  return {
    accept: "application/json",
    authorization: `Bearer ${deviceToken}`,
    "x-iishko-device": deviceToken,
  };
}

/** Policy shared by every account-service request (pairing, token, profile, sign-out). */
export function iishkoAccountRequestPolicy(base: string, service: string) {
  const url = new URL(base);
  return {
    service,
    allowedOrigins: [url.origin],
    timeoutMs: 10_000,
    maxRequestBytes: 4 * 1024,
    maxResponseBytes: 256 * 1024,
    maxRedirects: 0,
    maxConcurrent: 2,
    maxQueued: 8,
    // A local mock server is the only plain-HTTP, private-address target allowed.
    requirePublicAddress: url.hostname !== "127.0.0.1" && url.hostname !== "localhost",
    allowLoopbackHttp: url.protocol === "http:",
    allowBenchmarkAddressRange: true,
  } as const;
}

async function exchange(
  deviceToken: string,
  options: IishkoSessionOptions,
): Promise<CachedSession> {
  const env = options.env ?? process.env;
  const now = options.now ?? Date.now;
  const request = options.request ?? outboundHttp.request.bind(outboundHttp);
  const base = resolveIishkoAccountApiBase(env);
  const response = await request({
    url: `${base}/token`,
    method: "POST",
    headers: deviceHeaders(deviceToken),
    policy: iishkoAccountRequestPolicy(base, "iishko-session"),
  });
  if (response.status === 401) {
    revoked.add(fingerprint(deviceToken));
    throw new IishkoDeviceRevokedError("The IISHKO device session was revoked.");
  }
  if (response.status !== 200) {
    throw new Error(`The IISHKO session service is unavailable (HTTP ${response.status}).`);
  }
  const payload = record(decodeOutboundJson(response, { maxDepth: 6, maxNodes: 200 }));
  const token = typeof payload?.token === "string" ? payload.token.trim() : "";
  if (!token) throw new Error("The IISHKO session service returned no token.");
  const refreshIn = typeof payload?.refresh_in === "number" ? payload.refresh_in * 1000 : 0;
  const rawExpiry = payload?.expires_at;
  const numericExpiry =
    typeof rawExpiry === "number"
      ? rawExpiry
      : typeof rawExpiry === "string" &&
          rawExpiry.trim() !== "" &&
          Number.isFinite(Number(rawExpiry))
        ? Number(rawExpiry)
        : undefined;
  // Unix seconds on the wire; a value above 1e12 is already milliseconds. ISO strings still parse.
  const expiresAt =
    numericExpiry !== undefined
      ? numericExpiry > MS_EPOCH_THRESHOLD
        ? numericExpiry
        : numericExpiry * 1000
      : typeof rawExpiry === "string"
        ? Date.parse(rawExpiry)
        : Number.NaN;
  const lifetimeMs = Math.min(
    Number.isFinite(expiresAt) ? expiresAt - now() : 15 * 60_000,
    MAX_SESSION_LIFETIME_MS,
  );
  const baseUrl =
    typeof payload?.base_url === "string" && payload.base_url.startsWith("https://")
      ? payload.base_url
      : null;
  revoked.delete(fingerprint(deviceToken));
  if (lifetimeMs <= REFRESH_MARGIN_MS) {
    return { token, baseUrl, refreshAtMs: now(), cacheable: false };
  }
  const untilRefresh = Math.min(
    refreshIn > 0 ? refreshIn : Number.POSITIVE_INFINITY,
    lifetimeMs - REFRESH_MARGIN_MS,
  );
  return { token, baseUrl, refreshAtMs: now() + untilRefresh, cacheable: true };
}

/** Returns a session token valid for at least the refresh margin; refreshes single-flight. */
export async function getIishkoSessionToken(
  deviceToken: string,
  options: IishkoSessionOptions & { readonly forceRefresh?: boolean | undefined } = {},
): Promise<string> {
  const key = fingerprint(deviceToken);
  const now = options.now ?? Date.now;
  const cached = sessions.get(key);
  if (!options.forceRefresh && cached && cached.refreshAtMs > now()) return cached.token;
  let pending = inflight.get(key);
  if (!pending) {
    pending = exchange(deviceToken, options)
      .then((session) => {
        if (session.baseUrl) sessionBaseUrls.set(key, session.baseUrl);
        else sessionBaseUrls.delete(key);
        if (session.cacheable) sessions.set(key, session);
        else sessions.delete(key);
        return session;
      })
      .catch((cause: unknown) => {
        if (cause instanceof IishkoDeviceRevokedError) sessions.delete(key);
        throw cause;
      })
      .finally(() => inflight.delete(key));
    inflight.set(key, pending);
  }
  return (await pending).token;
}

/** After a gateway 401 before any streamed byte: refresh once; a revoked device then shows as such. */
export async function refreshIishkoSessionOnce(options: IishkoSessionOptions = {}): Promise<void> {
  if (!lastDeviceToken) return;
  await getIishkoSessionToken(lastDeviceToken, { ...options, forceRefresh: true }).catch(
    () => undefined,
  );
}

const sessionBaseUrls = new Map<string, string>();

/** Gateway base URL for a device session: the one `/token` returned (https only), else the proxy. */
export function getIishkoSessionBaseUrl(deviceToken: string): string {
  return sessionBaseUrls.get(fingerprint(deviceToken)) ?? IISHKO_SESSION_BASE_URL;
}

export function markIishkoDeviceRevoked(deviceToken: string): void {
  const key = fingerprint(deviceToken);
  sessions.delete(key);
  revoked.add(key);
}

export function isIishkoDeviceRevoked(deviceToken: string): boolean {
  return revoked.has(fingerprint(deviceToken));
}

export function forgetIishkoSession(deviceToken: string): void {
  const key = fingerprint(deviceToken);
  sessions.delete(key);
  sessionBaseUrls.delete(key);
  revoked.delete(key);
}

/** The API key for the gateway: the device session wins; a raw key is returned only when no device exists. */
export async function resolveIishkoApiKey(
  environment: Readonly<NodeJS.ProcessEnv>,
  manualKeyEnv: string,
  options: IishkoSessionOptions & { readonly deviceToken?: string | undefined } = {},
): Promise<string | undefined> {
  const deviceToken = options.deviceToken?.trim() || (await readIishkoDeviceToken());
  if (deviceToken) {
    lastDeviceToken = deviceToken;
    return getIishkoSessionToken(deviceToken, { env: environment, ...options });
  }
  return environment[manualKeyEnv]?.trim() || undefined;
}
