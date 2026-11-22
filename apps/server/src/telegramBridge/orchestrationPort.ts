// FILE: orchestrationPort.ts
// Purpose: The real orchestration seam for the Telegram bridge.
// Layer: Server Telegram bridge
//
// Seam: `OrchestrationEngine.dispatch` (the command path wsRpc.ts and the agent gateway use for
// `thread.create`, `thread.turn.start`, `thread.turn.interrupt` and `thread.approval.respond`)
// and `ProjectionSnapshotQuery` reads (`getShellSnapshot`, `getThreadDetailById`).

import { randomUUID } from "node:crypto";

import {
  ApprovalRequestId,
  CommandId,
  MessageId,
  ProjectId,
  ThreadId,
  type ModelSelection,
  type OrchestrationCommand,
  type ServerSettings,
} from "@iishko/contracts";

import type { TelegramOrchestrationPort } from "./bridge.ts";

export interface TelegramPortDeps {
  readonly dispatch: (command: OrchestrationCommand) => Promise<unknown>;
  readonly getShell: () => Promise<{
    readonly projects: ReadonlyArray<{ id: string; title: string; kind?: string | undefined }>;
    readonly threads: ReadonlyArray<{
      id: string;
      projectId: string;
      title: string;
      updatedAt?: string | undefined;
      archivedAt?: string | null | undefined;
    }>;
  }>;
  readonly getThreadDetail: (threadId: string) => Promise<{
    readonly messages: ReadonlyArray<{
      role: string;
      text: string;
      streaming: boolean;
      turnId: string | null;
    }>;
    readonly session: { status: string; lastError: string | null } | null;
    readonly pendingInteractions?:
      | ReadonlyArray<{ interactionKind: string; requestId: string; status: string }>
      | undefined;
  } | null>;
  readonly readSettings: () => Promise<ServerSettings>;
  readonly listModelIds: () => Promise<ReadonlyArray<string>>;
}

const id = <T>(make: (value: string) => T) => make(randomUUID());
const nowIso = () => new Date().toISOString();

export function makeTelegramOrchestrationPort(deps: TelegramPortDeps): TelegramOrchestrationPort {
  const defaultSelection = async (model: string | null): Promise<ModelSelection> => {
    const settings = await deps.readSettings();
    const stored = settings.newThreadDefaults.modelSelectionByProvider.pi;
    return {
      provider: "pi",
      instanceId: "pi",
      model: model ?? stored?.model ?? "iishko/deepseek-v4-flash",
    } as ModelSelection;
  };

  return {
    listProjects: async () =>
      (await deps.getShell()).projects
        .filter((project) => project.kind === undefined || project.kind === "project")
        .map((project) => ({ id: project.id, title: project.title })),
    listThreads: async (limit) =>
      (await deps.getShell()).threads
        .filter((thread) => !thread.archivedAt)
        .toSorted((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""))
        .slice(0, limit)
        .map((thread) => ({ id: thread.id, title: thread.title, projectId: thread.projectId })),
    listModels: async () =>
      (await deps.listModelIds()).map((model) => ({ slug: `iishko/${model}`, label: model })),
    createThread: async ({ projectId, title, model }) => {
      const shell = await deps.getShell();
      const targetProject =
        projectId ??
        shell.projects.find((project) => project.kind === "chat")?.id ??
        shell.projects[0]?.id;
      if (!targetProject) throw new Error("No project is available for a Telegram chat.");
      const threadId = id(ThreadId.makeUnsafe);
      await deps.dispatch({
        type: "thread.create",
        commandId: id(CommandId.makeUnsafe),
        threadId,
        projectId: ProjectId.makeUnsafe(targetProject),
        title,
        modelSelection: await defaultSelection(model),
        runtimeMode: "approval-required",
        interactionMode: "default",
        envMode: "local",
        branch: null,
        worktreePath: null,
        createdAt: nowIso(),
      } as unknown as OrchestrationCommand);
      return threadId;
    },
    startTurn: async ({ threadId, text, model }) => {
      await deps.dispatch({
        type: "thread.turn.start",
        commandId: id(CommandId.makeUnsafe),
        threadId: ThreadId.makeUnsafe(threadId),
        message: {
          messageId: id(MessageId.makeUnsafe),
          role: "user",
          text,
          attachments: [],
        },
        modelSelection: await defaultSelection(model),
        dispatchMode: "queue",
        runtimeMode: "approval-required",
        interactionMode: "default",
        createdAt: nowIso(),
      } as unknown as OrchestrationCommand);
    },
    interrupt: async (threadId) => {
      await deps.dispatch({
        type: "thread.turn.interrupt",
        commandId: id(CommandId.makeUnsafe),
        threadId: ThreadId.makeUnsafe(threadId),
        requestedBy: "user",
        createdAt: nowIso(),
      } as unknown as OrchestrationCommand);
    },
    respondApproval: async ({ threadId, requestId, decision }) => {
      await deps.dispatch({
        type: "thread.approval.respond",
        commandId: id(CommandId.makeUnsafe),
        threadId: ThreadId.makeUnsafe(threadId),
        requestId: ApprovalRequestId.makeUnsafe(requestId),
        decision,
        createdAt: nowIso(),
      } as unknown as OrchestrationCommand);
    },
    readThread: async (threadId) => {
      const detail = await deps.getThreadDetail(threadId);
      if (!detail) return null;
      const assistant = detail.messages.filter((message) => message.role === "assistant");
      const last = assistant.at(-1);
      const status = detail.session?.status ?? "idle";
      const running = status === "running" || status === "starting" || last?.streaming === true;
      return {
        assistantText: last?.text ?? "",
        running,
        pendingApprovals: (detail.pendingInteractions ?? [])
          .filter((item) => item.interactionKind === "approval" && item.status === "pending")
          .map((item) => ({ requestId: item.requestId, summary: "Запрос на выполнение действия" })),
        ...(status === "error" && detail.session?.lastError
          ? { failure: detail.session.lastError }
          : {}),
      };
    },
  };
}
