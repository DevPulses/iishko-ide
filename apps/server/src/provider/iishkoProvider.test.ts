// FILE: iishkoProvider.test.ts
// Purpose: Verifies IISHKO gateway model discovery and its Pi provider registration offline.
// Layer: Provider unit tests

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  createAssistantMessageEventStream,
  isContextOverflow,
  type AssistantMessage,
  type AssistantMessageEvent,
} from "@earendil-works/pi-ai";
import { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { OutboundHttpRequest, OutboundHttpResponse } from "@iishko/shared/outboundHttp";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  IISHKO_DEFAULT_BASE_URL,
  IishkoAuthError,
  fetchIishkoModels,
  isIishkoContextOverflowError,
  loadIishkoModels,
  mapIishkoGatewayError,
  parseIishkoModels,
  pickIishkoDefaultModelId,
  refreshPiIishkoModels,
  resolveIishkoBaseUrl,
  wrapIishkoProviderStreams,
} from "./iishkoProvider.ts";
import { findModelInRegistry } from "./Layers/PiAdapter.ts";
import { setIishkoDeviceTokenPath } from "../iishkoSession.ts";
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
      contextWindow: 400_000,
      maxTokens: 32_768,
      headers: { "X-IISHKO-Client": "iishko-ide/1.0.0" },
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      compat: { supportsDeveloperRole: false, maxTokensField: "max_tokens" },
    });
    expect(models[1]).toMatchObject({ input: ["text"], contextWindow: 400_000 });
  });

  it("clamps context_length to the 400k ceiling and drops windows below 32k", () => {
    const models = parseIishkoModels({
      data: [
        { id: "huge", context_length: 1_000_000, supported_endpoint_types: ["openai"] },
        { id: "reported", context_length: 115_228, supported_endpoint_types: ["openai"] },
        { id: "tiny", context_length: 22_000, supported_endpoint_types: ["openai"] },
        { id: "floor", context_length: 32_000, supported_endpoint_types: ["openai"] },
        { id: "junk-length", context_length: "wide", supported_endpoint_types: ["openai"] },
      ],
    });
    expect(models.map((model) => model.id)).toEqual(["floor", "huge", "junk-length", "reported"]);
    expect(models.find((model) => model.id === "huge")?.contextWindow).toBe(400_000);
    expect(models.find((model) => model.id === "reported")?.contextWindow).toBe(115_228);
    expect(models.find((model) => model.id === "floor")?.contextWindow).toBe(32_000);
    expect(models.find((model) => model.id === "junk-length")?.contextWindow).toBe(400_000);
  });

  it("uses the catalogue display name and keeps the rank catalogue shape", () => {
    const models = parseIishkoModels({
      object: "list",
      data: [
        {
          id: "deepseek-v4.1-flash",
          object: "model",
          created: 0,
          owned_by: "iishko",
          name: "DeepSeek V4.1 Flash",
          context_length: 115_228,
        },
        { id: "plain-model", object: "model", owned_by: "iishko", name: "   " },
        { id: "no-name", object: "model", owned_by: "iishko" },
      ],
    });
    expect(models.map((model) => model.id)).toEqual([
      "deepseek-v4.1-flash",
      "no-name",
      "plain-model",
    ]);
    expect(models.find((model) => model.id === "deepseek-v4.1-flash")?.name).toBe(
      "DeepSeek V4.1 Flash",
    );
    expect(models.find((model) => model.id === "plain-model")?.name).toBe("plain-model");
    expect(models.find((model) => model.id === "no-name")?.name).toBe("no-name");
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

  // Isolate the device-token store so a real sign-in on this machine cannot leak in.
  const tokenDirs: string[] = [];
  beforeEach(() => {
    const dir = mkdtempSync(path.join(tmpdir(), "iishko-provider-token-"));
    tokenDirs.push(dir);
    setIishkoDeviceTokenPath(path.join(dir, "device.json"));
  });
  afterEach(() => {
    setIishkoDeviceTokenPath(undefined);
    for (const dir of tokenDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("registers the gateway models with the instance key and resolves slugs with slashes", async () => {
    const request = vi.fn(async (_input: OutboundHttpRequest) => response(200, GATEWAY_MODELS));
    const modelRuntime = await runtime();
    await refreshPiIishkoModels(modelRuntime, importTestPiPackage, {
      // The direct-API marker is what the 404 key-login fallback stores with a raw key.
      environment: {
        REFORMBOSS_API_KEY: `register-${Math.random()}`,
        REFORMBOSS_DIRECT_API_KEY: "1",
      },
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
      environment: {
        REFORMBOSS_API_KEY: `rejected-${Math.random()}`,
        REFORMBOSS_DIRECT_API_KEY: "1",
      },
      request,
    });
    expect(request).toHaveBeenCalledTimes(1);
    expect(modelRuntime.getModels("iishko")).toEqual([]);
  });

  it("never routes a raw key to the direct API without the marker or a base-URL override", async () => {
    const request = vi.fn(async (_input: OutboundHttpRequest) => response(200, GATEWAY_MODELS));
    const modelRuntime = await runtime();
    await refreshPiIishkoModels(modelRuntime, importTestPiPackage, {
      environment: { REFORMBOSS_API_KEY: `raw-${Math.random()}` },
      request,
    });
    expect(request).not.toHaveBeenCalled();
    expect(modelRuntime.getModels("iishko")).toEqual([]);
    // The explicit development override is the only other way to reach a direct base.
    await refreshPiIishkoModels(modelRuntime, importTestPiPackage, {
      environment: {
        REFORMBOSS_API_KEY: `dev-${Math.random()}`,
        REFORMBOSS_API_BASE_URL: "https://staging.example.com/v1",
      },
      request,
    });
    expect(request).toHaveBeenCalledTimes(1);
    expect(String(request.mock.calls[0]![0].url)).toBe("https://staging.example.com/v1/models");
  });
});

describe("mapIishkoGatewayError", () => {
  it.each([
    ["401 Unauthorized", "Ключ ИИШКО недействителен — войдите заново"],
    ["402 Payment Required", "Лимит на сегодня исчерпан"],
    [
      '403 {"error":{"code":"ide_only","message":"x"}}',
      "Для вашего ранга модели ИИШКО работают только после входа через Telegram: Настройки → Аккаунт ИИШКО → «Войти через Telegram».",
    ],
    [
      '403: {"message":"Для рангов «Новичок» и «Актив» прямой API временно закрыт, используйте ИИШКО IDE"}',
      "Для рангов «Новичок» и «Актив» прямой API временно закрыт, используйте ИИШКО IDE",
    ],
    ['400: {"error":{"message":"Bad things","type":"x"}}', "Bad things"],
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

  it("shows the gateway message for blocked accounts and keeps unknown non-JSON text raw", () => {
    expect(mapIishkoGatewayError("502 upstream_error: boom")).toBeNull();
    expect(mapIishkoGatewayError("")).toBeNull();
    expect(
      mapIishkoGatewayError('403 {"error":{"code":"ide_account_blocked","message":"x"}}'),
    ).toBe("x");
  });
});

describe("pickIishkoDefaultModelId", () => {
  it("prefers the first available model of the default order, else the first listed", () => {
    expect(pickIishkoDefaultModelId(["claude-opus-5-5", "glm-5.3", "kimi-k3"])).toBe("glm-5.3");
    expect(pickIishkoDefaultModelId(["claude-opus-5-5", "deepseek-v4-flash", "glm-5.3"])).toBe(
      "deepseek-v4-flash",
    );
    expect(pickIishkoDefaultModelId(["odd-model", "other"])).toBe("odd-model");
    // Vanished-selection fallback uses the same order: kimi beats unlisted claude-sonnet-5.
    expect(pickIishkoDefaultModelId(["zeta-chat", "kimi-k3", "claude-sonnet-5"])).toBe("kimi-k3");
    expect(pickIishkoDefaultModelId([])).toBeUndefined();
  });
});

describe("IISHKO context overflow", () => {
  const usage = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
  const errorMessage = (text: string): AssistantMessage =>
    ({
      role: "assistant",
      content: [],
      api: "openai-completions",
      provider: "iishko",
      model: "deepseek-v4-flash",
      usage,
      stopReason: "error",
      errorMessage: text,
      timestamp: Date.now(),
    }) as AssistantMessage;
  const makeInner = (text: string) => {
    const stream = createAssistantMessageEventStream();
    stream.push({ type: "error", reason: "error", error: errorMessage(text) });
    stream.end();
    return stream;
  };

  it("marks gateway ctxguard errors so pi-ai detects a context overflow", async () => {
    // A bare ctxguard body carries no pattern pi-ai recognizes.
    const ctxguard = '{"error":{"code":"ctxguard_115228","message":"too big"}}';
    expect(isContextOverflow(errorMessage(ctxguard))).toBe(false);
    expect(isIishkoContextOverflowError(ctxguard)).toBe(true);
    expect(isIishkoContextOverflowError('413 {"error":{"code":"ctxguard_1"}}')).toBe(true);
    expect(isIishkoContextOverflowError("429 rate limit exceeded")).toBe(false);
    expect(isIishkoContextOverflowError("connection reset")).toBe(false);

    const api = wrapIishkoProviderStreams(
      { stream: () => makeInner(ctxguard), streamSimple: () => makeInner(ctxguard) },
      createAssistantMessageEventStream,
    );
    const events: AssistantMessageEvent[] = [];
    for await (const event of api.streamSimple({} as never, {} as never)) {
      events.push(event);
    }
    const final = events.find((event) => event.type === "error");
    expect(final?.type === "error" && final.error.errorMessage).toContain(
      "context length exceeded",
    );
    if (final?.type === "error") {
      expect(isContextOverflow(final.error)).toBe(true);
    }
    const result = await api.streamSimple({} as never, {} as never).result();
    expect(isContextOverflow(result)).toBe(true);
  });
});
