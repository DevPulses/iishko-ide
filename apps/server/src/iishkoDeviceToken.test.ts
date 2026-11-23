// FILE: iishkoDeviceToken.test.ts
// Purpose: Profile payload parsing, the device-token secret name and its survival in provider environments.
// Layer: Server unit tests

import {
  DEFAULT_SERVER_SETTINGS,
  type ServerSettings,
  type ServerSettingsPatch,
} from "@iishko/contracts";
import type { OutboundHttpRequest, OutboundHttpResponse } from "@iishko/shared/outboundHttp";
import { applyServerSettingsPatch } from "@iishko/shared/serverSettings";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, expect, it } from "vitest";

import { makeIishkoAccount, parseIishkoProfile } from "./iishkoAccount.ts";
import {
  getIishkoSessionBaseUrl,
  getIishkoSessionToken,
  IISHKO_SESSION_BASE_URL,
  IishkoDeviceRevokedError,
  IISHKO_DEVICE_TOKEN_ENV,
  LEGACY_IISHKO_DEVICE_TOKEN_ENV,
  readIishkoDeviceToken,
  resolveIishkoApiKey,
  setIishkoDeviceTokenPath,
  writeIishkoDeviceToken,
} from "./iishkoSession.ts";
import { buildProviderChildEnvironment } from "./providerChildEnvironment.ts";
import {
  IISHKO_API_KEY_ENV,
  isIishkoUnauthorizedError,
  resolveIishkoBaseUrl,
  mapIishkoGatewayError,
} from "./provider/iishkoProvider.ts";

const json = (status: number, body: unknown): OutboundHttpResponse => ({
  status,
  url: "https://example.invalid",
  headers: new Headers({ "content-type": "application/json" }),
  body: Buffer.from(JSON.stringify(body)),
});

const REAL_SHAPE = {
  user: { username: "iishko_user", first_name: "Никита" },
  rank: { tier: 2, title: "Актив", emoji: "⚡" },
  balance: { usd: 1.5, weekly_credit_usd: 0.5 },
  models: { available: [{ id: "deepseek-v4-flash" }], locked: [] },
  device: { name: "WORKSTATION", created_at: 1_795_000_000 },
  limits: {
    reset_at: 1_795_100_000,
    rpm: 30,
    concurrency: 2,
    requests_limit: 100,
    daily_usd_cap: 5,
    requests_today: 7,
    daily_usd_used: 0.25,
  },
};

it("parses the live profile shape: numeric tiers and unix-second times", () => {
  const profile = parseIishkoProfile(REAL_SHAPE, "2026-11-22T00:00:00.000Z");
  expect(profile).toMatchObject({
    rank: { tier: "2", title: "Актив", emoji: "⚡" },
    limits: { requestsLimit: 100, rpm: 30, concurrency: 2, dailyUsdCap: 5 },
    balance: { usd: 1.5, weeklyCreditUsd: 0.5 },
    device: { name: "WORKSTATION", createdAt: new Date(1_795_000_000 * 1000).toISOString() },
  });
  expect(profile?.limits?.resetAt).toBe(new Date(1_795_100_000 * 1000).toISOString());
});

it("accepts numeric strings, numeric locked tiers and a minimal profile", () => {
  const profile = parseIishkoProfile(
    {
      user: { username: "u" },
      rank: { tier: "3", title: "Профи", next: { tier: 4, title: "Легенда" } },
      models: { available: [], locked: [{ id: "m", min_tier: 3 }] },
      limits: { requests_limit: "50", reset_at: "1795100000" },
      ide_only: { applies: true, enforced_from: 1_795_000_000 },
    },
    "2026-11-22T00:00:00.000Z",
  );
  expect(profile).toMatchObject({
    rank: { tier: "3", next: { tier: "4", title: "Легенда" } },
    models: { locked: [{ id: "m", minTier: "3" }] },
    limits: { requestsLimit: 50 },
    ideOnly: { applies: true, enforcedFrom: new Date(1_795_000_000 * 1000).toISOString() },
  });
  expect(
    parseIishkoProfile(
      {
        user: { username: "u" },
        rank: { tier: 0, title: "Новичок" },
        models: { available: [], locked: [] },
      },
      "2026-11-22T00:00:00.000Z",
    ),
  ).toMatchObject({ rank: { tier: "0" } });
});

