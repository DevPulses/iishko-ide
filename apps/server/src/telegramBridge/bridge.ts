// FILE: bridge.ts
// Purpose: Drives the IDE from the user's own Telegram bot: long-poll, owner binding, commands.
// Layer: Server Telegram bridge service
//
// Orchestration goes through `TelegramOrchestrationPort`, whose real implementation calls the
// same OrchestrationEngine dispatch and projection reads the WS RPC handlers use. No message
// content, token or URL is logged here.

import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  TELEGRAM_BRIDGE_ERROR_CODES,
  type TelegramBridgeActionInput,
  type TelegramBridgeStatus,
  WsRpcError,
} from "@iishko/contracts";
import type { outboundHttp } from "@iishko/shared/outboundHttp";

import { escapeTelegramHtml, renderTelegramHtml, splitTelegramText } from "./format.ts";
import { makeTelegramApi, type TelegramApi } from "./telegramApi.ts";

export interface TelegramThreadSnapshot {
  readonly assistantText: string;
  readonly running: boolean;
  readonly pendingApprovals: ReadonlyArray<{
    readonly requestId: string;
    readonly summary: string;
  }>;
  readonly failure?: string | undefined;
}

export interface TelegramOrchestrationPort {
  readonly listProjects: () => Promise<ReadonlyArray<{ id: string; title: string }>>;
  readonly listThreads: (
    limit: number,
  ) => Promise<ReadonlyArray<{ id: string; title: string; projectId: string }>>;
  readonly listModels: () => Promise<ReadonlyArray<{ slug: string; label: string }>>;
  readonly createThread: (input: {
    readonly projectId: string | null;
    readonly title: string;
    readonly model: string | null;
  }) => Promise<string>;
  readonly startTurn: (input: {
    readonly threadId: string;
    readonly text: string;
    readonly model: string | null;
  }) => Promise<void>;
  readonly interrupt: (threadId: string) => Promise<void>;
  readonly respondApproval: (input: {
    readonly threadId: string;
    readonly requestId: string;
    readonly decision: "accept" | "decline";
  }) => Promise<void>;
  readonly readThread: (threadId: string) => Promise<TelegramThreadSnapshot | null>;
}

export interface TelegramBridgeDeps {
  readonly stateDir: string;
  readonly readToken: () => Promise<string | undefined>;
  readonly writeToken: (token: string | null) => Promise<void>;
  readonly port: TelegramOrchestrationPort;
  readonly env?: NodeJS.ProcessEnv | undefined;
  readonly request?: typeof outboundHttp.request | undefined;
  readonly now?: (() => number) | undefined;
  readonly sleep?: ((ms: number) => Promise<void>) | undefined;
  readonly editIntervalMs?: number | undefined;
  readonly watchIntervalMs?: number | undefined;
  readonly pollTimeoutSec?: number | undefined;
  readonly deadManMs?: number | undefined;
  readonly bindCodeTtlMs?: number | undefined;
}

interface OwnerContext {
  projectId: string | null;
  threadId: string | null;
  model: string | null;
}

interface PersistedState {
  enabled: boolean;
  botUsername: string | null;
  ownerId: number | null;
  ownerName: string | null;
  bindCode: string | null;
  bindCodeExpiresAt: number | null;
  owner: OwnerContext;
}

export interface TelegramBridge {
  readonly status: () => Promise<TelegramBridgeStatus>;
  readonly action: (input: TelegramBridgeActionInput) => Promise<TelegramBridgeStatus>;
  readonly start: () => Promise<void>;
  readonly stop: () => Promise<void>;
}

const PRIVATE_BOT = "Это приватный бот";
const WORKING = "⏳ Работаю…";
const HELP = [
  "/new — новый чат",
  "/projects — выбрать проект",
  "/threads — последние чаты",
  "/model — выбрать модель",
  "/stop — остановить ответ",
  "/status — текущее состояние",
  "/help — эта справка",
].join("\n");
const COMMANDS = [
  { command: "new", description: "Новый чат" },
  { command: "projects", description: "Выбрать проект" },
  { command: "threads", description: "Последние чаты" },
  { command: "model", description: "Выбрать модель" },
  { command: "stop", description: "Остановить ответ" },
  { command: "status", description: "Текущее состояние" },
  { command: "help", description: "Справка" },
];

