// FILE: wsTelegramRpc.ts
// Purpose: The Telegram bridge RPC handlers, as one owner-guarded unit.
// Layer: server RPC handlers
//
// The bot token is owner state: a paired client-role session must neither read nor replace it.

import { WS_METHODS, WsRpcError, type TelegramBridgeActionInput } from "@iishko/contracts";
import { Effect, Schema } from "effect";

import { unwrapTryPromiseError } from "./accountRpcErrors";
import type { TelegramBridge } from "./telegramBridge/bridge";
import { requireOwnerRole } from "./wsOwnerOnly";

function toTelegramWsRpcError(rawCause: unknown, fallbackMessage: string): WsRpcError {
  const cause = unwrapTryPromiseError(rawCause);
  return Schema.is(WsRpcError)(cause) ? cause : new WsRpcError({ message: fallbackMessage });
}

const ownerTelegramRpc = <A>(make: () => Promise<A>, fallbackMessage: string) =>
  requireOwnerRole.pipe(
    Effect.flatMap(() =>
      Effect.tryPromise(make).pipe(
        Effect.mapError((cause) => toTelegramWsRpcError(cause, fallbackMessage)),
      ),
    ),
  );

export function makeTelegramBridgeRpcHandlers(bridge: TelegramBridge) {
  return {
    [WS_METHODS.telegramBridgeStatus]: () =>
      ownerTelegramRpc(() => bridge.status(), "Failed to read the Telegram bridge"),
    [WS_METHODS.telegramBridgeAction]: (input: TelegramBridgeActionInput) =>
      ownerTelegramRpc(() => bridge.action(input), "Failed to update the Telegram bridge"),
  };
}
