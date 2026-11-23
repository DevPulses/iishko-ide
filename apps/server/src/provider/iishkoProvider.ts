// FILE: iishkoProvider.ts
// Purpose: Registers the built-in IISHKO gateway as a Pi provider with live model discovery.
// Layer: Provider runtime support

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import type {
  AssistantMessage,
  AssistantMessageEventStream,
  Model,
  ProviderStreams,
} from "@earendil-works/pi-ai";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { decodeOutboundJson, outboundHttp } from "@iishko/shared/outboundHttp";

import {
  getIishkoSessionBaseUrl,
  readIishkoDeviceToken,
  resolveIishkoApiKey,
} from "../iishkoSession.ts";
import type { PiPackageImporter } from "./piSdkImports.ts";

export const IISHKO_PROVIDER_ID = "iishko";
export const IISHKO_PROVIDER_NAME = "ИИШКО";
// Provider credentials stay outside the IISHKO_ control-plane namespace, which provider
// child environments strip.
export const IISHKO_API_KEY_ENV = "REFORMBOSS_API_KEY";
export const IISHKO_API_BASE_URL_ENV = "REFORMBOSS_API_BASE_URL";
/** Marks a stored raw key as allowed on the direct gateway (only set by the 404 key-login fallback). */
export const IISHKO_DIRECT_KEY_ENV = "REFORMBOSS_DIRECT_API_KEY";
export const IISHKO_DEFAULT_BASE_URL = "https://api.reformboss.com/v1";
export const IISHKO_CLIENT_HEADER = "X-IISHKO-Client";
export const IISHKO_IDE_HEADER = "X-IISHKO-IDE";
export const IISHKO_CLIENT_VERSION_ENV = "IISHKO_CLIENT_VERSION";
// The gateway cut answers at 2000 tokens when a small cap was sent; this ceiling only applies
// when the gateway does not report a per-model output limit.
const DEFAULT_MODEL_MAX_TOKENS = 32_768;

export function iishkoClientHeaderValue(env: Readonly<NodeJS.ProcessEnv> = process.env): string {
  const version = env[IISHKO_CLIENT_VERSION_ENV]?.trim() || "1.0.0";
  return `iishko-ide/${version}`;
}

export const IISHKO_DEFAULT_MODEL_ID = "deepseek-v4-flash";
export const IISHKO_PREFERRED_MODEL_IDS: ReadonlyArray<string> = [
  "claude-sonnet-5",
  "claude-opus-5-5",
  "gpt-6-luna",
  "kimi-k3",
  "deepseek-v4-pro",
  "glm-5.3",
  "qwen3.8-max",
  IISHKO_DEFAULT_MODEL_ID,
];

/** Models a new sign-in or a vanished selection falls back to, in order. */
export const IISHKO_DEFAULT_PICK_ORDER: ReadonlyArray<string> = [
  "deepseek-v4-flash",
  "deepseek-v4.1-flash",
  "glm-5.3",
  "qwen3.8-flash",
  "kimi-k3",
  "gpt-6-luna",
];

export function pickIishkoDefaultModelId(modelIds: ReadonlyArray<string>): string | undefined {
  return IISHKO_DEFAULT_PICK_ORDER.find((id) => modelIds.includes(id)) ?? modelIds[0];
}

/** Context the gateway proxy reports for full-window models; smaller real windows come from `context_length`. */
export const IISHKO_DEFAULT_CONTEXT_WINDOW = 400_000;
/** Below this the agent's system prompt and tools cannot fit; the guard would 413 anyway. */
export const IISHKO_MIN_CONTEXT_WINDOW = 32_000;

// Media, speech and retrieval models cannot drive a tool-calling coding agent.
// The gateway's `auto` router ignores tool definitions.
const NON_AGENT_MODEL_PATTERN =
  /i2v|t2v|img2video|text2video|video|image|tts|whisper|embed|rerank|dall-?e|flux|sora|kling|vidu|pixverse|happyhorse|wan2|diffusion|music|suno|speech/iu;
