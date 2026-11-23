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

/** Probe fields every model entry may carry; unknown server values must not fail decoding. */
const IishkoModelProbeFields = {
  status: OptionalString,
  unstable: Schema.optional(Schema.Boolean),
  latencyMs: OptionalNumber,
  checkedAt: OptionalNumber,
  reason: OptionalString,
};

const IishkoProfileModel = Schema.Struct({
  id: Schema.String,
  title: OptionalString,
  ...IishkoModelProbeFields,
});
const IishkoRankRef = Schema.Struct({ tier: Schema.String, title: Schema.String });

/** Everything except `user`, `rank` and `models` is optional: render what is present. */
export const IishkoProfile = Schema.Struct({
  user: Schema.Struct({
    username: OptionalString,
    firstName: OptionalString,
    photoUrl: OptionalString,
    joinedAt: OptionalNumber,
    daysInProject: OptionalNumber,
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
  spend: Schema.optional(
    Schema.Struct({
      todayUsd: OptionalNumber,
      todayRequests: OptionalNumber,
      weekUsd: OptionalNumber,
      weekRequests: OptionalNumber,
      monthUsd: OptionalNumber,
      monthRequests: OptionalNumber,
      totalUsd: OptionalNumber,
      topModels: Schema.optional(
        Schema.Array(
          Schema.Struct({
            id: Schema.String,
            title: OptionalString,
            requests: Schema.Number,
            usd: OptionalNumber,
          }),
        ),
      ),
    }),
  ),
  models: Schema.Struct({
    available: Schema.Array(IishkoProfileModel),
    locked: Schema.Array(
      Schema.Struct({
        id: Schema.String,
        title: OptionalString,
        minTier: Schema.String,
        ...IishkoModelProbeFields,
      }),
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

export const IishkoSubagentInfo = Schema.Struct({
  name: TrimmedNonEmptyString,
  description: Schema.String,
  source: Schema.Literals(["builtin", "user", "project"]),
  path: Schema.optional(Schema.String),
  model: Schema.optional(Schema.String),
  tools: Schema.optional(Schema.Array(Schema.String)),
});
export type IishkoSubagentInfo = typeof IishkoSubagentInfo.Type;

export const IishkoSubagentsListInput = Schema.Struct({
  cwd: Schema.optional(TrimmedNonEmptyString),
});
export type IishkoSubagentsListInput = typeof IishkoSubagentsListInput.Type;

export const IishkoSubagentsList = Schema.Struct({
  agents: Schema.Array(IishkoSubagentInfo),
  directories: Schema.Struct({
    home: Schema.String,
    project: Schema.optional(Schema.String),
  }),
});
export type IishkoSubagentsList = typeof IishkoSubagentsList.Type;

export const IishkoSubagentCreateInput = Schema.Struct({
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(64)),
});
export type IishkoSubagentCreateInput = typeof IishkoSubagentCreateInput.Type;

export const IishkoSubagentCreateResult = Schema.Struct({
  path: Schema.String,
});
export type IishkoSubagentCreateResult = typeof IishkoSubagentCreateResult.Type;
