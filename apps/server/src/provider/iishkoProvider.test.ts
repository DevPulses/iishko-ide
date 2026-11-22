// FILE: iishkoProvider.test.ts
// Purpose: Verifies IISHKO gateway model discovery and its Pi provider registration offline.
// Layer: Provider unit tests

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { OutboundHttpRequest, OutboundHttpResponse } from "@iishko/shared/outboundHttp";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  IISHKO_DEFAULT_BASE_URL,
  IishkoAuthError,
  fetchIishkoModels,
  loadIishkoModels,
  mapIishkoGatewayError,
  pickIishkoFallbackModelId,
  parseIishkoModels,
  refreshPiIishkoModels,
  resolveIishkoBaseUrl,
} from "./iishkoProvider.ts";
import { findModelInRegistry } from "./Layers/PiAdapter.ts";
import { importTestPiPackage } from "./testing/piSdkFixture.ts";

const GATEWAY_MODELS = {
  object: "list",
  data: [
    { id: "zeta-chat", object: "model", owned_by: "openai", supported_endpoint_types: ["openai"] },
    { id: "deepseek-v4-flash", object: "model", supported_endpoint_types: ["openai"] },
    { id: "claude-opus-5-5", object: "model", supported_endpoint_types: ["openai"] },
    { id: "liquid/lfm-3-1.7b:free", object: "model", supported_endpoint_types: ["openai"] },
    { id: "auto", object: "model", supported_endpoint_types: ["openai"] },
    { id: "wan26-i2v", object: "model", supported_endpoint_types: ["openai"] },
    { id: "naga-tts", object: "model", supported_endpoint_types: ["openai"] },
    { id: "anthropic-only", object: "model", supported_endpoint_types: ["anthropic"] },
    { id: " padded", object: "model" },
    { object: "model" },
  ],
};

function response(status: number, body: unknown): OutboundHttpResponse {
  return {
    status,
    url: `${IISHKO_DEFAULT_BASE_URL}/models`,
    headers: new Headers({ "content-type": "application/json" }),
    body: Buffer.from(JSON.stringify(body)),
  };
}

const dirs: string[] = [];
function directory(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "iishko-provider-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("parseIishkoModels", () => {
  it("keeps agent-capable chat models in preference order", () => {
    const models = parseIishkoModels(GATEWAY_MODELS);
    expect(models.map((model) => model.id)).toEqual([
      "claude-opus-5-5",
      "deepseek-v4-flash",
      "liquid/lfm-3-1.7b:free",
      "zeta-chat",
    ]);
    expect(models[0]).toMatchObject({
      provider: "iishko",
      api: "openai-completions",
      baseUrl: IISHKO_DEFAULT_BASE_URL,
      reasoning: false,
      input: ["text", "image"],
      contextWindow: 200_000,
      maxTokens: 32_768,
      headers: { "X-IISHKO-Client": "iishko-ide/1.0.0" },
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      compat: { supportsDeveloperRole: false, maxTokensField: "max_tokens" },
    });
    expect(models[1]).toMatchObject({ input: ["text"], contextWindow: 128_000 });
  });

  it("rejects a payload without a model list", () => {
    expect(() => parseIishkoModels({ error: "unauthorized" })).toThrow("Invalid IISHKO model list");
  });
});