const MODELS_TTL_MS = 5 * 60_000;
const modelCache = new Map<
  string,
  { readonly models: ReadonlyArray<Model<"openai-completions">>; readonly fetchedAt: number }
>();

const BACKGROUND_RETRY_DELAYS_MS = [5_000, 15_000, 45_000, 120_000] as const;
const inflightRefresh = new Map<string, Promise<ReadonlyArray<Model<"openai-completions">>>>();
const backgroundRetries = new Set<string>();

interface PersistedModelCache {
  readonly [cacheKey: string]: { readonly fetchedAt: number; readonly models: unknown };
}

/** The last good model list survives restarts under the IISHKO state directory. */
export function iishkoModelsCachePath(): string {
  // Provider child environments strip IISHKO_*, so the home is read from the server process only.
  const env = process.env;
  const base =
    env.IISHKO_HOME?.trim() ||
    join(process.env.HOME ?? process.env.USERPROFILE ?? ".", ".iishko-ide");
  const stateDir = join(base, env.VITE_DEV_SERVER_URL ? "dev" : "userdata");
  return join(stateDir, "iishko", "models-cache.json");
}

async function readPersistedModels(
  path: string,
  cacheKey: string,
): Promise<ReadonlyArray<Model<"openai-completions">> | undefined> {
  try {
    const parsed = record(JSON.parse(await readFile(path, "utf8"))) as
      | PersistedModelCache
      | undefined;
    const entry = record(parsed?.[cacheKey]);
    const models = Array.isArray(entry?.models)
      ? (entry.models as Model<"openai-completions">[])
      : [];
    return models.length > 0 ? models : undefined;
  } catch {
    return undefined;
  }
}

async function writePersistedModels(
  path: string,
  cacheKey: string,
  models: ReadonlyArray<Model<"openai-completions">>,
): Promise<void> {
  try {
    let current: Record<string, unknown> = {};
    try {
      current = record(JSON.parse(await readFile(path, "utf8"))) ?? {};
    } catch {
      current = {};
    }
    // Only the account that just succeeded stays cached; other keys' lists are dropped.
    const next = { [cacheKey]: { fetchedAt: Date.now(), models } };
    void current;
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFile(path, `${JSON.stringify(next)}\n`, { mode: 0o600 });
  } catch {
    // A cache that cannot be written only costs the offline fallback.
  }
}

/** Gateway failures in Russian for the provider-error path; null keeps the raw message. */
/** The `message` of a JSON error body (`{"error":{"message"}}` or `{"message"}`), if any. */
function gatewayJsonMessage(text: string): string | null {
  const start = text.indexOf("{");
  if (start === -1) return null;
  try {
    const body = record(JSON.parse(text.slice(start)));
    const error = record(body?.error);
    const message = typeof error?.message === "string" ? error.message : body?.message;
    return typeof message === "string" && message.trim() ? message.trim().slice(0, 500) : null;
  } catch {
    return null;
  }
}

