// FILE: iishkoAccount.ts
// Purpose: Connects the built-in IISHKO provider to a gateway key, by Telegram pairing or a pasted key.
// Layer: Server account service
//
// The key lives only in the `pi` provider instance's secret environment
// (ServerSecretStore through server settings). Display metadata sits beside
// the server state; nothing here returns or logs the key itself.

import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  IISHKO_ACCOUNT_ERROR_CODES,
  type IishkoAccountSource,
  type IishkoAccountStatus,
  type IishkoProfile,
  type IishkoTelegramPairingPoll,
  type IishkoTelegramPairingStart,
  type ProviderInstanceId,
  type ServerSettings,
  type ServerSettingsPatch,
  WsRpcError,
} from "@iishko/contracts";
import { decodeOutboundJson, outboundHttp } from "@iishko/shared/outboundHttp";

import {
  deviceHeaders,
  forgetIishkoSession,
  getIishkoSessionBaseUrl,
  markIishkoDeviceRevoked,
  readIishkoDeviceToken,
  setIishkoDeviceTokenPath,
  writeIishkoDeviceToken,
  getIishkoSessionToken,
  IISHKO_DEVICE_TOKEN_ENV,
  LEGACY_IISHKO_DEVICE_TOKEN_ENV,
  IishkoDeviceRevokedError,
  iishkoAccountRequestPolicy,
  isIishkoDeviceRevoked,
  resolveIishkoAccountApiBase,
} from "./iishkoSession.ts";
import {
  IISHKO_API_KEY_ENV,
  clearIishkoModelCache,
  IISHKO_PREFERRED_MODEL_IDS,
  IISHKO_PROVIDER_ID,
  IishkoAuthError,
  loadIishkoModels,
  resolveIishkoBaseUrl,
} from "./provider/iishkoProvider.ts";

const PI_INSTANCE_ID = "pi" as ProviderInstanceId;
const PROFILE_TTL_MS = 60_000;
const TELEGRAM_BOT_URL = "https://t.me/iishkogatewaybot";
const PAIRING_UNAVAILABLE_STATUSES = new Set([401, 403, 404, 405, 501]);
const MAX_PENDING_PAIRINGS = 4;

interface AccountMetadata {
  readonly source: IishkoAccountSource;
  readonly username: string | null;
  readonly displayName: string | null;
  readonly keyHint: string;
  readonly connectedAt: string;
}

interface PendingPairing {
  readonly backendPairId: string;
  readonly expiresAt: number;
  failures: number;
  nextPollAt: number;
}

export interface IishkoAccountDeps {
  readonly stateDir: string;
  readonly readSettings: () => Promise<ServerSettings>;
  readonly updateSettings: (
    derive: (current: ServerSettings) => ServerSettingsPatch,
  ) => Promise<void>;
  readonly refreshProviders: () => Promise<void>;
  readonly appVersion?: string | undefined;
  readonly env?: NodeJS.ProcessEnv | undefined;
  readonly request?: typeof outboundHttp.request | undefined;
  readonly now?: (() => number) | undefined;
}