type Json = Record<string, unknown>;
const rec = (value: unknown): Json | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Json)
    : undefined;

export function makeTelegramBridge(deps: TelegramBridgeDeps): TelegramBridge {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const editIntervalMs = deps.editIntervalMs ?? 1500;
  const watchIntervalMs = deps.watchIntervalMs ?? 700;
  const pollTimeoutSec = deps.pollTimeoutSec ?? 30;
  const dir = join(deps.stateDir, "telegram-bridge");
  const statePath = join(dir, "state.json");

  let state: PersistedState = {
    enabled: false,
    botUsername: null,
    ownerId: null,
    ownerName: null,
    bindCode: null,
    bindCodeExpiresAt: null,
    owner: { projectId: null, threadId: null, model: null },
  };
  let loaded = false;
  let runtime: "off" | "running" | "error" = "off";
  let reason: string | null = null;
  let lastActivityAt: number | null = null;
  let abort: AbortController | null = null;
  let loop: Promise<void> | null = null;
  const running = new Map<string, AbortController>();
  const sentApprovals = new Set<string>();
  const approvalThreads = new Map<string, string>();
  let bindFailures = 0;
  const deadManMs = deps.deadManMs ?? 60_000;
  const bindCodeTtlMs = deps.bindCodeTtlMs ?? 10 * 60_000;
  const MAX_TRACKED_APPROVALS = 500;

  const issueBindCode = () => {
    state.bindCode = randomBytes(6).toString("hex");
    state.bindCodeExpiresAt = now() + bindCodeTtlMs;
    bindFailures = 0;
  };
  const rememberApproval = (requestId: string, threadId: string) => {
    if (sentApprovals.size >= MAX_TRACKED_APPROVALS) {
      sentApprovals.clear();
      approvalThreads.clear();
    }
    sentApprovals.add(requestId);
    approvalThreads.set(requestId, threadId);
  };

  const load = async () => {
    if (loaded) return;
    loaded = true;
    try {
      const parsed = rec(JSON.parse(await readFile(statePath, "utf8")));
      if (parsed) {
        const owner = rec(parsed.owner);
        state = {
          enabled: parsed.enabled === true,
          botUsername: typeof parsed.botUsername === "string" ? parsed.botUsername : null,
          ownerId: typeof parsed.ownerId === "number" ? parsed.ownerId : null,
          ownerName: typeof parsed.ownerName === "string" ? parsed.ownerName : null,
          bindCode: typeof parsed.bindCode === "string" ? parsed.bindCode : null,
          bindCodeExpiresAt:
            typeof parsed.bindCodeExpiresAt === "number" ? parsed.bindCodeExpiresAt : null,
          owner: {
            projectId: typeof owner?.projectId === "string" ? owner.projectId : null,
            threadId: typeof owner?.threadId === "string" ? owner.threadId : null,
            model: typeof owner?.model === "string" ? owner.model : null,
          },
        };
      }
    } catch {
      // First run, or an unreadable file: start from the empty state.
    }
  };

  const save = async () => {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const temp = `${statePath}.${process.pid}.tmp`;
    await writeFile(temp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    await chmod(temp, 0o600).catch(() => undefined);
    await rename(temp, statePath);
  };

  const status = async (): Promise<TelegramBridgeStatus> => {
    await load();
    const hasToken = (await deps.readToken()) !== undefined;
    if (
      state.ownerId === null &&
      hasToken &&
      (state.bindCode === null || (state.bindCodeExpiresAt ?? 0) <= now())
    ) {
      issueBindCode();
      await save();
    }
    return {
      state: !hasToken || !state.enabled ? "off" : runtime === "running" ? "running" : runtime,
      hasToken,
      enabled: state.enabled,
      botUsername: state.botUsername,
      ownerName: state.ownerName,
      bindCode: state.ownerId === null ? state.bindCode : null,
      reason: runtime === "error" ? reason : null,
      lastActivityAt: lastActivityAt ? new Date(lastActivityAt).toISOString() : null,
    };
  };

  const send = async (
    api: TelegramApi,
    chatId: number,
    text: string,
    extra: Json = {},
  ): Promise<number | null> => {
    const html = await api.call<{ message_id: number }>("sendMessage", {
      chat_id: chatId,
      text: renderTelegramHtml(text),
      parse_mode: "HTML",
      ...extra,
    });
    if (html.ok) return html.result?.message_id ?? null;
    const plain = await api.call<{ message_id: number }>("sendMessage", {
      chat_id: chatId,
      text,
      ...extra,
    });
    return plain.ok ? (plain.result?.message_id ?? null) : null;
  };

  const edit = async (api: TelegramApi, chatId: number, messageId: number, text: string) => {
    const html = await api.call("editMessageText", {
      chat_id: chatId,
      message_id: messageId,
      text: renderTelegramHtml(text),
      parse_mode: "HTML",
    });
    if (html.ok || html.description?.includes("not modified")) return;
    await api.call("editMessageText", { chat_id: chatId, message_id: messageId, text });
  };

  const ensureThread = async (): Promise<string> => {
    if (state.owner.threadId) return state.owner.threadId;
    const threadId = await deps.port.createThread({
      projectId: state.owner.projectId,
      title: "Telegram",
      model: state.owner.model,
    });
    state.owner.threadId = threadId;
    await save();
    return threadId;
  };

  const deliverReply = async (
    api: TelegramApi,
    chatId: number,
    placeholder: number | null,
    text: string,
  ) => {
    const chunks = splitTelegramText(text.trim() || "…");
    let first = true;
    for (const chunk of chunks) {
      if (first && placeholder !== null) await edit(api, chatId, placeholder, chunk);
      else await send(api, chatId, chunk);
      first = false;
    }
  };

  const runTurn = async (api: TelegramApi, chatId: number, text: string) => {
    const threadId = await ensureThread();
    const placeholder = await send(api, chatId, WORKING);
    const controller = new AbortController();
    running.set(threadId, controller);
    try {
      await deps.port.startTurn({ threadId, text, model: state.owner.model });
      const startedAt = now();
      let lastEdit = 0;
      let lastShown = "";
      let seenRunning = false;
      for (;;) {
        if (controller.signal.aborted) {
          if (placeholder !== null) await edit(api, chatId, placeholder, "⏹ Остановлено");
          return;
        }
        const snapshot = await deps.port.readThread(threadId);
        if (!snapshot) break;
        lastActivityAt = now();
        for (const approval of snapshot.pendingApprovals) {
          if (sentApprovals.has(approval.requestId)) continue;
          rememberApproval(approval.requestId, threadId);
          await send(api, chatId, `Нужно разрешение:\n${approval.summary}`, {
            reply_markup: {
              inline_keyboard: [
                [
                  { text: "Разрешить", callback_data: `ap:y:${approval.requestId}` },
                  { text: "Отклонить", callback_data: `ap:n:${approval.requestId}` },
                ],
              ],
            },
          });
        }
        if (snapshot.running) seenRunning = true;
        if (!seenRunning && !snapshot.assistantText && now() - startedAt >= deadManMs) {
          const failure = "⚠️ Не удалось запустить задачу — попробуйте ещё раз";
          if (placeholder !== null) await edit(api, chatId, placeholder, failure);
          else await send(api, chatId, failure);
          return;
        }
        if (snapshot.failure) {
          await deliverReply(api, chatId, placeholder, `⚠️ ${snapshot.failure}`);
          return;
        }
        if (!snapshot.running && (seenRunning || snapshot.assistantText)) {
          await deliverReply(api, chatId, placeholder, snapshot.assistantText);
          return;
        }
        const shown = splitTelegramText(snapshot.assistantText)[0] ?? "";
        if (
          placeholder !== null &&
          shown &&
          shown !== lastShown &&
          now() - lastEdit >= editIntervalMs
        ) {
          lastEdit = now();
          lastShown = shown;
          await edit(api, chatId, placeholder, shown);
        }
        await sleep(watchIntervalMs);
      }
    } finally {
      running.delete(threadId);
    }
  };

  const keyboard = (rows: ReadonlyArray<{ text: string; data: string }>) => ({
    reply_markup: {
      inline_keyboard: rows.map((row) => [{ text: row.text, callback_data: row.data }]),
    },
  });

  const statusText = async (): Promise<string> => {
    const model = state.owner.model ?? "по умолчанию";
    const threads = await deps.port.listThreads(50).catch(() => []);
    const thread = state.owner.threadId
      ? (threads.find((candidate) => candidate.id === state.owner.threadId)?.title ?? "текущий чат")
      : "нет";
    const projects = await deps.port.listProjects().catch(() => []);
    const project = projects.find((p) => p.id === state.owner.projectId)?.title ?? "без проекта";
    const busy = state.owner.threadId && running.has(state.owner.threadId) ? "работает" : "ожидает";
    return `Проект: ${project}\nЧат: ${thread}\nМодель: ${model}\nСостояние: ${busy}`;
  };

  const handleCommand = async (api: TelegramApi, chatId: number, command: string) => {
    switch (command) {
      case "help":
      case "start":
        await send(api, chatId, HELP);
        return;
      case "new":
        state.owner.threadId = null;
        await save();
        await send(api, chatId, "Новый чат создан. Напишите сообщение.");
        return;
      case "projects": {
        const projects = await deps.port.listProjects();
        await send(
          api,
          chatId,
          projects.length > 0 ? "Выберите проект:" : "Проектов пока нет.",
          projects.length > 0
            ? keyboard(projects.slice(0, 12).map((p) => ({ text: p.title, data: `pj:${p.id}` })))
            : {},
        );
        return;
      }
      case "threads": {
        const threads = await deps.port.listThreads(8);
        await send(
          api,
          chatId,
          threads.length > 0 ? "Последние чаты:" : "Чатов пока нет.",
          threads.length > 0
            ? keyboard(threads.map((t) => ({ text: t.title || t.id, data: `th:${t.id}` })))
            : {},
        );
        return;
      }
      case "model": {
        const models = await deps.port.listModels();
        await send(
          api,
          chatId,
          models.length > 0 ? "Выберите модель:" : "Модели недоступны.",
          models.length > 0
            ? keyboard(models.slice(0, 12).map((m) => ({ text: m.label, data: `md:${m.slug}` })))
            : {},
        );
        return;
      }
      case "stop": {
        const threadId = state.owner.threadId;
        if (threadId && running.has(threadId)) {
          running.get(threadId)?.abort();
          await deps.port.interrupt(threadId);
          await send(api, chatId, "Останавливаю…");
        } else await send(api, chatId, "Сейчас ничего не выполняется.");
        return;
      }
      case "status":
        await send(api, chatId, await statusText());
        return;
      default:
        await send(api, chatId, HELP);
    }
  };

  const handleCallback = async (api: TelegramApi, query: Json) => {
    const data = typeof query.data === "string" ? query.data : "";
    const id = typeof query.id === "string" ? query.id : "";
    const chatId = rec(rec(query.message)?.chat)?.id;
    let answer = "";
    if (data.startsWith("ap:")) {
      const [, flag, ...rest] = data.split(":");
      const requestId = rest.join(":");
      const threadId = approvalThreads.get(requestId);
      const stillPending =
        threadId !== undefined &&
        threadId === state.owner.threadId &&
        ((await deps.port.readThread(threadId).catch(() => null))?.pendingApprovals.some(
          (approval) => approval.requestId === requestId,
        ) ??
          false);
      if (threadId && requestId && stillPending) {
        await deps.port.respondApproval({
          threadId,
          requestId,
          decision: flag === "y" ? "accept" : "decline",
        });
        answer = flag === "y" ? "Разрешено" : "Отклонено";
      } else {
        answer = "Запрос уже неактуален";
      }
    } else if (data.startsWith("pj:")) {
      state.owner.projectId = data.slice(3);
      state.owner.threadId = null;
      await save();
      answer = "Проект выбран";
    } else if (data.startsWith("th:")) {
      state.owner.threadId = data.slice(3);
      await save();
      answer = "Чат выбран";
    } else if (data.startsWith("md:")) {
      state.owner.model = data.slice(3);
      await save();
      answer = "Модель выбрана";
    }
    await api.call("answerCallbackQuery", {
      callback_query_id: id,
      ...(answer ? { text: answer } : {}),
    });
    if (typeof chatId === "number" && answer && !data.startsWith("ap:")) {
      await send(api, chatId, answer);
    }
  };

  const handleUpdate = async (api: TelegramApi, update: Json) => {
    const callback = rec(update.callback_query);
    if (callback) {
      const from = rec(callback.from);
      if (typeof from?.id === "number" && from.id === state.ownerId) {
        await handleCallback(api, callback);
      } else if (typeof callback.id === "string") {
        await api.call("answerCallbackQuery", { callback_query_id: callback.id });
      }
      return;
    }
    const message = rec(update.message);
    const chat = rec(message?.chat);
    const from = rec(message?.from);
    if (!message || chat?.type !== "private" || typeof chat.id !== "number") return;
    const chatId = chat.id;
    const text = typeof message.text === "string" ? message.text : "";
    const fromId = typeof from?.id === "number" ? from.id : null;
    const startMatch = /^\/start(?:@\w+)?\s+(\S+)/u.exec(text);
    if (state.ownerId === null) {
      const codeValid =
        state.bindCode !== null &&
        (state.bindCodeExpiresAt ?? 0) > now() &&
        startMatch?.[1] === state.bindCode;
      if (startMatch && !codeValid) {
        bindFailures += 1;
        if (bindFailures >= 5 || (state.bindCodeExpiresAt ?? 0) <= now()) {
          issueBindCode();
          await save();
        }
      }
      if (startMatch && codeValid && fromId !== null) {
        state.ownerId = fromId;
        state.ownerName =
          [from?.first_name, from?.last_name].filter((v) => typeof v === "string").join(" ") ||
          (typeof from?.username === "string" ? from.username : null);
        state.bindCode = null;
        state.bindCodeExpiresAt = null;
        bindFailures = 0;
        await save();
        await send(api, chatId, "Готово: вы владелец этого бота.\n\n" + HELP);
      } else {
        await send(api, chatId, PRIVATE_BOT);
      }
      return;
    }
    if (fromId !== state.ownerId) {
      await send(api, chatId, PRIVATE_BOT);
      return;
    }
    lastActivityAt = now();
    const command = /^\/(\w+)(?:@\w+)?(?:\s|$)/u.exec(text)?.[1]?.toLowerCase();
    if (command) await handleCommand(api, chatId, command);
    else if (text.trim()) {
      if (state.owner.threadId && running.has(state.owner.threadId)) {
        await send(api, chatId, "Уже работаю над предыдущим сообщением. /stop — остановить.");
      } else {
        // Detached so /stop and approval buttons are still handled while the turn runs.
        void runTurn(api, chatId, text).catch(() =>
          send(api, chatId, "⚠️ Не удалось выполнить запрос — попробуйте ещё раз").catch(
            () => undefined,
          ),
        );
      }
    }
  };

  const poll = async (token: string, signal: AbortSignal) => {
    const api = makeTelegramApi({ token, env: deps.env, request: deps.request });
    let offset = 0;
    let backoff = 1000;
    let offsetReset = false;
    await api.call("setMyCommands", { commands: COMMANDS }).catch(() => undefined);
    runtime = "running";
    reason = null;
    while (!signal.aborted) {
      let result;
      try {
        result = await api.call<Array<Json>>(
          "getUpdates",
          { offset, timeout: pollTimeoutSec, allowed_updates: ["message", "callback_query"] },
          { timeoutMs: (pollTimeoutSec + 10) * 1000, signal },
        );
      } catch {
        if (signal.aborted) return;
        await sleep(backoff);
        backoff = Math.min(backoff * 2, 30_000);
        continue;
      }
      if (result.errorCode === 409) {
        runtime = "error";
        reason =
          "Другой экземпляр уже опрашивает этого бота (409). Остановите его и включите снова.";
        return;
      }
      if (!result.ok) {
        if (result.errorCode === 401) {
          runtime = "error";
          reason = "Telegram отклонил токен бота.";
          return;
        }
        if (
          !offsetReset &&
          result.errorCode !== undefined &&
          result.errorCode >= 400 &&
          result.errorCode < 500 &&
          result.errorCode !== 429
        ) {
          offsetReset = true;
          offset = 0;
        }
        await sleep(Math.max(backoff, (result.retryAfter ?? 0) * 1000));
        backoff = Math.min(backoff * 2, 30_000);
        continue;
      }
      backoff = 1000;
      for (const update of result.result ?? []) {
        if (typeof update.update_id === "number") offset = update.update_id + 1;
        try {
          await handleUpdate(api, update);
        } catch {
          // One bad update must not stop the poller; no content is logged.
        }
      }
    }
  };

  const stop = async () => {
    sentApprovals.clear();
    approvalThreads.clear();
    abort?.abort();
    abort = null;
    for (const controller of running.values()) controller.abort();
    await loop?.catch(() => undefined);
    loop = null;
    if (runtime === "running") runtime = "off";
  };

  const start = async () => {
    await load();
    const token = await deps.readToken();
    if (!token || !state.enabled || loop) return;
    abort = new AbortController();
    const signal = abort.signal;
    runtime = "running";
    loop = poll(token, signal)
      .catch(() => {
        runtime = "error";
        reason = "Не удалось связаться с Telegram.";
      })
      .finally(() => {
        loop = null;
      });
  };

  const validateToken = async (token: string): Promise<string> => {
    const api = makeTelegramApi({ token, env: deps.env, request: deps.request });
    let result;
    try {
      result = await api.call<{ username?: string }>("getMe", {}, { timeoutMs: 10_000 });
    } catch {
      throw new WsRpcError({
        message: "Could not reach Telegram.",
        code: TELEGRAM_BRIDGE_ERROR_CODES.network,
      });
    }
    const username = result.result?.username;
    if (!result.ok || !username) {
      throw new WsRpcError({
        message: "Telegram did not accept this bot token.",
        code: TELEGRAM_BRIDGE_ERROR_CODES.invalidToken,
      });
    }
    return username;
  };

  return {
    status,
    start,
    stop,
    action: async (input) => {
      await load();
      if (input.action === "setToken") {
        const token = input.token?.trim();
        if (!token) {
          throw new WsRpcError({
            message: "A bot token is required.",
            code: TELEGRAM_BRIDGE_ERROR_CODES.invalidToken,
          });
        }
        const username = await validateToken(token);
        await stop();
        await deps.writeToken(token);
        state = {
          ...state,
          botUsername: username,
          ownerId: null,
          ownerName: null,
          bindCode: null,
          bindCodeExpiresAt: null,
          enabled: true,
          owner: { projectId: null, threadId: null, model: null },
        };
        issueBindCode();
        runtime = "off";
        await save();
        await start();
      } else if (input.action === "newBindCode") {
        state.ownerId = null;
        state.ownerName = null;
        issueBindCode();
        await save();
      } else if (input.action === "setEnabled") {
        state.enabled = input.enabled === true;
        await save();
        if (state.enabled) await start();
        else await stop();
      } else if (input.action === "disconnect") {
        await stop();
        await deps.writeToken(null);
        state = {
          enabled: false,
          botUsername: null,
          ownerId: null,
          ownerName: null,
          bindCode: null,
          bindCodeExpiresAt: null,
          owner: { projectId: null, threadId: null, model: null },
        };
        runtime = "off";
        reason = null;
        await save();
      } else {
        throw new WsRpcError({
          message: "Unknown Telegram bridge action.",
          code: TELEGRAM_BRIDGE_ERROR_CODES.invalidToken,
        });
      }
      return status();
    },
  };
}

export { escapeTelegramHtml };
