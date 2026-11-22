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

function harness(route: (input: OutboundHttpRequest) => OutboundHttpResponse) {
  const stateDir = mkdtempSync(path.join(tmpdir(), "iishko-account-"));
  dirs.push(stateDir);
  let settings: ServerSettings = DEFAULT_SERVER_SETTINGS;
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

it("validates a pasted key, stores it as a secret and reports only a hint", async () => {
  const { account, request, refreshProviders, stateDir, settings } = harness((input) =>
    new Headers(input.headers).get("authorization") === "Bearer sk-test-1234"
      ? json(200, MODELS)
      : json(401, {}),
  );
  expect(await account.status()).toEqual({ state: "disconnected" });

  await expect(account.connectApiKey({ apiKey: "sk-wrong-0000" })).rejects.toMatchObject({
    code: IISHKO_ACCOUNT_ERROR_CODES.invalidKey,
  });
  expect(storedKey(settings())).toBeUndefined();

  const status = await account.connectApiKey({ apiKey: " sk-test-1234 " });
  expect(status).toMatchObject({ state: "connected", source: "manual", keyHint: "…1234" });
  expect(JSON.stringify(status)).not.toContain("sk-test-1234");
  expect(storedKey(settings())).toMatchObject({ value: "sk-test-1234", sensitive: true });
  expect(settings().newThreadDefaults.modelSelectionByProvider.pi).toMatchObject({
    provider: "pi",
    model: "iishko/claude-opus-5-5",
  });
  expect(readFileSync(path.join(stateDir, "iishko", "account.json"), "utf8")).not.toContain(
    "sk-test-1234",
  );
  expect(refreshProviders).toHaveBeenCalledTimes(1);
  expect(String(request.mock.calls.at(-1)![0].url)).toBe("https://api.reformboss.com/v1/models");

  await account.signOut();
  expect(storedKey(settings())).toBeUndefined();
  expect(await account.status()).toEqual({ state: "disconnected" });
});

it("reports Telegram sign-in as unavailable until the gateway serves pairing", async () => {
  const { account } = harness(() => json(404, {}));
  expect(await account.beginTelegramPairing()).toMatchObject({ state: "unavailable" });
});