export interface IishkoAccount {
  readonly status: () => Promise<IishkoAccountStatus>;
  readonly beginTelegramPairing: () => Promise<IishkoTelegramPairingStart>;
  readonly pollTelegramPairing: (input: {
    readonly pairingId: string;
  }) => Promise<IishkoTelegramPairingPoll>;
  readonly cancelTelegramPairing: (input: { readonly pairingId: string }) => Promise<void>;
  readonly connectApiKey: (input: { readonly apiKey: string }) => Promise<IishkoAccountStatus>;
  readonly profile: () => Promise<IishkoProfile>;
  readonly signOut: () => Promise<void>;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function text(value: unknown, maxLength = 200): string | null {
  return typeof value === "string" && value.trim() && value.trim().length <= maxLength
    ? value.trim()
    : null;
}

export function iishkoKeyHint(apiKey: string): string {
  return `…${apiKey.slice(-4)}`;
}

function readEnvironmentValue(settings: ServerSettings, name: string): string | undefined {
  const variable = settings.providerInstances[PI_INSTANCE_ID]?.environment?.find(
    (entry) => entry.name === name,
  );
  return variable?.value?.trim() || undefined;
}

const readConfiguredKey = (settings: ServerSettings) =>
  readEnvironmentValue(settings, IISHKO_API_KEY_ENV);
// The device token never lives in a provider environment; it is read from the server-side store.
const readDeviceToken = () => readIishkoDeviceToken();

function safeJson(response: Parameters<typeof decodeOutboundJson>[0]): unknown {
  try {
    return decodeOutboundJson(response, { maxDepth: 6, maxNodes: 200 });
  } catch {
    return undefined;
  }
}

function networkError(message: string): WsRpcError {
  return new WsRpcError({ message, code: IISHKO_ACCOUNT_ERROR_CODES.network });
}

const deviceName = (): string => {
  const name = hostname().trim().slice(0, 64);
  return name || "Компьютер";
};

const num = (value: unknown): number | undefined => {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
};
/** Tiers are numbers on the wire; the contract keeps them as strings. */
const tierText = (value: unknown): string | undefined => {
  const number = num(value);
  return number !== undefined ? String(number) : str(value, 64);
};
/** Gateway times are unix seconds (numeric strings allowed); an ISO string passes through. */
const isoFromSeconds = (value: unknown): string | undefined => {
  const seconds = num(value);
  if (seconds !== undefined) return new Date(seconds * 1000).toISOString();
  const parsed = typeof value === "string" ? Date.parse(value) : Number.NaN;
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : undefined;
};
const str = (value: unknown, max = 256): string | undefined => text(value, max) ?? undefined;
const opt = (key: string, value: unknown) => (value === undefined ? {} : { [key]: value });

function modelRefs(value: unknown): Array<{ id: string; title?: string; minTier?: string }> {
  if (!Array.isArray(value)) return [];
  const refs: Array<{ id: string; title?: string; minTier?: string }> = [];
  for (const entry of value.slice(0, 500)) {
    const item = record(entry);
    const id = str(item?.id, 200);
    if (!id) continue;
    const title = str(item?.title, 200);
    const minTier = tierText(item?.min_tier);
    refs.push({ id, ...(title ? { title } : {}), ...(minTier ? { minTier } : {}) });
  }
  return refs;
}

/** Maps the gateway profile to the contract; only user, rank and models are required. */
export function parseIishkoProfile(
  payload: Record<string, unknown>,
  fetchedAt: string,
): IishkoProfile | null {
  const user = record(payload.user);
  const rank = record(payload.rank);
  const tier = tierText(rank?.tier);
  const title = str(rank?.title, 128);
  const models = record(payload.models);
  if (!user || !rank || !tier || !title || !models) return null;
  const next = record(rank.next);
  const nextTier = tierText(next?.tier);
  const nextTitle = str(next?.title, 128);
  const limits = record(payload.limits);
  const premium = Array.isArray(limits?.premium)
    ? limits.premium.flatMap((entry: unknown) => {
        const item = record(entry);
        const name = str(item?.name, 128);
        const used = num(item?.used);
        const limit = num(item?.limit);
        return name && used !== undefined && limit !== undefined ? [{ name, used, limit }] : [];
      })
    : [];
  const balance = record(payload.balance);
  const ideOnly = record(payload.ide_only);
  const device = record(payload.device);
  const deviceName = str(device?.name, 128);
  return {
    user: {
      ...opt("username", str(user.username, 64)),
      ...opt("firstName", str(user.first_name, 128)),
      ...opt("photoUrl", str(user.photo_url, 512)),
    },
    rank: {
      tier,
      title,
      ...opt("emoji", str(rank.emoji, 16)),
      ...(nextTier && nextTitle ? { next: { tier: nextTier, title: nextTitle } } : {}),
    },
    ...(limits
      ? {
          limits: {
            ...opt("requestsToday", num(limits.requests_today)),
            ...opt("requestsLimit", num(limits.requests_limit)),
            ...opt("resetAt", isoFromSeconds(limits.reset_at)),
            ...(premium.length > 0 ? { premium } : {}),
            ...opt("dailyUsdCap", num(limits.daily_usd_cap)),
            ...opt("dailyUsdUsed", num(limits.daily_usd_used)),
            ...opt("rpm", num(limits.rpm)),
            ...opt("concurrency", num(limits.concurrency)),
          },
        }
      : {}),
    ...(balance
      ? {
          balance: {
            ...opt("usd", num(balance.usd)),
            ...opt("weeklyCreditUsd", num(balance.weekly_credit_usd)),
          },
        }
      : {}),
    models: {
      available: modelRefs(models.available).map(({ id, title }) => ({
        id,
        ...(title ? { title } : {}),
      })),
      locked: modelRefs(models.locked).flatMap(({ id, title, minTier }) =>
        minTier ? [{ id, minTier, ...(title ? { title } : {}) }] : [],
      ),
    },
    ...(ideOnly && typeof ideOnly.applies === "boolean"
      ? {
          ideOnly: {
            applies: ideOnly.applies,
            ...opt("enforcedFrom", isoFromSeconds(ideOnly.enforced_from)),
          },
        }
      : {}),
    ...(deviceName
      ? { device: { name: deviceName, ...opt("createdAt", isoFromSeconds(device?.created_at)) } }
      : {}),
    fetchedAt,
  } as IishkoProfile;
}

export function makeIishkoAccount(deps: IishkoAccountDeps): IishkoAccount {
  const env = deps.env ?? process.env;
  const now = deps.now ?? Date.now;
  const request = deps.request ?? outboundHttp.request.bind(outboundHttp);
  const accountDir = join(deps.stateDir, "iishko");
  const metadataPath = join(accountDir, "account.json");
  setIishkoDeviceTokenPath(join(accountDir, "device.json"));
  const pending = new Map<string, PendingPairing>();
  let profileCache:
    | { readonly deviceKey: string; readonly at: number; readonly value: IishkoProfile }
    | undefined;

  const readMetadata = async (): Promise<AccountMetadata | undefined> => {
    try {
      const value = record(JSON.parse(await readFile(metadataPath, "utf8")));
      if (!value) return undefined;
      const source = value.source === "telegram" ? "telegram" : "manual";
      const keyHint = text(value.keyHint, 16);
      const connectedAt = text(value.connectedAt, 40);
      if (!keyHint || !connectedAt) return undefined;
      return {
        source,
        username: text(value.username, 64),
        displayName: text(value.displayName, 128),
        keyHint,
        connectedAt,
      };
    } catch {
      return undefined;
    }
  };

  const writeMetadata = async (metadata: AccountMetadata): Promise<void> => {
    await mkdir(accountDir, { recursive: true, mode: 0o700 });
    await writeFile(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, { mode: 0o600 });
    await chmod(metadataPath, 0o600).catch(() => undefined);
  };

  const writeCredentials = async (
    credentials: {
      readonly apiKey?: string | undefined;
      readonly deviceToken?: string | undefined;
    },
    modelIds: ReadonlyArray<string>,
  ) => {
    // The long-lived device token is kept out of every process environment.
    await writeIishkoDeviceToken(credentials.deviceToken ?? null);
    return deps.updateSettings((current) => {
      const existing = current.providerInstances[PI_INSTANCE_ID];
      const kept = (existing?.environment ?? []).filter(
        (entry) =>
          entry.name !== IISHKO_API_KEY_ENV &&
          entry.name !== IISHKO_DEVICE_TOKEN_ENV &&
          entry.name !== LEGACY_IISHKO_DEVICE_TOKEN_ENV,
      );
      const environment = [
        ...kept,
        ...(credentials.apiKey
          ? [{ name: IISHKO_API_KEY_ENV, value: credentials.apiKey, sensitive: true }]
          : []),
      ];
      const { environment: _previous, ...rest } = existing ?? { driver: "pi" as const };
      const selection = current.newThreadDefaults.modelSelectionByProvider[PI_INSTANCE_ID];
      const slugs = modelIds.map((id) => `${IISHKO_PROVIDER_ID}/${id}`);
      const preferred = slugs[0];
      const signedIn = Boolean(credentials.apiKey || credentials.deviceToken);
      const selectionPatch: Record<string, unknown> | null | undefined =
        signedIn && preferred && (!selection || !slugs.includes(selection.model))
          ? { provider: "pi", instanceId: PI_INSTANCE_ID, model: preferred }
          : !signedIn && selection?.model.startsWith(`${IISHKO_PROVIDER_ID}/`)
            ? undefined
            : null;
      return {
        providerInstances: {
          ...current.providerInstances,
          [PI_INSTANCE_ID]: { ...rest, ...(environment.length > 0 ? { environment } : {}) },
        },
        ...(selectionPatch !== null
          ? {
              newThreadDefaults: {
                ...current.newThreadDefaults,
                modelSelectionByProvider: {
                  ...current.newThreadDefaults.modelSelectionByProvider,
                  [PI_INSTANCE_ID]: selectionPatch,
                },
                ...(signedIn && current.newThreadDefaults.activeProvider === null
                  ? { activeProvider: PI_INSTANCE_ID }
                  : {}),
              },
            }
          : {}),
      } as ServerSettingsPatch;
    });
  };

  /** Moves a device token found in a provider environment into the server-side store. */
  const migrateLegacyDeviceToken = async (): Promise<void> => {
    const current = await deps.readSettings();
    const found =
      readEnvironmentValue(current, IISHKO_DEVICE_TOKEN_ENV) ??
      readEnvironmentValue(current, LEGACY_IISHKO_DEVICE_TOKEN_ENV);
    if (found === undefined) return;
    if ((await readIishkoDeviceToken()) === undefined) await writeIishkoDeviceToken(found);
    await deps.updateSettings((settings) => {
      const existing = settings.providerInstances[PI_INSTANCE_ID];
      const environment = (existing?.environment ?? []).filter(
        (entry) =>
          entry.name !== IISHKO_DEVICE_TOKEN_ENV && entry.name !== LEGACY_IISHKO_DEVICE_TOKEN_ENV,
      );
      const { environment: _previous, ...rest } = existing ?? { driver: "pi" as const };
      return {
        providerInstances: {
          ...settings.providerInstances,
          [PI_INSTANCE_ID]: { ...rest, ...(environment.length > 0 ? { environment } : {}) },
        },
      } as ServerSettingsPatch;
    });
    await deps.refreshProviders().catch(() => undefined);
  };

  const status = async (): Promise<IishkoAccountStatus> => {
    await migrateLegacyDeviceToken();
    const settings = await deps.readSettings();
    const deviceToken = await readDeviceToken();
    const key = readConfiguredKey(settings);
    if (!deviceToken && !key) return { state: "disconnected" };
    const metadata = await readMetadata();
    const account = {
      username: metadata?.username ?? null,
      displayName: metadata?.displayName ?? null,
    };
    if (deviceToken && isIishkoDeviceRevoked(deviceToken) && !key) {
      return { state: "revoked", account };
    }
    return {
      state: "connected",
      source: deviceToken ? "telegram" : (metadata?.source ?? "manual"),
      account,
      keyHint: metadata?.keyHint ?? iishkoKeyHint(deviceToken ?? key ?? ""),
      connectedAt: metadata?.connectedAt ?? new Date(0).toISOString(),
    };
  };

  /** Validates the credential against `/models` before anything is stored. */
  let connectChain: Promise<unknown> = Promise.resolve();
  const serialized = <T>(task: () => Promise<T>): Promise<T> => {
    const run = connectChain.then(task, task);
    connectChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };

  const connectUnserialized = async (
    credential: { readonly apiKey?: string; readonly deviceToken?: string },
    source: IishkoAccountSource,
    identity: { readonly username: string | null; readonly displayName: string | null },
  ): Promise<IishkoAccountStatus> => {
    let models;
    try {
      const gatewayKey = credential.deviceToken
        ? await getIishkoSessionToken(credential.deviceToken, {
            env,
            request,
            now,
            forceRefresh: true,
          })
        : credential.apiKey!;
      models = await loadIishkoModels(gatewayKey, {
        baseUrl: resolveIishkoBaseUrl(
          env,
          credential.deviceToken ? getIishkoSessionBaseUrl(credential.deviceToken) : undefined,
        ),
        request,
        forceRefresh: true,
      });
    } catch (cause) {
      if (cause instanceof IishkoAuthError || cause instanceof IishkoDeviceRevokedError) {
        throw new WsRpcError({
          message: "The IISHKO gateway did not accept this credential.",
          code: IISHKO_ACCOUNT_ERROR_CODES.invalidKey,
        });
      }
      throw networkError("Could not reach the IISHKO gateway.");
    }
    const modelIds = models.map((model) => model.id);
    const ordered = [
      ...IISHKO_PREFERRED_MODEL_IDS.filter((id) => modelIds.includes(id)),
      ...modelIds.filter((id) => !IISHKO_PREFERRED_MODEL_IDS.includes(id)),
    ];
    await writeCredentials(credential, ordered);
    profileCache = undefined;
    const metadata: AccountMetadata = {
      source,
      username: identity.username,
      displayName: identity.displayName,
      keyHint: iishkoKeyHint(credential.deviceToken ?? credential.apiKey ?? ""),
      connectedAt: new Date(now()).toISOString(),
    };
    await writeMetadata(metadata);
    await deps.refreshProviders().catch(() => undefined);
    return {
      state: "connected",
      source,
      account: identity,
      keyHint: metadata.keyHint,
      connectedAt: metadata.connectedAt,
    };
  };

  const connect: typeof connectUnserialized = (...args) =>
    serialized(() => connectUnserialized(...args));

  const accountRequest = async (
    path: string,
    init: { readonly body?: unknown; readonly deviceToken?: string; readonly service: string },
  ) => {
    const base = resolveIishkoAccountApiBase(env);
    const response = await request({
      url: `${base}/${path}`,
      method: "POST" as const,
      headers: {
        accept: "application/json",
        ...(init.body !== undefined ? { "content-type": "application/json" } : {}),
        ...(init.deviceToken ? deviceHeaders(init.deviceToken) : {}),
      },
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
      policy: iishkoAccountRequestPolicy(base, init.service),
    });
    const payload =
      response.status === 200
        ? record(decodeOutboundJson(response, { maxDepth: 10, maxNodes: 5_000 }))
        : undefined;
    return {
      status: response.status,
      payload,
      retryAfter: num(record(safeJson(response))?.retry_after),
    };
  };

  const postPairing = (path: "start" | "poll", body: unknown) =>
    accountRequest(`pair/${path}`, { body, service: "iishko-pairing" });

  const accountGet = async (path: string, deviceToken: string, service: string) => {
    const base = resolveIishkoAccountApiBase(env);
    const response = await request({
      url: `${base}/${path}`,
      method: "GET",
      headers: deviceHeaders(deviceToken),
      policy: iishkoAccountRequestPolicy(base, service),
    });
    return {
      status: response.status,
      payload:
        response.status === 200
          ? record(decodeOutboundJson(response, { maxDepth: 10, maxNodes: 5_000 }))
          : undefined,
    };
  };

  const pruneExpired = () => {
    for (const [id, pairing] of pending) {
      if (pairing.expiresAt <= now()) pending.delete(id);
    }
  };

  return {
    status,

    beginTelegramPairing: async () => {
      pruneExpired();
      let result;
      try {
        result = await postPairing("start", {
          client: "iishko-ide",
          version: deps.appVersion ?? "1.0.0",
          device: deviceName(),
          platform: process.platform,
        });
      } catch {
        throw networkError("Could not reach the IISHKO pairing service.");
      }
      if (PAIRING_UNAVAILABLE_STATUSES.has(result.status)) {
        return {
          state: "unavailable",
          message: "Telegram sign-in is not available yet. Paste an API key instead.",
        };
      }
      const payload = result.payload;
      const backendPairId = text(payload?.pair_id, 256);
      const code = text(payload?.code, 32);
      const expiresIn = payload?.expires_in;
      if (!payload || !backendPairId || !code || typeof expiresIn !== "number" || expiresIn <= 0) {
        throw networkError(
          result.status === 429
            ? `Too many sign-in attempts. Try again in ${result.retryAfter ?? 60} s.`
            : "The IISHKO pairing service returned an unexpected answer.",
        );
      }
      const botUrl = text(payload.link, 512);
      const interval = typeof payload.interval === "number" ? payload.interval : 2;
      const expiresAt = now() + Math.min(expiresIn, 900) * 1000;
      while (pending.size >= MAX_PENDING_PAIRINGS) {
        pending.delete(pending.keys().next().value!);
      }
      const pairingId = randomUUID();
      pending.set(pairingId, { backendPairId, expiresAt, failures: 0, nextPollAt: 0 });
      return {
        state: "started",
        pairingId,
        code,
        // Only the IISHKO bot may be opened from this flow.
        botUrl: botUrl?.startsWith(`${TELEGRAM_BOT_URL}?start=`) ? botUrl : TELEGRAM_BOT_URL,
        expiresAt: new Date(expiresAt).toISOString(),
        pollIntervalMs: Math.min(Math.max(interval, 1), 10) * 1000,
      };
    },

    pollTelegramPairing: async ({ pairingId }) => {
      pruneExpired();
      const pairing = pending.get(pairingId);
      if (!pairing) return { state: "expired" };
      if (now() < pairing.nextPollAt) return { state: "pending" };
      const backOff = (retryAfterSeconds?: number) => {
        pairing.failures += 1;
        const exponential = Math.min(1000 * 2 ** pairing.failures, 30_000);
        pairing.nextPollAt =
          now() + Math.min(Math.max(exponential, (retryAfterSeconds ?? 0) * 1000), 30_000);
      };
      let result;
      try {
        result = await postPairing("poll", { pair_id: pairing.backendPairId });
      } catch {
        // A transient failure keeps the attempt alive until it expires.
        backOff();
        return { state: "pending" };
      }
      if (result.status === 200) pairing.failures = 0;
      else if (result.status !== 404 && result.status !== 410) backOff(result.retryAfter);
      const state = text(result.payload?.status, 32);
      if (result.status !== 200 || state === "pending" || state === null) {
        if (result.status === 404 || result.status === 410) {
          pending.delete(pairingId);
          return { state: "expired" };
        }
        return { state: "pending" };
      }
      if (state === "approved") {
        const deviceToken = text(result.payload?.device_token, 1024);
        pending.delete(pairingId);
        if (!deviceToken)
          throw networkError("The IISHKO pairing service returned no device token.");
        const account = record(result.payload?.account);
        const status = await connect({ deviceToken }, "telegram", {
          username: text(account?.username, 64),
          displayName: text(account?.first_name, 128),
        });
        return { state: "connected", status };
      }
      pending.delete(pairingId);
      return state === "denied" ? { state: "denied" } : { state: "expired" };
    },

    cancelTelegramPairing: async ({ pairingId }) => {
      pending.delete(pairingId);
    },

    connectApiKey: async ({ apiKey }) => {
      const staleDevice = await readDeviceToken();
      const status = await connect({ apiKey: apiKey.trim() }, "manual", {
        username: null,
        displayName: null,
      });
      if (staleDevice) forgetIishkoSession(staleDevice);
      return status;
    },

    profile: async () => {
      const deviceToken = await readDeviceToken();
      if (!deviceToken) {
        throw new WsRpcError({
          message: "Sign in with Telegram to see the IISHKO profile.",
          code: IISHKO_ACCOUNT_ERROR_CODES.invalidKey,
        });
      }
      if (
        profileCache &&
        profileCache.deviceKey === deviceToken &&
        now() - profileCache.at < PROFILE_TTL_MS
      ) {
        return profileCache.value;
      }
      let result;
      try {
        result = await accountGet("profile", deviceToken, "iishko-profile");
      } catch {
        if (profileCache?.deviceKey === deviceToken) return profileCache.value;
        throw networkError("Could not reach the IISHKO profile service.");
      }
      if (result.status === 401) {
        markIishkoDeviceRevoked(deviceToken);
        throw new WsRpcError({
          message: "The IISHKO device session was revoked.",
          code: IISHKO_ACCOUNT_ERROR_CODES.revoked,
        });
      }
      const value = result.payload
        ? parseIishkoProfile(result.payload, new Date(now()).toISOString())
        : null;
      if (!value) {
        if (profileCache?.deviceKey === deviceToken) return profileCache.value;
        throw networkError("The IISHKO profile service returned an unexpected answer.");
      }
      profileCache = { deviceKey: deviceToken, at: now(), value };
      return value;
    },

    signOut: async () => {
      pending.clear();
      const deviceToken = await readDeviceToken();
      if (deviceToken) {
        await accountRequest("signout", { deviceToken, service: "iishko-signout" }).catch(
          () => undefined,
        );
        forgetIishkoSession(deviceToken);
      }
      profileCache = undefined;
      await writeCredentials({}, []);
      await rm(metadataPath, { force: true });
      await rm(join(accountDir, "models-cache.json"), { force: true });
      clearIishkoModelCache();
      await deps.refreshProviders().catch(() => undefined);
    },
  };
}
