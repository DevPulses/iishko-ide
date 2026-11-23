// FILE: iishkoAccount.test.ts
// Purpose: Verifies IISHKO key storage, Telegram pairing and sign-out against stubbed services.
// Layer: Server unit tests

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  DEFAULT_SERVER_SETTINGS,
  IISHKO_ACCOUNT_ERROR_CODES,
  type ServerSettings,
  type ServerSettingsPatch,
} from "@iishko/contracts";
import type { OutboundHttpRequest, OutboundHttpResponse } from "@iishko/shared/outboundHttp";
import { applyServerSettingsPatch } from "@iishko/shared/serverSettings";
import { afterEach, expect, it, vi } from "vitest";

import { makeIishkoAccount } from "./iishkoAccount.ts";

const MODELS = {
  data: [
    { id: "deepseek-v4-flash", supported_endpoint_types: ["openai"] },
    { id: "claude-opus-5-5", supported_endpoint_types: ["openai"] },
  ],
};

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

function harness(
  route: (input: OutboundHttpRequest) => OutboundHttpResponse,
  initial?: ServerSettings,
) {
  const stateDir = mkdtempSync(path.join(tmpdir(), "iishko-account-"));
  dirs.push(stateDir);
  let settings: ServerSettings = initial ?? DEFAULT_SERVER_SETTINGS;
  const request = vi.fn(async (input: OutboundHttpRequest) => route(input));
  const refreshProviders = vi.fn(async () => undefined);
  const account = makeIishkoAccount({
    stateDir,
    readSettings: async () => settings,
    updateSettings: async (derive: (current: ServerSettings) => ServerSettingsPatch) => {
      settings = applyServerSettingsPatch(settings, derive(settings));
    },
    refreshProviders,
    env: {},
    request,
  });
  return { account, request, refreshProviders, stateDir, settings: () => settings };
}

function storedKey(settings: ServerSettings) {
  return settings.providerInstances.pi?.environment?.find(
    (entry) => entry.name === "REFORMBOSS_API_KEY",
  );
}

function storedEnv(settings: ServerSettings, name: string) {
  return settings.providerInstances.pi?.environment?.find((entry) => entry.name === name);
}

const ACCOUNT_BASE = "https://api.reformboss.com/webapp/api/ide";
const KEY_LOGIN_URL = `${ACCOUNT_BASE}/key-login`;
const SESSION_MODELS_URL = `${ACCOUNT_BASE}/v1/models`;
const DIRECT_MODELS_URL = "https://api.reformboss.com/v1/models";

const SESSION_BODY = {
  token: "ids_test_session",
  expires_at: Math.floor(Date.now() / 1000) + 3600,
  refresh_in: 600,
};

const KEY_LOGIN_OK = {
  status: "approved",
  device_token: "idd_keylogin_test",
  account: { username: "key-user", first_name: "Key User" },
};

/** key-login → device session → proxy /models; everything else 404. */
const keyLoginRoute =
  (keyLogin: OutboundHttpResponse = json(200, KEY_LOGIN_OK)) =>
  (input: OutboundHttpRequest): OutboundHttpResponse => {
    if (input.url === KEY_LOGIN_URL) return keyLogin;
    if (input.url === `${ACCOUNT_BASE}/token`) return json(200, SESSION_BODY);
    if (input.url === SESSION_MODELS_URL) return json(200, MODELS);
    return json(404, {});
  };

const seededRawKey: ServerSettings = {
  ...DEFAULT_SERVER_SETTINGS,
  providerInstances: {
    ...DEFAULT_SERVER_SETTINGS.providerInstances,
    pi: {
      driver: "pi",
      environment: [{ name: "REFORMBOSS_API_KEY", value: "sk-legacy-1", sensitive: true }],
    },
  },
};

it("validates a pasted key, stores it as a secret and reports only a hint", async () => {
  const { account, request, refreshProviders, stateDir, settings } = harness((input) => {
    if (input.url === KEY_LOGIN_URL) return json(404, {});
    return new Headers(input.headers).get("authorization") === "Bearer sk-test-1234"
      ? json(200, MODELS)
      : json(401, {});
  });
  expect(await account.status()).toEqual({ state: "disconnected" });

  await expect(account.connectApiKey({ apiKey: "sk-wrong-0000" })).rejects.toMatchObject({
    code: IISHKO_ACCOUNT_ERROR_CODES.invalidKey,
  });
  expect(storedKey(settings())).toBeUndefined();

  const status = await account.connectApiKey({ apiKey: " sk-test-1234 " });
  expect(status).toMatchObject({ state: "connected", source: "manual", keyHint: "…1234" });
  expect(JSON.stringify(status)).not.toContain("sk-test-1234");
  expect(storedKey(settings())).toMatchObject({ value: "sk-test-1234", sensitive: true });
  // The 404 fallback is the only path that keeps a raw key, marked for the direct gateway.
  expect(storedEnv(settings(), "REFORMBOSS_DIRECT_API_KEY")).toMatchObject({ value: "1" });
  expect(settings().newThreadDefaults.modelSelectionByProvider.pi).toMatchObject({
    provider: "pi",
    model: "iishko/deepseek-v4-flash",
  });
  expect(readFileSync(path.join(stateDir, "iishko", "account.json"), "utf8")).not.toContain(
    "sk-test-1234",
  );
  expect(refreshProviders).toHaveBeenCalledTimes(1);
  expect(String(request.mock.calls.at(-1)![0].url)).toBe(DIRECT_MODELS_URL);

  await account.signOut();
  expect(storedKey(settings())).toBeUndefined();
  expect(await account.status()).toEqual({ state: "disconnected" });
});