describe("fetchIishkoModels", () => {
  it("sends the key only to the gateway origin and maps a rejected key", async () => {
    const request = vi.fn(async (_input: OutboundHttpRequest) => response(200, GATEWAY_MODELS));
    const models = await fetchIishkoModels("test-key", { request });
    expect(models).toHaveLength(4);
    const input = request.mock.calls[0]![0];
    expect(String(input.url)).toBe("https://api.reformboss.com/v1/models");
    expect(new Headers(input.headers).get("authorization")).toBe("Bearer test-key");
    expect(input.policy).toMatchObject({
      service: "iishko-models",
      allowedOrigins: ["https://api.reformboss.com"],
      maxRedirects: 0,
      requirePublicAddress: true,
    });

    request.mockResolvedValueOnce(response(401, { error: { message: "disabled" } }));
    await expect(fetchIishkoModels("test-key", { request })).rejects.toBeInstanceOf(
      IishkoAuthError,
    );
  });

  it("serves the cached list when the gateway fails, never an empty one, and rejects a rejected key", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "iishko-models-cache-"));
    try {
      const cachePath = path.join(dir, "models-cache.json");
      const request = vi.fn(async (_input: OutboundHttpRequest) => response(200, GATEWAY_MODELS));
      const key = `cache-${Math.random()}`;
      const options = { request, cachePath, retryDelaysMs: [] as number[] };
      expect(await loadIishkoModels(key, options)).toHaveLength(4);
      expect(readFileSync(cachePath, "utf8")).toContain("claude-opus-5-5");
      request.mockRejectedValueOnce(new Error("offline"));
      expect(await loadIishkoModels(key, { ...options, forceRefresh: true })).toHaveLength(4);
      request.mockResolvedValueOnce(response(503, {}));
      expect(await loadIishkoModels(key, { ...options, forceRefresh: true })).toHaveLength(4);
      request.mockResolvedValueOnce(response(403, {}));
      await expect(
        loadIishkoModels(key, { ...options, forceRefresh: true }),
      ).rejects.toBeInstanceOf(IishkoAuthError);
      // With no cache for this account the failure is reported, not hidden.
      const fresh = `fresh-${Math.random()}`;
      request.mockRejectedValueOnce(new Error("offline"));
      await expect(loadIishkoModels(fresh, { ...options, forceRefresh: true })).rejects.toThrow(
        "offline",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("shares one request between concurrent refreshes", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "iishko-models-flight-"));
    try {
      const request = vi.fn(async (_input: OutboundHttpRequest) => response(200, GATEWAY_MODELS));
      const key = `flight-${Math.random()}`;
      const options = {
        request,
        cachePath: path.join(dir, "models-cache.json"),
        forceRefresh: true,
      };
      await Promise.all([loadIishkoModels(key, options), loadIishkoModels(key, options)]);
      expect(request).toHaveBeenCalledTimes(1);
      expect(new Headers(request.mock.calls[0]![0].headers).get("x-iishko-client")).toBe(
        "iishko-ide/1.0.0",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("accepts only a plain https base URL override", () => {
    expect(resolveIishkoBaseUrl({})).toBe(IISHKO_DEFAULT_BASE_URL);
    expect(
      resolveIishkoBaseUrl({ REFORMBOSS_API_BASE_URL: "https://staging.example.com/v1/" }),
    ).toBe("https://staging.example.com/v1");
    for (const override of ["http://example.com/v1", "https://user:pw@example.com/v1", "nope"]) {
      expect(resolveIishkoBaseUrl({ REFORMBOSS_API_BASE_URL: override })).toBe(
        IISHKO_DEFAULT_BASE_URL,
      );
    }
  });
});

describe("refreshPiIishkoModels", () => {
  async function runtime() {
    const dir = directory();
    return ModelRuntime.create({
      authPath: path.join(dir, "auth.json"),
      modelsPath: path.join(dir, "models.json"),
      refreshOnCreate: false,
    });
  }

  it("registers the gateway models with the instance key and resolves slugs with slashes", async () => {
    const request = vi.fn(async (_input: OutboundHttpRequest) => response(200, GATEWAY_MODELS));
    const modelRuntime = await runtime();
    await refreshPiIishkoModels(modelRuntime, importTestPiPackage, {
      environment: { REFORMBOSS_API_KEY: `register-${Math.random()}` },
      request,
    });
    expect(request).toHaveBeenCalledTimes(1);
    expect(modelRuntime.hasConfiguredAuth("iishko")).toBe(true);
    const registry = new ModelRegistry(modelRuntime);
    expect(registry.getProviderDisplayName("iishko")).toBe("ИИШКО");
    expect(findModelInRegistry(registry, "iishko/liquid/lfm-3-1.7b:free")).toMatchObject({
      provider: "iishko",
      id: "liquid/lfm-3-1.7b:free",
      baseUrl: IISHKO_DEFAULT_BASE_URL,
    });
    expect(findModelInRegistry(registry, "iishko/claude-opus-5-5")?.id).toBe("claude-opus-5-5");
  });

  it("does nothing without a key, offline, or when the key is rejected", async () => {
    const request = vi.fn(async (_input: OutboundHttpRequest) => response(401, {}));
    const modelRuntime = await runtime();
    await refreshPiIishkoModels(modelRuntime, importTestPiPackage, { environment: {}, request });
    await refreshPiIishkoModels(modelRuntime, importTestPiPackage, {
      environment: { REFORMBOSS_API_KEY: "offline-key", PI_OFFLINE: "1" },
      request,
    });
    expect(request).not.toHaveBeenCalled();
    await refreshPiIishkoModels(modelRuntime, importTestPiPackage, {
      environment: { REFORMBOSS_API_KEY: `rejected-${Math.random()}` },
      request,
    });
    expect(request).toHaveBeenCalledTimes(1);
    expect(modelRuntime.getModels("iishko")).toEqual([]);
  });
});

describe("mapIishkoGatewayError", () => {
  it.each([
    ["401 Unauthorized", "Ключ ИИШКО недействителен — войдите заново"],
    ["402 Payment Required", "Лимит на сегодня исчерпан"],
    [
      '403 {"error":{"code":"ide_only","message":"x"}}',
      "Для рангов Новичок и Актив модели доступны только при входе через Telegram в ИИШКО IDE",
    ],
    ["429 Too Many Requests retry-after: 7", "Слишком много запросов, повтор через 7 с"],
    [
      '503 {"error":{"type":"upstream_pool_empty"}}',
      "Модель временно недоступна — повторите или выберите другую",
    ],
    [
      '{"error":{"code":"gateway_restarting"}}',
      "Модель временно недоступна — повторите или выберите другую",
    ],
    [
      '503 {"error":{"type":"model_failing_cooldown"}}',
      "Модель временно недоступна — повторите или выберите другую",
    ],
    [
      '403 {"error":{"code":"ide_no_key"}}',
      "Завершите регистрацию в боте @iishkogatewaybot (/start)",
    ],
    ['503 {"error":{"code":"ide_session_unavailable"}}', "Проверка сессии временно недоступна"],
    ['401 {"error":{"code":"ide_session_invalid"}}', "Ключ ИИШКО недействителен — войдите заново"],
  ])("maps %s", (raw, expected) => {
    expect(mapIishkoGatewayError(raw)).toBe(expected);
  });

  it("keeps unknown messages raw", () => {
    expect(mapIishkoGatewayError("502 upstream_error: boom")).toBeNull();
    expect(mapIishkoGatewayError("")).toBeNull();
    expect(
      mapIishkoGatewayError('403 {"error":{"code":"ide_account_blocked","message":"x"}}'),
    ).toBeNull();
  });
});

describe("pickIishkoFallbackModelId", () => {
  it("prefers the first preferred available model", () => {
    expect(pickIishkoFallbackModelId(["zeta-chat", "kimi-k3", "claude-sonnet-5"])).toBe(
      "claude-sonnet-5",
    );
    expect(pickIishkoFallbackModelId([])).toBeUndefined();
  });
});
