// FILE: iishkoAccount.ts
// Purpose: Schemas for connecting the built-in IISHKO provider to a gateway account.
// Layer: Contracts

import { Schema } from "effect";

import { IsoDateTime, TrimmedNonEmptyString } from "./baseSchemas";

export const IishkoAccountSource = Schema.Literals(["telegram", "manual"]);
export type IishkoAccountSource = typeof IishkoAccountSource.Type;

export const IishkoAccountIdentity = Schema.Struct({
  username: Schema.NullOr(TrimmedNonEmptyString),
  displayName: Schema.NullOr(TrimmedNonEmptyString),
});
export type IishkoAccountIdentity = typeof IishkoAccountIdentity.Type;

/** The key never crosses this boundary; `keyHint` shows only its last characters. */
export const IishkoAccountStatus = Schema.Union([
  Schema.Struct({ state: Schema.Literal("disconnected") }),
  Schema.Struct({
    state: Schema.Literal("connected"),
    source: IishkoAccountSource,
    account: IishkoAccountIdentity,
    keyHint: TrimmedNonEmptyString,
    connectedAt: IsoDateTime,
  }),
  /** The device was revoked or its session can no longer be renewed; sign in again. */
  Schema.Struct({ state: Schema.Literal("revoked"), account: IishkoAccountIdentity }),
]);
export type IishkoAccountStatus = typeof IishkoAccountStatus.Type;

/** `pairingId` is a server-side handle; the gateway's pairing secret stays on the server. */
export const IishkoTelegramPairingStart = Schema.Union([
  Schema.Struct({
    state: Schema.Literal("started"),
    pairingId: TrimmedNonEmptyString,
    code: TrimmedNonEmptyString,
    botUrl: TrimmedNonEmptyString,
    expiresAt: IsoDateTime,
    pollIntervalMs: Schema.Number,
  }),
  Schema.Struct({ state: Schema.Literal("unavailable"), message: TrimmedNonEmptyString }),
]);
export type IishkoTelegramPairingStart = typeof IishkoTelegramPairingStart.Type;

export const IishkoPairingIdInput = Schema.Struct({
  pairingId: TrimmedNonEmptyString.check(Schema.isMaxLength(128)),
});
export type IishkoPairingIdInput = typeof IishkoPairingIdInput.Type;

export const IishkoTelegramPairingPoll = Schema.Union([
  Schema.Struct({ state: Schema.Literal("pending") }),
  Schema.Struct({ state: Schema.Literal("connected"), status: IishkoAccountStatus }),
  Schema.Struct({ state: Schema.Literal("expired") }),
  Schema.Struct({ state: Schema.Literal("denied") }),
]);
export type IishkoTelegramPairingPoll = typeof IishkoTelegramPairingPoll.Type;

/** The payload is a credential: never log it or keep it after the request settles. */
export const IishkoConnectApiKeyInput = Schema.Struct({
  apiKey: TrimmedNonEmptyString.check(Schema.isMaxLength(512)),
});
export type IishkoConnectApiKeyInput = typeof IishkoConnectApiKeyInput.Type;

const OptionalNumber = Schema.optional(Schema.Number);
const OptionalString = Schema.optional(Schema.String);

const IishkoProfileModel = Schema.Struct({ id: Schema.String, title: OptionalString });
const IishkoRankRef = Schema.Struct({ tier: Schema.String, title: Schema.String });

/** Everything except `user`, `rank` and `models` is optional: render what is present. */
export const IishkoProfile = Schema.Struct({
  user: Schema.Struct({
    username: OptionalString,
    firstName: OptionalString,
    photoUrl: OptionalString,
  }),
  rank: Schema.Struct({
    tier: Schema.String,
    title: Schema.String,
    emoji: OptionalString,
    next: Schema.optional(IishkoRankRef),
  }),
  limits: Schema.optional(
    Schema.Struct({
      requestsToday: OptionalNumber,
      requestsLimit: OptionalNumber,
      resetAt: OptionalString,
      premium: Schema.optional(
        Schema.Array(
          Schema.Struct({ name: Schema.String, used: Schema.Number, limit: Schema.Number }),
        ),
      ),
      dailyUsdCap: OptionalNumber,
      dailyUsdUsed: OptionalNumber,
      rpm: OptionalNumber,
      concurrency: OptionalNumber,
    }),
  ),
  balance: Schema.optional(Schema.Struct({ usd: OptionalNumber, weeklyCreditUsd: OptionalNumber })),
  models: Schema.Struct({
    available: Schema.Array(IishkoProfileModel),
    locked: Schema.Array(
      Schema.Struct({ id: Schema.String, title: OptionalString, minTier: Schema.String }),
    ),
  }),
  ideOnly: Schema.optional(
    Schema.Struct({ applies: Schema.Boolean, enforcedFrom: OptionalString }),
  ),
  device: Schema.optional(Schema.Struct({ name: Schema.String, createdAt: OptionalString })),
  fetchedAt: IsoDateTime,
});
export type IishkoProfile = typeof IishkoProfile.Type;

/** `WsRpcError.code` values the account UI branches on. */
export const IISHKO_ACCOUNT_ERROR_CODES = {
  invalidKey: "iishko_invalid_key",
  network: "iishko_network",
  revoked: "iishko_revoked",
} as const;
