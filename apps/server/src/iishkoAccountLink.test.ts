// FILE: iishkoAccountLink.test.ts
// Purpose: Telegram link sign-in, device sessions, profile and sign-out against a stubbed account service.
// Layer: Server unit tests

import { Schema } from "effect";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  DEFAULT_SERVER_SETTINGS,
  ServerSettings,
  type ServerSettingsPatch,
} from "@iishko/contracts";
import type { OutboundHttpRequest, OutboundHttpResponse } from "@iishko/shared/outboundHttp";
import { applyServerSettingsPatch } from "@iishko/shared/serverSettings";
import { afterEach, expect, it, vi } from "vitest";

import { makeIishkoAccount } from "./iishkoAccount.ts";
import { getIishkoSessionToken, readIishkoDeviceToken } from "./iishkoSession.ts";

const MODELS = {
  data: [
    { id: "deepseek-v4-flash", supported_endpoint_types: ["openai"] },
    { id: "claude-opus-5-5", supported_endpoint_types: ["openai"] },
  ],
};
const BASE = "https://api.reformboss.com/webapp/api/ide";
const LINK = "https://t.me/iishkogatewaybot?start=ide_ABCD1234";

function json(status: number, body: unknown): OutboundHttpResponse {
  return {
    status,
    url: "https://example.invalid",
    headers: new Headers({ "content-type": "application/json" }),
    body: Buffer.from(JSON.stringify(body)),
  };
}

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

type Route = (input: OutboundHttpRequest) => OutboundHttpResponse | undefined;

function harness(route: Route) {
  const stateDir = mkdtempSync(path.join(tmpdir(), "iishko-link-"));
  dirs.push(stateDir);
  let settings: ServerSettings = DEFAULT_SERVER_SETTINGS;
  const request = vi.fn(async (input: OutboundHttpRequest) => route(input) ?? json(200, MODELS));
  const account = makeIishkoAccount({
    stateDir,
    readSettings: async () => settings,
    updateSettings: async (derive: (current: ServerSettings) => ServerSettingsPatch) => {
      settings = applyServerSettingsPatch(settings, derive(settings));
    },
    refreshProviders: async () => undefined,
    env: {},
    request,
  });
  return { account, request, stateDir, settings: () => settings };
}

async function storedDevice(settings: ServerSettings) {
  const envEntries = settings.providerInstances.pi?.environment ?? [];
  // The long-lived token must never sit in a provider environment.
  expect(envEntries.some((entry) => /DEVICE_TOKEN/u.test(entry.name))).toBe(false);
  const value = await readIishkoDeviceToken();
  return value ? { value, sensitive: true } : undefined;
}

function pairingRoute(
  deviceToken: string,
  poll: () => OutboundHttpResponse,
  extra: Route = () => undefined,
): Route {
  return (input) => {
    const custom = extra(input);
    if (custom) return custom;
    const url = String(input.url);
    if (url === `${BASE}/pair/start`) {
      return json(200, {
        pair_id: "backend-secret-pair",
        code: "K7Q2-9F",
        link: LINK,
        expires_in: 300,
        interval: 2,
      });
    }
    if (url === `${BASE}/pair/poll`) {
      expect(JSON.parse(String(input.body))).toEqual({ pair_id: "backend-secret-pair" });
      return poll();
    }
    if (url === `${BASE}/token`) {
      return new Headers(input.headers).get("authorization") === `Bearer ${deviceToken}`
        ? json(200, {
            token: `session-${deviceToken}`,
            expires_at: new Date(Date.now() + 900_000).toISOString(),
            refresh_in: 600,
          })
        : json(401, { error: "invalid_device" });
    }
    return undefined;
  };
}

async function startPairing(account: ReturnType<typeof harness>["account"]) {
  const started = await account.beginTelegramPairing();
  if (started.state !== "started") throw new Error("pairing did not start");
  return started;
}

const approved = (token: string) =>
  json(200, {
    status: "approved",
    device_token: token,
    account: { username: "u", first_name: "Н" },
  });