export function mapIishkoGatewayError(message: string): string | null {
  const text = message.trim();
  if (!text) return null;
  const status = /^\s*(?:HTTP\s*)?(\d{3})\b/u.exec(text)?.[1];
  const codeMatch = /["']?(?:code|type)["']?\s*[:=]\s*["']([a-z0-9_.-]+)["']/giu;
  const codes = [...text.matchAll(codeMatch)].map((match) => match[1]!.toLowerCase());
  const has = (...names: string[]) => names.some((name) => codes.includes(name));
  const ctxguard = /ctxguard_(\d+)/iu.exec(text)?.[1];
  if (status === "413" || ctxguard !== undefined || has("context_length_exceeded")) {
    const limit = ctxguard ? ` (лимит ≈${ctxguard} токенов)` : "";
    return `Запрос не помещается в контекст модели${limit}. Начните новый чат или выберите модель с большим контекстом.`;
  }
  if (has("ide_no_key")) return "Завершите регистрацию в боте @iishkogatewaybot (/start)";
  if (has("ide_account_blocked")) return gatewayJsonMessage(text);
  if (has("ide_session_unavailable")) return "Проверка сессии временно недоступна";
  if (has("ide_session_invalid")) return "Ключ ИИШКО недействителен — войдите заново";
  if (has("ide_only")) {
    return "Для вашего ранга модели ИИШКО работают только после входа через Telegram: Настройки → Аккаунт ИИШКО → «Войти через Telegram».";
  }
  if (has("upstream_pool_empty", "gateway_restarting", "model_failing_cooldown")) {
    return "Модель временно недоступна — повторите или выберите другую";
  }
  if (status === "401") return "Ключ ИИШКО недействителен — войдите заново";
  if (status === "402" || has("insufficient_quota", "quota_exceeded", "insufficient_user_quota")) {
    return "Лимит на сегодня исчерпан";
  }
  if (status === "429" || has("rate_limit_exceeded", "rate_limited")) {
    const seconds = /retry[- ]?after[^0-9]{0,12}(\d{1,4})/iu.exec(text)?.[1];
    return `Слишком много запросов, повтор через ${seconds ?? "несколько"} с`;
  }
  return gatewayJsonMessage(text);
}

// The gateway's context guard answers 413 with `ctxguard_<tokens>` or a
// `context_length_exceeded` code. pi-ai's overflow detector knows the generic
// patterns but not `ctxguard_`, so the provider stream marks those errors with
// a phrase it does recognize; agent-session then auto-compacts and retries.
const IISHKO_OVERFLOW_SIGNAL = /ctxguard_\d+|context_length_exceeded/iu;
const IISHKO_OVERFLOW_STATUS = /^(?:[\w -]+ API error \(413\):|413(?:\s|:|$))/iu;
const PI_OVERFLOW_MARKER = "context length exceeded";

export function isIishkoContextOverflowError(errorMessage: string | undefined): boolean {
  const text = errorMessage?.trim() ?? "";
  if (!text || text.toLowerCase().includes(PI_OVERFLOW_MARKER)) return false;
  return IISHKO_OVERFLOW_SIGNAL.test(text) || IISHKO_OVERFLOW_STATUS.test(text);
}

function markIishkoOverflow(message: AssistantMessage): void {
  if (message.stopReason !== "error" || !isIishkoContextOverflowError(message.errorMessage)) {
    return;
  }
  message.errorMessage = `${message.errorMessage ?? ""}\n${PI_OVERFLOW_MARKER}.`.trim();
}

/**
 * Forwards a provider stream while tagging IISHKO context-overflow errors so
 * pi-coding-agent's `isContextOverflow` triggers auto-compaction. Other events
 * pass through untouched.
 */
export function wrapIishkoProviderStreams(
  api: ProviderStreams,
  createStream: () => AssistantMessageEventStream,
): ProviderStreams {
  const wrap = (inner: AssistantMessageEventStream): AssistantMessageEventStream => {
    const outer = createStream();
    void (async () => {
      let result: AssistantMessage | undefined;
      for await (const event of inner) {
        if (event.type === "error") {
          markIishkoOverflow(event.error);
          result = event.error;
        } else if (event.type === "done") {
          result = event.message;
        }
        outer.push(event);
      }
      const settled = await Promise.race([
        inner.result(),
        Promise.resolve<AssistantMessage | undefined>(undefined),
      ]);
      outer.end(settled ?? result);
    })();
    return outer;
  };
  return {
    ...api,
    stream: (model, context, options) => wrap(api.stream(model, context, options)),
    streamSimple: (model, context, options) => wrap(api.streamSimple(model, context, options)),
  };
}

/** The gateway rejected the key itself, as opposed to being unreachable. */
export class IishkoAuthError extends Error {
  override readonly name = "IishkoAuthError";
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function resolveIishkoBaseUrl(
  environment: Readonly<NodeJS.ProcessEnv>,
  sessionBaseUrl?: string | undefined,
): string {
  const override = environment[IISHKO_API_BASE_URL_ENV]?.trim();
  if (!override) return sessionBaseUrl ?? IISHKO_DEFAULT_BASE_URL;
  try {
    const url = new URL(override);
    const loopback = url.hostname === "127.0.0.1" || url.hostname === "localhost";
    if (
      (url.protocol === "https:" || (url.protocol === "http:" && loopback)) &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash
    ) {
      return url.href.replace(/\/+$/u, "");
    }
  } catch {
    // An invalid override keeps the production gateway.
  }
  return IISHKO_DEFAULT_BASE_URL;
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

function preferenceRank(id: string): number {
  const index = IISHKO_PREFERRED_MODEL_IDS.indexOf(id);
  return index === -1 ? IISHKO_PREFERRED_MODEL_IDS.length : index;
}

/** Structured status first (SDK errors carry `status`), then the message text. */
export function isIishkoUnauthorizedError(error: unknown, message: string): boolean {
  const status =
    typeof error === "object" && error !== null && "status" in error
      ? (error as { status?: unknown }).status
      : undefined;
  if (status === 401) return true;
  return /\b401\b|ide_session_invalid|invalid_api_key|device_revoked/u.test(message);
}

export function clearIishkoModelCache(): void {
  modelCache.clear();
}

export function sortIishkoModelIds<T extends { readonly id: string }>(
  models: ReadonlyArray<T>,
): T[] {
  return models.toSorted(
    (left, right) =>
      preferenceRank(left.id) - preferenceRank(right.id) || left.id.localeCompare(right.id),
  );
}

/** Maps the gateway's OpenAI-compatible `/models` list to Pi chat models. */
export function parseIishkoModels(
  payload: unknown,
  baseUrl: string = IISHKO_DEFAULT_BASE_URL,
): Model<"openai-completions">[] {
  const data = record(payload)?.data;
  if (!Array.isArray(data)) throw new Error("Invalid IISHKO model list.");
  const models = new Map<string, Model<"openai-completions">>();
  for (const value of data) {
    const dto = record(value);
    const id = dto?.id;
    if (typeof id !== "string" || !id || id !== id.trim() || id.length > 200) continue;
    const endpoints = dto?.supported_endpoint_types;
    if (Array.isArray(endpoints) && !endpoints.includes("openai")) continue;
    if (id === "auto" || NON_AGENT_MODEL_PATTERN.test(id)) continue;
    const contextLength = positiveInteger(dto?.context_length);
    if (contextLength !== undefined && contextLength < IISHKO_MIN_CONTEXT_WINDOW) continue;
    const displayName =
      typeof dto?.name === "string" && dto.name.trim().length > 0 ? dto.name.trim() : id;
    models.set(id, {
      id,
      name: displayName,
      provider: IISHKO_PROVIDER_ID,
      api: "openai-completions",
      baseUrl,
      reasoning: false,
      input: /^(?:claude|gpt|gemini)/iu.test(id) ? ["text", "image"] : ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: Math.min(
        contextLength ?? IISHKO_DEFAULT_CONTEXT_WINDOW,
        IISHKO_DEFAULT_CONTEXT_WINDOW,
      ),
      maxTokens:
        positiveInteger(dto?.max_output_tokens) ??
        positiveInteger(dto?.max_completion_tokens) ??
        DEFAULT_MODEL_MAX_TOKENS,
      headers: { [IISHKO_CLIENT_HEADER]: iishkoClientHeaderValue(), [IISHKO_IDE_HEADER]: "true" },
      compat: {
        supportsStore: false,
        supportsDeveloperRole: false,
        supportsReasoningEffort: false,
        maxTokensField: "max_tokens",
      },
    });
  }
  return sortIishkoModelIds([...models.values()]);
}

export async function fetchIishkoModels(
  apiKey: string,
  options: {
    readonly baseUrl?: string | undefined;
    readonly signal?: AbortSignal | undefined;
    readonly request?: typeof outboundHttp.request | undefined;
  } = {},
): Promise<Model<"openai-completions">[]> {
  const baseUrl = options.baseUrl ?? IISHKO_DEFAULT_BASE_URL;
  const request = options.request ?? outboundHttp.request.bind(outboundHttp);
  const response = await request({
    url: `${baseUrl}/models`,
    method: "GET",
    headers: {
      accept: "application/json",
      authorization: `Bearer ${apiKey}`,
      [IISHKO_CLIENT_HEADER.toLowerCase()]: iishkoClientHeaderValue(),
      [IISHKO_IDE_HEADER.toLowerCase()]: "true",
    },
    ...(options.signal ? { signal: options.signal } : {}),
    policy: {
      service: "iishko-models",
      allowedOrigins: [new URL(baseUrl).origin],
      timeoutMs: 8_000,
      maxRequestBytes: 1024,
      maxResponseBytes: 2 * 1024 * 1024,
      maxRedirects: 0,
      maxConcurrent: 2,
      maxQueued: 8,
      // A loopback mock gateway is the only private-address target allowed.
      requirePublicAddress: !["127.0.0.1", "localhost"].includes(new URL(baseUrl).hostname),
      allowLoopbackHttp: new URL(baseUrl).protocol === "http:",
      // Fake-ip proxy DNS (Clash/Mihomo) resolves public hosts into 198.18.0.0/15.
      allowBenchmarkAddressRange: true,
    },
  });
  if (response.status === 401 || response.status === 403) {
    throw new IishkoAuthError("The IISHKO gateway rejected the API key.");
  }
  if (response.status !== 200) {
    throw new Error(`The IISHKO model list is unavailable (HTTP ${response.status}).`);
  }
  return parseIishkoModels(
    decodeOutboundJson(response, { maxDepth: 16, maxNodes: 100_000 }),
    baseUrl,
  );
}

/**
 * Returns the cached list while fresh. When the gateway times out, errors or answers 5xx the
 * last good list (memory, then disk) is served and a background retry runs with backoff, so a
 * cached account never sees an empty model list. Concurrent refreshes share one request.
 */
export async function loadIishkoModels(
  apiKey: string,
  options: {
    readonly baseUrl?: string | undefined;
    readonly signal?: AbortSignal | undefined;
    readonly request?: typeof outboundHttp.request | undefined;
    readonly forceRefresh?: boolean | undefined;
    /** Stable identity of the account; session tokens rotate, so they cannot key the cache. */
    readonly cacheKey?: string | undefined;
    readonly cachePath?: string | undefined;
    readonly retryDelaysMs?: ReadonlyArray<number> | undefined;
  } = {},
): Promise<ReadonlyArray<Model<"openai-completions">>> {
  const baseUrl = options.baseUrl ?? IISHKO_DEFAULT_BASE_URL;
  const cacheKey = createHash("sha256")
    .update(`${baseUrl}\n${options.cacheKey ?? apiKey}`)
    .digest("hex");
  const cachePath = options.cachePath ?? iishkoModelsCachePath();
  const cached = modelCache.get(cacheKey);
  if (!options.forceRefresh && cached && Date.now() - cached.fetchedAt < MODELS_TTL_MS) {
    return cached.models;
  }
  const refresh = async (): Promise<ReadonlyArray<Model<"openai-completions">>> => {
    const models = await fetchIishkoModels(apiKey, { ...options, baseUrl });
    modelCache.set(cacheKey, { models, fetchedAt: Date.now() });
    if (models.length > 0) await writePersistedModels(cachePath, cacheKey, models);
    return models;
  };
  let pending = inflightRefresh.get(cacheKey);
  if (!pending) {
    pending = refresh().finally(() => inflightRefresh.delete(cacheKey));
    inflightRefresh.set(cacheKey, pending);
  }
  try {
    return await pending;
  } catch (cause) {
    if (cause instanceof IishkoAuthError) {
      modelCache.delete(cacheKey);
      throw cause;
    }
    const stale = cached?.models ?? (await readPersistedModels(cachePath, cacheKey));
    if (stale && stale.length > 0) {
      scheduleBackgroundRefresh(
        cacheKey,
        refresh,
        options.retryDelaysMs ?? BACKGROUND_RETRY_DELAYS_MS,
      );
      return stale;
    }
    throw cause;
  }
}

function scheduleBackgroundRefresh(
  cacheKey: string,
  refresh: () => Promise<unknown>,
  delays: ReadonlyArray<number>,
): void {
  if (backgroundRetries.has(cacheKey)) return;
  backgroundRetries.add(cacheKey);
  const attempt = (index: number) => {
    const delay = delays[index];
    if (delay === undefined) {
      backgroundRetries.delete(cacheKey);
      return;
    }
    const timer = setTimeout(() => {
      refresh().then(
        () => backgroundRetries.delete(cacheKey),
        (cause: unknown) => {
          if (cause instanceof IishkoAuthError) backgroundRetries.delete(cacheKey);
          else attempt(index + 1);
        },
      );
    }, delay);
    timer.unref?.();
  };
  attempt(0);
}

/** Install before SDK services load extensions, so user registrations still win. */
export async function refreshPiIishkoModels(
  runtime: ModelRuntime,
  importPackage: PiPackageImporter,
  options: {
    readonly signal?: AbortSignal | undefined;
    readonly environment?: Readonly<NodeJS.ProcessEnv> | undefined;
    readonly request?: typeof outboundHttp.request | undefined;
  } = {},
): Promise<void> {
  const environment = options.environment ?? process.env;
  const deviceToken = await readIishkoDeviceToken();
  if (
    (!environment[IISHKO_API_KEY_ENV]?.trim() && !deviceToken) ||
    environment.PI_OFFLINE !== undefined ||
    options.signal?.aborted
  ) {
    return;
  }
  try {
    const apiKey = await resolveIishkoApiKey(environment, IISHKO_API_KEY_ENV, {
      ...(options.request ? { request: options.request } : {}),
    });
    if (!apiKey) return;
    // A raw key alone must never reach the direct API: the gateway rejects it for
    // lower ranks. Only a device session, the dev base-URL override, or the
    // key-login-404 marker may use the direct gateway.
    const directKeyAllowed =
      environment[IISHKO_DIRECT_KEY_ENV] === "1" ||
      Boolean(environment[IISHKO_API_BASE_URL_ENV]?.trim());
    if (!deviceToken && !directKeyAllowed) return;
    const baseUrl = resolveIishkoBaseUrl(
      environment,
      deviceToken && apiKey.startsWith("ids_") ? getIishkoSessionBaseUrl(deviceToken) : undefined,
    );
    const models = await loadIishkoModels(apiKey, {
      baseUrl,
      signal: options.signal,
      request: options.request,
      cacheKey: deviceToken ? `device:${deviceToken}` : undefined,
      cachePath: iishkoModelsCachePath(),
    });
    if (models.length === 0 || options.signal?.aborted) return;
    const [
      { createProvider, createAssistantMessageEventStream, envApiKeyAuth },
      { openAICompletionsApi },
    ] = await Promise.all([
      importPackage<typeof import("@earendil-works/pi-ai")>("@earendil-works/pi-ai"),
      importPackage<typeof import("@earendil-works/pi-ai/api/openai-completions.lazy")>(
        "@earendil-works/pi-ai/api/openai-completions.lazy",
      ),
    ]);
    runtime.registerNativeProvider(
      createProvider({
        id: IISHKO_PROVIDER_ID,
        name: IISHKO_PROVIDER_NAME,
        baseUrl,
        auth: {
          apiKey: {
            ...envApiKeyAuth("IISHKO API key", [IISHKO_API_KEY_ENV]),
            // Resolved per request, so a rotated session token is picked up without a restart.
            resolve: async () => {
              const key = await resolveIishkoApiKey(environment, IISHKO_API_KEY_ENV).catch(
                () => undefined,
              );
              if (!key) return undefined;
              const directKeyAllowed =
                environment[IISHKO_DIRECT_KEY_ENV] === "1" ||
                Boolean(environment[IISHKO_API_BASE_URL_ENV]?.trim());
              const isRawKey = key === environment[IISHKO_API_KEY_ENV]?.trim();
              if (isRawKey && !directKeyAllowed) return undefined;
              return { auth: { apiKey: key }, source: "IISHKO" };
            },
          },
        },
        models,
        api: wrapIishkoProviderStreams(openAICompletionsApi(), createAssistantMessageEventStream),
      }),
    );
    await runtime.refresh({ allowNetwork: false });
  } catch {
    // A rejected key, an offline gateway or an older Pi SDK leaves IISHKO models unavailable.
  }
}
