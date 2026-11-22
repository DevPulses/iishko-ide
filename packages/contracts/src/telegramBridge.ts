// FILE: telegramBridge.ts
// Purpose: Schemas for driving the IDE from the user's own Telegram bot.
// Layer: Contracts

import { Schema } from "effect";

import { IsoDateTime, TrimmedNonEmptyString } from "./baseSchemas";

/** The bot token never crosses this boundary outward; only the bot name and state do. */
export const TelegramBridgeStatus = Schema.Struct({
  state: Schema.Literals(["off", "running", "error"]),
  /** True once a validated bot token is stored. */
  hasToken: Schema.Boolean,
  enabled: Schema.Boolean,
  botUsername: Schema.NullOr(Schema.String),
  ownerName: Schema.NullOr(Schema.String),
  /** Present while the owner is not bound yet. */
  bindCode: Schema.NullOr(Schema.String),
  reason: Schema.NullOr(Schema.String),
  lastActivityAt: Schema.NullOr(IsoDateTime),
});
export type TelegramBridgeStatus = typeof TelegramBridgeStatus.Type;

/** `setToken` carries a credential: do not log or retain it after the request settles. */
export const TelegramBridgeActionInput = Schema.Struct({
  action: Schema.Literals(["setToken", "newBindCode", "setEnabled", "disconnect"]),
  token: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(256))),
  enabled: Schema.optional(Schema.Boolean),
});
export type TelegramBridgeActionInput = typeof TelegramBridgeActionInput.Type;

export const TELEGRAM_BRIDGE_ERROR_CODES = {
  invalidToken: "telegram_invalid_token",
  network: "telegram_network",
} as const;