const tempDirs: string[] = [];
afterEach(() => {
  setIishkoDeviceTokenPath(undefined);
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function useTempTokenStore(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "iishko-device-store-"));
  tempDirs.push(dir);
  const file = path.join(dir, "iishko", "device.json");
  setIishkoDeviceTokenPath(file);
  return file;
}

it("builds a pi child environment without any device token", () => {
  const child = buildProviderChildEnvironment({
    provider: "pi",
    baseEnv: {},
    overrides: {
      REFORMBOSS_DEVICE_TOKEN: "idd_x",
      IISHKO_DEVICE_TOKEN: "idd_y",
      IISHKO_TELEGRAM_BOT_TOKEN: "1:b",
    },
  });
  expect(child.IISHKO_DEVICE_TOKEN).toBeUndefined();
  expect(child.IISHKO_TELEGRAM_BOT_TOKEN).toBeUndefined();
  // The account never writes the token into an environment, so a clean instance stays clean.
  const clean = buildProviderChildEnvironment({ provider: "pi", baseEnv: {}, overrides: {} });
  expect(Object.keys(clean).some((key) => /DEVICE_TOKEN/u.test(key))).toBe(false);
});

it("stores the device token in a 0600 file and resolves a session from it", async () => {
  const file = useTempTokenStore();
  await writeIishkoDeviceToken("idd_store_roundtrip");
  expect(await readIishkoDeviceToken()).toBe("idd_store_roundtrip");
  if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600);
  const request = async (input: OutboundHttpRequest) => {
    expect(new Headers(input.headers).get("x-iishko-device")).toBe("idd_store_roundtrip");
    return json(200, {
      token: "ids_session",
      expires_at: Math.floor(Date.now() / 1000) + 900,
      refresh_in: 600,
    });
  };
  expect(await resolveIishkoApiKey({}, IISHKO_API_KEY_ENV, { request })).toBe("ids_session");
  await writeIishkoDeviceToken(null);
  expect(await readIishkoDeviceToken()).toBeUndefined();
});

it("moves a device token found in the provider environment into the store and cleans the env", async () => {
  useTempTokenStore();
  for (const envName of [LEGACY_IISHKO_DEVICE_TOKEN_ENV, IISHKO_DEVICE_TOKEN_ENV]) {
    await writeIishkoDeviceToken(null);
    let settings: ServerSettings = {
      ...DEFAULT_SERVER_SETTINGS,
      providerInstances: {
        ...DEFAULT_SERVER_SETTINGS.providerInstances,
        pi: {
          driver: "pi",
          environment: [{ name: envName, value: "idd_legacy", sensitive: true }],
        },
      },
    } as ServerSettings;
    const account = makeIishkoAccount({
      stateDir: path.join(tempDirs[0]!),
      readSettings: async () => settings,
      updateSettings: async (derive: (current: ServerSettings) => ServerSettingsPatch) => {
        settings = applyServerSettingsPatch(settings, derive(settings));
      },
      refreshProviders: async () => undefined,
      env: {},
      request: async () => json(200, {}),
    });
    await account.status();
    expect(await readIishkoDeviceToken()).toBe("idd_legacy");
    expect(settings.providerInstances.pi?.environment ?? []).toEqual([]);
  }
});

it("never caches a session that is already inside the refresh margin", async () => {
  let calls = 0;
  const request = async () => {
    calls += 1;
    return json(200, {
      token: `ids_${calls}`,
      expires_at: Math.floor(Date.now() / 1000) + 60,
      refresh_in: 600,
    });
  };
  expect(await getIishkoSessionToken("idd_short", { request })).toBe("ids_1");
  expect(await getIishkoSessionToken("idd_short", { request })).toBe("ids_2");
  expect(calls).toBe(2);
});