it("pairs by link, stores only the device token as a secret and hides the backend pair id", async () => {
  let polls = 0;
  const { account, settings, stateDir } = harness(
    pairingRoute("dev-approve-1", () => {
      polls += 1;
      return polls === 1 ? json(200, { status: "pending" }) : approved("dev-approve-1");
    }),
  );
  const started = await startPairing(account);
  expect(started).toMatchObject({ code: "K7Q2-9F", botUrl: LINK, pollIntervalMs: 2000 });
  expect(JSON.stringify(started)).not.toContain("backend-secret-pair");
  expect(await account.pollTelegramPairing({ pairingId: started.pairingId })).toEqual({
    state: "pending",
  });
  const done = await account.pollTelegramPairing({ pairingId: started.pairingId });
  expect(done).toMatchObject({
    state: "connected",
    status: { source: "telegram", account: { username: "u", displayName: "Н" } },
  });
  expect(JSON.stringify(done)).not.toContain("dev-approve-1");
  expect(await storedDevice(settings())).toMatchObject({ value: "dev-approve-1", sensitive: true });
  expect(readFileSync(path.join(stateDir, "iishko", "account.json"), "utf8")).not.toContain(
    "dev-approve-1",
  );
  expect(await account.pollTelegramPairing({ pairingId: started.pairingId })).toEqual({
    state: "expired",
  });
});

it.each([
  ["denied", "denied"],
  ["expired", "expired"],
  ["consumed", "expired"],
])("settles a %s pairing as %s", async (backend, expected) => {
  const { account, settings } = harness(
    pairingRoute("dev-unused", () => json(200, { status: backend })),
  );
  const started = await startPairing(account);
  expect(await account.pollTelegramPairing({ pairingId: started.pairingId })).toEqual({
    state: expected,
  });
  expect(await storedDevice(settings())).toBeUndefined();
});

it("treats a 404 poll as expired and reports rate limiting with the wait", async () => {
  const gone = harness(pairingRoute("dev-unused", () => json(404, {})));
  const started = await startPairing(gone.account);
  expect(await gone.account.pollTelegramPairing({ pairingId: started.pairingId })).toEqual({
    state: "expired",
  });
  const limited = harness(() => json(429, { error: "rate_limited", retry_after: 42 }));
  await expect(limited.account.beginTelegramPairing()).rejects.toMatchObject({
    message: expect.stringContaining("42"),
  });
});