it("exchanges a pasted key for a device session and never stores the raw key", async () => {
  const { account, request, stateDir, settings } = harness(keyLoginRoute());
  const status = await account.connectApiKey({ apiKey: " sk-live-9999 " });
  expect(status).toMatchObject({
    state: "connected",
    source: "manual",
    account: { username: "key-user", displayName: "Key User" },
  });
  expect(JSON.stringify(status)).not.toContain("sk-live-9999");
  expect(storedKey(settings())).toBeUndefined();
  expect(storedEnv(settings(), "REFORMBOSS_DIRECT_API_KEY")).toBeUndefined();
  const device = JSON.parse(readFileSync(path.join(stateDir, "iishko", "device.json"), "utf8")) as {
    deviceToken?: string;
  };
  expect(device.deviceToken).toBe("idd_keylogin_test");
  const accountJson = readFileSync(path.join(stateDir, "iishko", "account.json"), "utf8");
  expect(accountJson).not.toContain("sk-live-9999");
  expect(accountJson).not.toContain("idd_keylogin_test");
  // Models were validated through the IDE session proxy, not the direct API.
  expect(String(request.mock.calls.at(-1)![0].url)).toBe(SESSION_MODELS_URL);
  const lastHeaders = new Headers(request.mock.calls.at(-1)![0].headers);
  expect(lastHeaders.get("authorization")).toBe("Bearer ids_test_session");
  expect(await account.status()).toMatchObject({ state: "connected", source: "manual" });
});

it("rejects an unknown key with the invalid-key error and stores nothing", async () => {
  const { account, settings } = harness((input) =>
    input.url === KEY_LOGIN_URL ? json(401, { error: "invalid_key" }) : json(404, {}),
  );
  await expect(account.connectApiKey({ apiKey: "sk-nope" })).rejects.toMatchObject({
    code: IISHKO_ACCOUNT_ERROR_CODES.invalidKey,
    message: "Ключ не найден. Проверьте ключ или войдите через Telegram.",
  });
  expect(storedKey(settings())).toBeUndefined();
});

it("maps key-login rate limits and outages to the network error", async () => {
  const limited = harness((input) =>
    input.url === KEY_LOGIN_URL ? json(429, { retry_after: 17 }) : json(404, {}),
  );
  await expect(limited.account.connectApiKey({ apiKey: "sk-x" })).rejects.toMatchObject({
    code: IISHKO_ACCOUNT_ERROR_CODES.network,
    message: "Слишком много попыток, повторите через 17 с",
  });
  const down = harness((input) =>
    input.url === KEY_LOGIN_URL ? json(503, { error: "unavailable" }) : json(404, {}),
  );
  await expect(down.account.connectApiKey({ apiKey: "sk-x" })).rejects.toMatchObject({
    code: IISHKO_ACCOUNT_ERROR_CODES.network,
    message: "Сервер входа недоступен. Повторите позже.",
  });
});

it("migrates a stored raw key to a device session on status refresh", async () => {
  const { account, stateDir, settings } = harness(keyLoginRoute(), seededRawKey);
  const status = await account.status();
  expect(status).toMatchObject({ state: "connected", source: "manual" });
  expect(storedKey(settings())).toBeUndefined();
  expect(storedEnv(settings(), "REFORMBOSS_DIRECT_API_KEY")).toBeUndefined();
  const device = JSON.parse(readFileSync(path.join(stateDir, "iishko", "device.json"), "utf8")) as {
    deviceToken?: string;
  };
  expect(device.deviceToken).toBe("idd_keylogin_test");
});

it("drops a stored raw key the key-login service rejects", async () => {
  const { account, settings } = harness(
    (input) => (input.url === KEY_LOGIN_URL ? json(401, { error: "invalid_key" }) : json(404, {})),
    seededRawKey,
  );
  expect(await account.status()).toEqual({ state: "disconnected" });
  expect(storedKey(settings())).toBeUndefined();
});

it("keeps a stored raw key with bounded retries while the sign-in service is down", async () => {
  let keyLoginCalls = 0;
  const { account, settings } = harness((input) => {
    if (input.url === KEY_LOGIN_URL) {
      keyLoginCalls += 1;
      return json(503, { error: "unavailable" });
    }
    return json(404, {});
  }, seededRawKey);
  const status = await account.status();
  expect(status).toMatchObject({ state: "connected", source: "manual" });
  expect(storedKey(settings())).toMatchObject({ value: "sk-legacy-1" });
  // No direct-API marker: generation must not route to the direct gateway meanwhile.
  expect(storedEnv(settings(), "REFORMBOSS_DIRECT_API_KEY")).toBeUndefined();
  const callsAfterFirst = keyLoginCalls;
  expect(callsAfterFirst).toBeGreaterThan(0);
  await account.status();
  expect(keyLoginCalls).toBe(callsAfterFirst);
});

it("keeps the direct-key path for account servers without key-login", async () => {
  const { account, settings } = harness(
    (input) =>
      input.url === KEY_LOGIN_URL
        ? json(404, {})
        : new Headers(input.headers).get("authorization") === "Bearer sk-legacy-1"
          ? json(200, MODELS)
          : json(401, {}),
    seededRawKey,
  );
  const status = await account.status();
  expect(status).toMatchObject({ state: "connected", source: "manual" });
  expect(storedKey(settings())).toMatchObject({ value: "sk-legacy-1" });
  expect(storedEnv(settings(), "REFORMBOSS_DIRECT_API_KEY")).toMatchObject({ value: "1" });
});

it("reports Telegram sign-in as unavailable until the gateway serves pairing", async () => {
  const { account } = harness(() => json(404, {}));
  expect(await account.beginTelegramPairing()).toMatchObject({ state: "unavailable" });
});
