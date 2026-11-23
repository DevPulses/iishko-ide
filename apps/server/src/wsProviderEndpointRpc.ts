// FILE: wsProviderEndpointRpc.ts
// Purpose: Owner-guarded RPC that probes a custom OpenAI-compatible endpoint's
//   /models listing for the provider settings dialog.
// Layer: server RPC handlers
//
// The optional bearer key arrives once in the request (or is read from the
// instance's stored environment server-side) and is never persisted, logged,
// or returned.

import { WS_METHODS, WsRpcError, type ProviderListEndpointModelsInput } from "@iishko/contracts";
import type { ServerSettings } from "@iishko/contracts";
import { deriveProviderInstances } from "@iishko/shared/providerInstances";
import { Effect, Schema } from "effect";

import { unwrapTryPromiseError } from "./accountRpcErrors";
import {
  CUSTOM_PROVIDER_DEFAULT_API_KEY_ENV,
  fetchCustomEndpointModels,
} from "./provider/piCustomProviders";
import { requireOwnerRole } from "./wsOwnerOnly";

function toEndpointWsRpcError(rawCause: unknown, fallbackMessage: string): WsRpcError {
  const cause = unwrapTryPromiseError(rawCause);
  if (Schema.is(WsRpcError)(cause)) {
    return cause;
  }
  const message =
    cause instanceof Error && cause.message.trim().length > 0 ? cause.message : fallbackMessage;
  return new WsRpcError({ message });
}

function trimToUndefined(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function urlOrigin(value: string): string | undefined {
  try {
    return new URL(value).origin;
  } catch {
    return undefined;
  }
}

export function makeProviderEndpointRpcHandlers(deps: {
  readonly readSettings: () => Promise<ServerSettings>;
}) {
  return {
    [WS_METHODS.providerListEndpointModels]: (input: ProviderListEndpointModelsInput) =>
      requireOwnerRole.pipe(
        Effect.flatMap(() =>
          Effect.tryPromise(async () => {
            let apiKey = trimToUndefined(input.apiKey);
            if (!apiKey && input.instanceId) {
              const settings = await deps.readSettings();
              const instance = deriveProviderInstances(settings).find(
                (entry) => entry.instanceId === input.instanceId,
              );
              const apiKeyEnv =
                trimToUndefined(instance?.config.apiKeyEnv) ?? CUSTOM_PROVIDER_DEFAULT_API_KEY_ENV;
              apiKey = trimToUndefined(instance?.environment[apiKeyEnv]);
              if (apiKey) {
                // The stored key is bound to the endpoint it was saved for: a
                // request for another origin must re-enter the key instead of
                // letting the redacted secret authenticate an arbitrary host.
                const storedBaseUrl = trimToUndefined(instance?.config.baseUrl);
                const requestOrigin = urlOrigin(input.baseUrl);
                const storedOrigin = storedBaseUrl ? urlOrigin(storedBaseUrl) : undefined;
                if (!requestOrigin || !storedOrigin || requestOrigin !== storedOrigin) {
                  throw new Error("Ключ сохранён для другого адреса — введите ключ заново");
                }
              }
            }
            const models = await fetchCustomEndpointModels({
              baseUrl: input.baseUrl,
              ...(apiKey ? { apiKey } : {}),
            });
            return { models };
          }).pipe(
            Effect.mapError((cause) =>
              toEndpointWsRpcError(cause, "Failed to load the endpoint model list."),
            ),
          ),
        ),
      ),
  };
}
