// FILE: piCustomProviders.ts
// Purpose: Registers user-defined OpenAI-compatible endpoints as Pi native
//   providers and probes their /models listings for the settings dialog.
// Layer: Provider runtime support
//
// The endpoint spec is routing data only. The bearer key is resolved per
// request from the owning instance's environment (`apiKeyEnv`), never from
// the global process environment and never from another instance.

import type { Model } from "@earendil-works/pi-ai";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { ProviderCustomEndpointSpec, ProviderEndpointModelInfo } from "@iishko/contracts";
import { decodeOutboundJson, outboundHttp } from "@iishko/shared/outboundHttp";

import type { PiPackageImporter } from "./piSdkImports.ts";

export const CUSTOM_PROVIDER_DEFAULT_API_KEY_ENV = "IISHKO_CUSTOM_API_KEY";

const CUSTOM_PROVIDER_DEFAULT_CONTEXT_WINDOW = 128_000;
const CUSTOM_PROVIDER_MIN_CONTEXT_WINDOW = 32_000;
const CUSTOM_PROVIDER_MAX_CONTEXT_WINDOW = 400_000;
const CUSTOM_PROVIDER_DEFAULT_MAX_TOKENS = 8_192;
const ENDPOINT_MODELS_TIMEOUT_MS = 10_000;
const ENDPOINT_MODELS_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

function clampCustomContextWindow(value: number | undefined): number {
  const window = value ?? CUSTOM_PROVIDER_DEFAULT_CONTEXT_WINDOW;
  return Math.min(
    Math.max(window, CUSTOM_PROVIDER_MIN_CONTEXT_WINDOW),
    CUSTOM_PROVIDER_MAX_CONTEXT_WINDOW,
  );
}

export function piCustomProviderModels(
  spec: ProviderCustomEndpointSpec,
): Model<"openai-completions">[] {
  return spec.models.map((model) => ({
    id: model.id,
    name: model.name ?? model.id,
    provider: spec.id,
    api: "openai-completions",
    baseUrl: spec.baseUrl,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: clampCustomContextWindow(model.contextWindow),
    maxTokens: CUSTOM_PROVIDER_DEFAULT_MAX_TOKENS,
    compat: {
      supportsStore: false,
      supportsDeveloperRole: false,
      supportsReasoningEffort: false,
      maxTokensField: "max_tokens",
    },
  }));
}

/**
 * Registers every custom endpoint on the runtime. Auth resolves the key from
 * the captured instance environment at request time, so a rotated key is
 * picked up without recreating the runtime and one instance's key can never
 * leak into another instance's provider.
 */
export async function registerPiCustomProviders(
  runtime: ModelRuntime,
  importPackage: PiPackageImporter,
  options: {
    readonly providers: ReadonlyArray<ProviderCustomEndpointSpec>;
    readonly environment: Readonly<Record<string, string>>;
    readonly signal?: AbortSignal | undefined;
  },
): Promise<void> {
  const { providers, environment } = options;
  if (providers.length === 0 || options.signal?.aborted) {
    return;
  }
  const [{ createProvider }, { openAICompletionsApi }] = await Promise.all([
    importPackage<typeof import("@earendil-works/pi-ai")>("@earendil-works/pi-ai"),
    importPackage<typeof import("@earendil-works/pi-ai/api/openai-completions.lazy")>(
      "@earendil-works/pi-ai/api/openai-completions.lazy",
    ),
  ]);
  for (const spec of providers) {
    const apiKeyEnv = spec.apiKeyEnv?.trim() || CUSTOM_PROVIDER_DEFAULT_API_KEY_ENV;
    runtime.registerNativeProvider(
      createProvider({
        id: spec.id,
        name: spec.name,
        baseUrl: spec.baseUrl,
        auth: {
          apiKey: {
            name: `${spec.name} API key`,
            resolve: async () => {
              const key = environment[apiKeyEnv]?.trim();
              if (key) {
                return { auth: { apiKey: key }, source: apiKeyEnv };
              }
              // Keyless endpoints (local stubs) stay configured: the placeholder
              // satisfies the client factory while the explicit null header
              // keeps Authorization off the wire entirely.
              return {
                auth: { apiKey: "unused", headers: { authorization: null } },
                source: apiKeyEnv,
              };
            },
          },
        },
        models: piCustomProviderModels(spec),
        api: openAICompletionsApi(),
      }),
    );
  }
  await runtime.refresh({ allowNetwork: false });
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

/**
 * GET {baseUrl}/models through the guarded outbound client: public endpoints
 * must be HTTPS; loopback and private LAN ranges (local model servers are the
 * primary use case) may also use plain HTTP. The optional bearer key is used
 * for this one request and never stored or logged.
 */
export async function fetchCustomEndpointModels(
  input: {
    readonly baseUrl: string;
    readonly apiKey?: string | undefined;
    readonly signal?: AbortSignal | undefined;
  },
  request: typeof outboundHttp.request = outboundHttp.request.bind(outboundHttp),
): Promise<ProviderEndpointModelInfo[]> {
  const baseUrl = input.baseUrl.trim().replace(/\/+$/u, "");
  const url = new URL(baseUrl);
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("The endpoint URL must use http or https.");
  }
  const apiKey = input.apiKey?.trim();
  const response = await request({
    url: `${baseUrl}/models`,
    method: "GET",
    headers: {
      accept: "application/json",
      ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
    },
    ...(input.signal ? { signal: input.signal } : {}),
    policy: {
      service: "custom-endpoint-models",
      allowedOrigins: [url.origin],
      timeoutMs: ENDPOINT_MODELS_TIMEOUT_MS,
      maxRequestBytes: 1024,
      maxResponseBytes: ENDPOINT_MODELS_MAX_RESPONSE_BYTES,
      maxRedirects: 0,
      maxConcurrent: 2,
      maxQueued: 8,
      requirePublicAddress: false,
      allowPrivateLanAddresses: true,
    },
  });
  if (response.status !== 200) {
    throw new Error(`The endpoint model list is unavailable (HTTP ${response.status}).`);
  }
  const payload = decodeOutboundJson(response, { maxDepth: 16, maxNodes: 100_000 });
  const data = recordValue(payload)?.data;
  if (!Array.isArray(data)) {
    throw new Error("Invalid endpoint model list.");
  }
  const models: ProviderEndpointModelInfo[] = [];
  for (const value of data) {
    const entry = recordValue(value);
    const id = typeof entry?.id === "string" ? entry.id.trim() : "";
    if (!id || id.length > 200) continue;
    const name = typeof entry?.name === "string" && entry.name.trim() ? entry.name.trim() : id;
    const contextLength = positiveInteger(entry?.context_length);
    models.push({
      id,
      name,
      ...(contextLength !== undefined ? { contextWindow: contextLength } : {}),
    });
  }
  return models;
}