it("treats an expires_at above 1e12 as milliseconds and caps the lifetime at 24 hours", async () => {
  let calls = 0;
  const clock = 1_000_000;
  const ms = async () => {
    calls += 1;
    return json(200, {
      token: "ids_ms",
      expires_at: clock + 900_000 + 1e12,
      refresh_in: 1_000_000_000,
    });
  };
  expect(await getIishkoSessionToken("idd_ms", { request: ms, now: () => clock })).toBe("ids_ms");
  // Refresh is due within the 24 h cap, not at the far-future millisecond value.
  expect(
    await getIishkoSessionToken("idd_ms", { request: ms, now: () => clock + 25 * 3_600_000 }),
  ).toBe("ids_ms");
  expect(calls).toBe(2);
});

it("never falls back to a manual key for a device session, revoked or not", async () => {
  useTempTokenStore();
  await writeIishkoDeviceToken("idd_fallback");
  const env = { [IISHKO_API_KEY_ENV]: "sk-manual" };
  await expect(
    resolveIishkoApiKey(env, IISHKO_API_KEY_ENV, { request: async () => json(503, {}) }),
  ).rejects.toThrow(/unavailable/u);
  // A revoked device stays revoked: the raw key must not silently replace it.
  await expect(
    resolveIishkoApiKey(env, IISHKO_API_KEY_ENV, { request: async () => json(401, {}) }),
  ).rejects.toBeInstanceOf(IishkoDeviceRevokedError);
  // Without a device token the raw key is returned as-is for the caller to gate.
  await writeIishkoDeviceToken(null);
  expect(
    await resolveIishkoApiKey(env, IISHKO_API_KEY_ENV, {
      request: async () => {
        throw new Error("must not be called");
      },
    }),
  ).toBe("sk-manual");
});

it.each([
  "HTTP 401: nope",
  "status=401",
  "401 Unauthorized",
  "Error: 401,",
  "invalid_api_key",
  "device_revoked",
])("detects an unauthorized gateway error: %s", (message) => {
  expect(isIishkoUnauthorizedError(new Error(message), message)).toBe(true);
});

it("does not mistake other numbers for a 401, and trusts a structured status", () => {
  expect(isIishkoUnauthorizedError(new Error("took 4012 ms"), "took 4012 ms")).toBe(false);
  expect(isIishkoUnauthorizedError(Object.assign(new Error("x"), { status: 401 }), "x")).toBe(true);
});

it("maps a gateway 413 to the Russian context-length message", () => {
  expect(mapIishkoGatewayError('413 {"error":{"type":"ctxguard_12000"}}')).toContain("≈12000");
  expect(mapIishkoGatewayError("413 Payload Too Large")).toBe(
    "Запрос не помещается в контекст модели. Начните новый чат или выберите модель с большим контекстом.",
  );
  expect(mapIishkoGatewayError('400 {"error":{"code":"context_length_exceeded"}}')).toContain(
    "контекст",
  );
});

it("picks the gateway base URL per auth source", async () => {
  const sessionBody = (baseUrl?: string) => ({
    token: "ids_x",
    expires_at: Math.floor(Date.now() / 1000) + 900,
    refresh_in: 600,
    ...(baseUrl ? { base_url: baseUrl } : {}),
  });
  await getIishkoSessionToken("idd_base_a", { request: async () => json(200, sessionBody()) });
  expect(getIishkoSessionBaseUrl("idd_base_a")).toBe(IISHKO_SESSION_BASE_URL);
  await getIishkoSessionToken("idd_base_b", {
    request: async () => json(200, sessionBody("https://gw.example.test/ide/v1")),
    forceRefresh: true,
  });
  expect(getIishkoSessionBaseUrl("idd_base_b")).toBe("https://gw.example.test/ide/v1");
  await getIishkoSessionToken("idd_base_c", {
    request: async () => json(200, sessionBody("http://insecure.example.test/v1")),
    forceRefresh: true,
  });
  expect(getIishkoSessionBaseUrl("idd_base_c")).toBe(IISHKO_SESSION_BASE_URL);
  expect(resolveIishkoBaseUrl({}, IISHKO_SESSION_BASE_URL)).toBe(IISHKO_SESSION_BASE_URL);
  expect(resolveIishkoBaseUrl({})).toBe("https://api.reformboss.com/v1");
  expect(
    resolveIishkoBaseUrl(
      { REFORMBOSS_API_BASE_URL: "http://127.0.0.1:4199/v1" },
      IISHKO_SESSION_BASE_URL,
    ),
  ).toBe("http://127.0.0.1:4199/v1");
});