it("shows a revoked device and clears everything on sign-out", async () => {
  const calls: string[] = [];
  const { account, settings, stateDir } = harness(
    pairingRoute(
      "dev-revoke-1",
      () => approved("dev-revoke-1"),
      (input) => {
        calls.push(String(input.url));
        return String(input.url) === `${BASE}/signout` ? json(200, { ok: true }) : undefined;
      },
    ),
  );
  const started = await startPairing(account);
  await account.pollTelegramPairing({ pairingId: started.pairingId });
  expect(await account.status()).toMatchObject({ state: "connected", source: "telegram" });
  await expect(
    getIishkoSessionToken("dev-revoke-1", {
      forceRefresh: true,
      request: async () => json(401, { error: "device_revoked" }),
    }),
  ).rejects.toThrow("revoked");
  expect(await account.status()).toMatchObject({ state: "revoked" });
  const cachePath = path.join(stateDir, "iishko", "models-cache.json");
  mkdirSync(path.dirname(cachePath), { recursive: true });
  writeFileSync(cachePath, "{}");
  expect(settings().newThreadDefaults.modelSelectionByProvider.pi?.model).toMatch(/^iishko\//u);
  await account.signOut();
  expect(settings().newThreadDefaults.modelSelectionByProvider.pi).toBeUndefined();
  expect(() => Schema.decodeUnknownSync(ServerSettings)(settings())).not.toThrow();
  expect(calls).toContain(`${BASE}/signout`);
  expect(existsSync(cachePath)).toBe(false);
  expect(await storedDevice(settings())).toBeUndefined();
  expect(await account.status()).toEqual({ state: "disconnected" });
});

it("refreshes the session token before it expires and shares concurrent refreshes", async () => {
  let clock = 1_000_000;
  let exchanges = 0;
  const request = async (_input: OutboundHttpRequest) => {
    exchanges += 1;
    return json(200, {
      token: `session-${exchanges}`,
      expires_at: new Date(clock + 600_000).toISOString(),
      refresh_in: 300,
    });
  };
  const options = { request, now: () => clock };
  expect(await getIishkoSessionToken("dev-refresh-1", options)).toBe("session-1");
  clock += 100_000;
  expect(await getIishkoSessionToken("dev-refresh-1", options)).toBe("session-1");
  clock += 250_000;
  expect(await getIishkoSessionToken("dev-refresh-1", options)).toBe("session-2");
  const [a, b] = await Promise.all([
    getIishkoSessionToken("dev-refresh-1", { ...options, forceRefresh: true }),
    getIishkoSessionToken("dev-refresh-1", { ...options, forceRefresh: true }),
  ]);
  expect(a).toBe(b);
  expect(exchanges).toBe(3);
});

it("renders whatever profile fields exist and keeps a short server cache", async () => {
  let profileCalls = 0;
  const minimal = {
    user: { username: "iishko_user" },
    rank: { tier: "novice", title: "Новичок" },
    models: {
      available: [{ id: "deepseek-v4-flash" }],
      locked: [{ id: "claude-opus-5-5", min_tier: "pro" }],
    },
  };
  const { account } = harness(
    pairingRoute(
      "dev-profile-1",
      () => approved("dev-profile-1"),
      (input) => {
        if (String(input.url) !== `${BASE}/profile`) return undefined;
        profileCalls += 1;
        expect(new Headers(input.headers).get("authorization")).toBe("Bearer dev-profile-1");
        expect(new Headers(input.headers).get("x-iishko-device")).toBe("dev-profile-1");
        return json(200, minimal);
      },
    ),
  );
  await expect(account.profile()).rejects.toBeDefined();
  const started = await startPairing(account);
  await account.pollTelegramPairing({ pairingId: started.pairingId });
  const profile = await account.profile();
  expect(profile).toMatchObject({
    user: { username: "iishko_user" },
    rank: { tier: "novice", title: "Новичок" },
    models: {
      available: [{ id: "deepseek-v4-flash" }],
      locked: [{ id: "claude-opus-5-5", minTier: "pro" }],
    },
  });
  expect(profile.limits).toBeUndefined();
  expect(profile.balance).toBeUndefined();
  await account.profile();
  expect(profileCalls).toBe(1);
});

it("maps the full profile fixture to camelCase and drops junk values", async () => {
  const full = {
    user: {
      username: "iishko_user",
      first_name: "Никита",
      joined_at: 1_700_000_000,
      days_in_project: 12,
    },
    rank: { tier: 4, title: "Легенда", emoji: "💎" },
    limits: { requests_today: 13, requests_limit: 30000, daily_usd_cap: 5, daily_usd_used: 1.2 },
    balance: { usd: 3020, weekly_credit_usd: 10 },
    spend: {
      today_usd: 1.2,
      today_requests: 13,
      week_usd: 8.5,
      month_requests: 240,
      total_usd: 42.75,
      top_models: [
        { id: "deepseek-v4-flash", title: "DeepSeek V4 Flash", requests: 90, usd: 12.5 },
        { id: "", requests: 5 },
        { id: "junk-no-requests" },
        { id: "kimi-k3", requests: -3 },
        "not-an-object",
      ],
    },
    models: {
      available: [
        {
          id: "deepseek-v4-flash",
          title: "DeepSeek V4 Flash",
          status: "up",
          unstable: false,
          ms: 412,
          checked_at: 1_700_000_100,
          reason: "",
        },
        { id: "glm-5.3", status: "busy", unstable: true, ms: "junk", checked_at: -4 },
      ],
      locked: [{ id: "claude-opus-5-5", min_tier: 5, status: "down", reason: "x".repeat(300) }],
    },
  };
  const { account } = harness(
    pairingRoute(
      "dev-full-1",
      () => approved("dev-full-1"),
      (input) => (String(input.url) === `${BASE}/profile` ? json(200, full) : undefined),
    ),
  );
  const started = await startPairing(account);
  await account.pollTelegramPairing({ pairingId: started.pairingId });
  const profile = await account.profile();
  expect(profile.user).toMatchObject({ joinedAt: 1_700_000_000, daysInProject: 12 });
  expect(profile.models.available[0]).toMatchObject({
    id: "deepseek-v4-flash",
    status: "up",
    unstable: false,
    latencyMs: 412,
    checkedAt: 1_700_000_100,
  });
  expect(profile.models.available[0]?.reason).toBeUndefined();
  expect(profile.models.available[1]).toMatchObject({
    id: "glm-5.3",
    status: "busy",
    unstable: true,
  });
  expect(profile.models.available[1]?.latencyMs).toBeUndefined();
  expect(profile.models.available[1]?.checkedAt).toBeUndefined();
  expect(profile.models.locked[0]).toMatchObject({
    id: "claude-opus-5-5",
    minTier: "5",
    status: "down",
    reason: "x".repeat(160),
  });
  expect(profile.spend).toMatchObject({
    todayUsd: 1.2,
    todayRequests: 13,
    weekUsd: 8.5,
    monthRequests: 240,
    totalUsd: 42.75,
  });
  expect(profile.spend?.weekRequests).toBeUndefined();
  expect(profile.spend?.topModels).toEqual([
    { id: "deepseek-v4-flash", title: "DeepSeek V4 Flash", requests: 90, usd: 12.5 },
  ]);
});

it("loads models through the IDE proxy for device sessions and manual keys", async () => {
  const { account, request } = harness(pairingRoute("dev-base-1", () => approved("dev-base-1")));
  const started = await startPairing(account);
  await account.pollTelegramPairing({ pairingId: started.pairingId });
  const urls = request.mock.calls.map(([input]) => String(input.url));
  expect(urls).toContain("https://api.reformboss.com/webapp/api/ide/v1/models");
  expect(urls).not.toContain("https://api.reformboss.com/v1/models");

  // A pasted key now goes through key-login and gets a device session too, so
  // its models are validated through the same IDE proxy — never the public API.
  const manual = harness((input) => {
    const url = String(input.url);
    if (url === `${BASE}/key-login`) {
      return json(200, {
        status: "approved",
        device_token: "idd_manual_test",
        account: { username: "manual-user" },
      });
    }
    if (url === `${BASE}/token`) {
      return new Headers(input.headers).get("authorization") === "Bearer idd_manual_test"
        ? json(200, {
            token: "ids_manual_test",
            expires_at: Math.floor(Date.now() / 1000) + 3600,
            refresh_in: 600,
          })
        : json(401, {});
    }
    return undefined;
  });
  await manual.account.connectApiKey({ apiKey: "sk-manual-1234" });
  const manualUrls = manual.request.mock.calls.map(([input]) => String(input.url));
  expect(manualUrls).toContain("https://api.reformboss.com/webapp/api/ide/v1/models");
  expect(manualUrls).not.toContain("https://api.reformboss.com/v1/models");
});

it("prefers the https base_url returned by /token over the proxy default", async () => {
  const { account, request } = harness(
    pairingRoute(
      "dev-base-2",
      () => approved("dev-base-2"),
      (input) =>
        String(input.url) === `${BASE}/token`
          ? json(200, {
              token: "session-dev-base-2",
              expires_at: Math.floor(Date.now() / 1000) + 900,
              refresh_in: 600,
              base_url: "https://gateway.example.test/ide/v1",
            })
          : undefined,
    ),
  );
  const started = await startPairing(account);
  await account.pollTelegramPairing({ pairingId: started.pairingId });
  expect(request.mock.calls.map(([input]) => String(input.url))).toContain(
    "https://gateway.example.test/ide/v1/models",
  );
});

it("selects the preferred default model on sign-in, not the first listed one", async () => {
  const { account, settings } = harness(
    pairingRoute("dev-default-1", () => approved("dev-default-1")),
  );
  const started = await startPairing(account);
  await account.pollTelegramPairing({ pairingId: started.pairingId });
  expect(settings().newThreadDefaults.modelSelectionByProvider.pi?.model).toBe(
    "iishko/deepseek-v4-flash",
  );
});
