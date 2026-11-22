// FILE: wsIishkoAccountRpc.ts
// Purpose: The IISHKO gateway account RPC handlers, as one owner-guarded unit.
// Layer: server RPC handlers
//
// The gateway key is owner state: a paired client-role session must neither
// read nor replace it. The guard runs before each handler effect is built, and
// errors keep only a message and code, never a cause derived from a request
// that carried the key.

import { WS_METHODS, WsRpcError } from "@iishko/contracts";
import { Effect, Schema } from "effect";

import { unwrapTryPromiseError } from "./accountRpcErrors";
import type { IishkoAccount } from "./iishkoAccount";
import { requireOwnerRole } from "./wsOwnerOnly";

function toIishkoWsRpcError(rawCause: unknown, fallbackMessage: string): WsRpcError {
  const cause = unwrapTryPromiseError(rawCause);
  return Schema.is(WsRpcError)(cause) ? cause : new WsRpcError({ message: fallbackMessage });
}

const ownerIishkoRpc = <A>(make: () => Promise<A>, fallbackMessage: string) =>
  requireOwnerRole.pipe(
    Effect.flatMap(() =>
      Effect.tryPromise(make).pipe(
        Effect.mapError((cause) => toIishkoWsRpcError(cause, fallbackMessage)),
      ),
    ),
  );

export function makeIishkoAccountRpcHandlers(account: IishkoAccount) {
  return {
    [WS_METHODS.iishkoAccountStatus]: () =>
      ownerIishkoRpc(() => account.status(), "Failed to read the IISHKO account"),
    [WS_METHODS.iishkoBeginTelegramPairing]: () =>
      ownerIishkoRpc(() => account.beginTelegramPairing(), "Failed to start Telegram sign-in"),
    [WS_METHODS.iishkoPollTelegramPairing]: (input: { readonly pairingId: string }) =>
      ownerIishkoRpc(() => account.pollTelegramPairing(input), "Failed to check Telegram sign-in"),
    [WS_METHODS.iishkoCancelTelegramPairing]: (input: { readonly pairingId: string }) =>
      ownerIishkoRpc(() => account.cancelTelegramPairing(input), "Failed to cancel sign-in"),
    [WS_METHODS.iishkoConnectApiKey]: (input: { readonly apiKey: string }) =>
      ownerIishkoRpc(() => account.connectApiKey(input), "Failed to connect the API key"),
    [WS_METHODS.iishkoProfile]: () =>
      ownerIishkoRpc(() => account.profile(), "Failed to load the IISHKO profile"),
    [WS_METHODS.iishkoSignOut]: () =>
      ownerIishkoRpc(() => account.signOut(), "Failed to disconnect the IISHKO account"),
  };
}
