// FILE: telegramApi.ts
// Purpose: Minimal Telegram Bot API client over the shared outbound HTTP policy.
// Layer: Server Telegram bridge
//
// The bot token lives in the request path, so URLs and request objects are never logged
// or included in thrown messages.

import { decodeOutboundJson, outboundHttp } from "@iishko/shared/outboundHttp";

export const TELEGRAM_API_BASE_ENV = "IISHKO_TELEGRAM_API_BASE";
const TELEGRAM_API_ORIGIN = "https://api.telegram.org";

export interface TelegramApiResult<T = unknown> {
  readonly ok: boolean;
  readonly result?: T;
  readonly errorCode?: number;
  readonly description?: string;
  readonly retryAfter?: number;
}

export interface TelegramApi {
  readonly call: <T = unknown>(
    method: string,
    params?: Record<string, unknown>,
    options?: { readonly timeoutMs?: number; readonly signal?: AbortSignal },
  ) => Promise<TelegramApiResult<T>>;
}

export function resolveTelegramApiBase(env: Readonly<NodeJS.ProcessEnv> = process.env): string {
  const override = env[TELEGRAM_API_BASE_ENV]?.trim();
  if (override) {
    try {
      const url = new URL(override);
      const loopback = url.hostname === "127.0.0.1" || url.hostname === "localhost";
      if (url.protocol === "http:" && loopback && !url.username && !url.password) {
        return url.href.replace(/\/+$/u, "");
      }
    } catch {
      // An invalid override keeps the production endpoint.
    }
  }
  return TELEGRAM_API_ORIGIN;
}

export function makeTelegramApi(input: {
  readonly token: string;
  readonly env?: Readonly<NodeJS.ProcessEnv> | undefined;
  readonly request?: typeof outboundHttp.request | undefined;
}): TelegramApi {
  const base = resolveTelegramApiBase(input.env);
  const request = input.request ?? outboundHttp.request.bind(outboundHttp);
  const url = new URL(base);
  const loopback = url.protocol === "http:";
  return {
    call: async (method, params = {}, options = {}) => {
      const timeoutMs = options.timeoutMs ?? 15_000;
      const response = await request({
        url: `${base}/bot${input.token}/${method}`,
        method: "POST",
        headers: { accept: "application/json", "content-type": "application/json" },
        body: JSON.stringify(params),
        ...(options.signal ? { signal: options.signal } : {}),
        policy: {
          service: "telegram-bot-api",
          allowedOrigins: [url.origin],
          timeoutMs,
          maxRequestBytes: 64 * 1024,
          maxResponseBytes: 2 * 1024 * 1024,
          maxRedirects: 0,
          maxConcurrent: 3,
          maxQueued: 8,
          requirePublicAddress: !loopback,
          allowLoopbackHttp: loopback,
          allowBenchmarkAddressRange: true,
        },
      });
      let payload: Record<string, unknown> = {};
      try {
        const decoded = decodeOutboundJson(response, { maxDepth: 12, maxNodes: 50_000 });
        if (decoded && typeof decoded === "object" && !Array.isArray(decoded)) {
          payload = decoded as Record<string, unknown>;
        }
      } catch {
        // A non-JSON answer is reported by status only.
      }
      const parameters = payload.parameters as { retry_after?: unknown } | undefined;
      return {
        ok: payload.ok === true,
        result: payload.result as never,
        errorCode: typeof payload.error_code === "number" ? payload.error_code : response.status,
        ...(typeof payload.description === "string" ? { description: payload.description } : {}),
        ...(typeof parameters?.retry_after === "number"
          ? { retryAfter: parameters.retry_after }
          : {}),
      };
    },
  };
}
