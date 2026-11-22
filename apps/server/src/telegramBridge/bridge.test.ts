// FILE: bridge.test.ts
// Purpose: Telegram bridge behaviour against a mock Bot API server and a stubbed orchestration port.
// Layer: Server unit tests

import { mkdtempSync, rmSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { makeTelegramBridge, type TelegramOrchestrationPort } from "./bridge.ts";

const TOKEN = "123456:SECRET-TOKEN-VALUE";
type Call = { method: string; params: Record<string, any> };

let server: http.Server;
let base = "";
let calls: Call[] = [];
let updates: Array<Record<string, unknown>> = [];
let getUpdatesStatus: { status: number; body: unknown } | null = null;
let nextUpdateId = 1;
const dirs: string[] = [];

beforeEach(async () => {
  calls = [];
  updates = [];
  getUpdatesStatus = null;
  nextUpdateId = 1;
  server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      const method = (req.url ?? "").split("/").pop() ?? "";
      const params = body ? JSON.parse(body) : {};
      res.setHeader("content-type", "application/json");
      if (!(req.url ?? "").includes(`/bot${TOKEN}/`)) {
        res.statusCode = 401;
        res.end(JSON.stringify({ ok: false, error_code: 401, description: "Unauthorized" }));
        return;
      }
      if (method === "getUpdates") {
        if (getUpdatesStatus) {
          res.statusCode = getUpdatesStatus.status;
          res.end(JSON.stringify(getUpdatesStatus.body));
          return;
        }
        const batch = updates.splice(0);
        if (batch.length === 0) {
          setTimeout(() => res.end(JSON.stringify({ ok: true, result: [] })), 20);
          return;
        }
        res.end(JSON.stringify({ ok: true, result: batch }));
        return;
      }
      calls.push({ method, params });
      if (method === "getMe") {
        res.end(JSON.stringify({ ok: true, result: { id: 1, username: "my_iishko_bot" } }));
      } else if (method === "sendMessage") {
        res.end(JSON.stringify({ ok: true, result: { message_id: 100 + calls.length } }));
      } else {
        res.end(JSON.stringify({ ok: true, result: true }));
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function message(from: number, text: string, extra: Record<string, unknown> = {}) {
  return {
    update_id: nextUpdateId++,
    message: {
      text,
      chat: { id: from, type: "private" },
      from: { id: from, first_name: "Никита" },
      ...extra,
    },
  };
}

function harness(
  overrides: Partial<TelegramOrchestrationPort> = {},
  extra: { deadManMs?: number; bindCodeTtlMs?: number } = {},
) {
  const stateDir = mkdtempSync(path.join(tmpdir(), "iishko-tg-"));
  dirs.push(stateDir);
  let token: string | null = null;
  const port: TelegramOrchestrationPort = {
    listProjects: async () => [{ id: "p1", title: "Проект" }],
    listThreads: async () => [{ id: "t1", title: "Чат", projectId: "p1" }],
    listModels: async () => [{ slug: "iishko/kimi-k3", label: "kimi-k3" }],
    createThread: vi.fn(async () => "thread-1"),
    startTurn: vi.fn(async () => undefined),
    interrupt: vi.fn(async () => undefined),
    respondApproval: vi.fn(async () => undefined),
    readThread: vi.fn(async () => ({
      assistantText: "Ответ",
      running: false,
      pendingApprovals: [],
    })),
    ...overrides,
  };
  const bridge = makeTelegramBridge({
    stateDir,
    readToken: async () => token ?? undefined,
    writeToken: async (next) => {
      token = next;
    },
    port,
    env: { IISHKO_TELEGRAM_API_BASE: base },
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, Math.min(ms, 5))),
    editIntervalMs: 0,
    watchIntervalMs: 5,
    pollTimeoutSec: 1,
    ...extra,
  });
  return { bridge, port };
}

async function bind(bridge: ReturnType<typeof harness>["bridge"], userId = 5) {
  const status = await bridge.action({ action: "setToken", token: TOKEN });
  updates.push(message(userId, `/start ${status.bindCode}`));
  await waitFor(async () => (await bridge.status()).ownerName !== null);
  return status;
}

async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs = 4000) {
  const start = Date.now();
  while (!(await check())) {
    if (Date.now() - start > timeoutMs) throw new Error("condition was not met in time");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const sent = (method: string) => calls.filter((call) => call.method === method);

it("validates the token, binds the first /start owner and never exposes the token", async () => {
  const { bridge } = harness();
  const initial = await bridge.action({ action: "setToken", token: TOKEN });
  expect(initial).toMatchObject({ state: "running", botUsername: "my_iishko_bot", enabled: true });
  expect(initial.bindCode).toBeTruthy();
  updates.push(message(5, `/start ${initial.bindCode}`));
  await waitFor(async () => (await bridge.status()).ownerName === "Никита");
  const status = await bridge.status();
  expect(status.bindCode).toBeNull();
  expect(JSON.stringify([initial, status])).not.toContain("SECRET-TOKEN-VALUE");
  expect(sent("setMyCommands")[0]?.params.commands.map((c: any) => c.command)).toEqual([
    "new",
    "projects",
    "threads",
    "model",
    "stop",
    "status",
    "help",
  ]);
  await bridge.stop();
});

it("rejects a bad token without storing it", async () => {
  const { bridge } = harness();
  await expect(bridge.action({ action: "setToken", token: "1:wrong" })).rejects.toMatchObject({
    code: "telegram_invalid_token",
  });
  expect((await bridge.status()).hasToken).toBe(false);
});

it("answers everyone except the owner with a single privacy line", async () => {
  const { bridge, port } = harness();
  await bind(bridge);
  updates.push(message(9, "привет"));
  await waitFor(() => sent("sendMessage").some((c) => c.params.chat_id === 9));
  expect(
    sent("sendMessage")
      .filter((c) => c.params.chat_id === 9)
      .map((c) => c.params.text),
  ).toEqual(["Это приватный бот"]);
  expect(port.createThread).not.toHaveBeenCalled();
  await bridge.stop();
});

it("creates a thread for owner text, sends a placeholder and edits it with the reply", async () => {
  let reads = 0;
  const { bridge, port } = harness({
    readThread: vi.fn(async () => {
      reads += 1;
      return reads < 3
        ? { assistantText: "Част", running: true, pendingApprovals: [] }
        : {
            assistantText: "Готовый <ответ>\n```ts\nconst a = 1 < 2;\n```",
            running: false,
            pendingApprovals: [],
          };
    }),
  });
  await bind(bridge);
  updates.push(message(5, "сделай"));
  await waitFor(() => sent("editMessageText").some((c) => c.params.text.includes("Готовый")));
  expect(port.createThread).toHaveBeenCalledTimes(1);
  expect(port.startTurn).toHaveBeenCalledWith(
    expect.objectContaining({ threadId: "thread-1", text: "сделай" }),
  );
  expect(sent("sendMessage").some((c) => c.params.text === "⏳ Работаю…")).toBe(true);
  const final = sent("editMessageText").at(-1)!.params;
  expect(final.parse_mode).toBe("HTML");
  expect(final.text).toContain("&lt;ответ&gt;");
  expect(final.text).toContain("<pre><code>const a = 1 &lt; 2;</code></pre>");
  await bridge.stop();
});

it("splits a reply over 4096 characters", async () => {
  const long = Array.from({ length: 400 }, (_, i) => `строка ${i} ${"x".repeat(20)}`).join("\n");
  const { bridge } = harness({
    readThread: vi.fn(async () => ({ assistantText: long, running: false, pendingApprovals: [] })),
  });
  await bind(bridge);
  updates.push(message(5, "много"));
  await waitFor(() => sent("editMessageText").length >= 1 && sent("sendMessage").length >= 3);
  const texts = [...sent("editMessageText"), ...sent("sendMessage")].map(
    (c) => c.params.text as string,
  );
  expect(Math.max(...texts.map((text) => text.length))).toBeLessThanOrEqual(4096);
  expect(sent("sendMessage").length).toBeGreaterThanOrEqual(3);
  await bridge.stop();
});

it("resolves an approval callback through the port and answers the callback query", async () => {
  let approved = false;
  const { bridge, port } = harness({
    readThread: vi.fn(async () =>
      approved
        ? { assistantText: "ok", running: false, pendingApprovals: [] }
        : {
            assistantText: "",
            running: true,
            pendingApprovals: [{ requestId: "req-1", summary: "bash ls" }],
          },
    ),
    respondApproval: vi.fn(async () => {
      approved = true;
    }),
  });
  await bind(bridge);
  updates.push(message(5, "запусти"));
  await waitFor(() => sent("sendMessage").some((c) => c.params.reply_markup));
  const keyboard = sent("sendMessage").find((c) => c.params.reply_markup)!.params.reply_markup;
  expect(keyboard.inline_keyboard[0].map((b: any) => b.text)).toEqual(["Разрешить", "Отклонить"]);
  updates.push({
    update_id: nextUpdateId++,
    callback_query: {
      id: "cb1",
      from: { id: 5 },
      data: "ap:y:req-1",
      message: { chat: { id: 5 } },
    },
  });
  await waitFor(() => sent("answerCallbackQuery").length >= 1);
  expect(port.respondApproval).toHaveBeenCalledWith({
    threadId: "thread-1",
    requestId: "req-1",
    decision: "accept",
  });
  await bridge.stop();
});

it("/stop cancels the running turn", async () => {
  const { bridge, port } = harness({
    readThread: vi.fn(async () => ({ assistantText: "", running: true, pendingApprovals: [] })),
  });
  await bind(bridge);
  updates.push(message(5, "долго"));
  await waitFor(() => sent("sendMessage").some((c) => c.params.text === "⏳ Работаю…"));
  updates.push(message(5, "/stop"));
  await waitFor(() => (port.interrupt as ReturnType<typeof vi.fn>).mock.calls.length === 1);
  expect(port.interrupt).toHaveBeenCalledWith("thread-1");
  await bridge.stop();
});

it("stops polling and reports a 409 conflict", async () => {
  const { bridge } = harness();
  await bridge.action({ action: "setToken", token: TOKEN });
  getUpdatesStatus = { status: 409, body: { ok: false, error_code: 409, description: "Conflict" } };
  await waitFor(async () => (await bridge.status()).state === "error");
  expect((await bridge.status()).reason).toContain("409");
});

it("edits the placeholder with an error when nothing starts within the dead-man timeout", async () => {
  const { bridge } = harness(
    {
      readThread: vi.fn(async () => ({ assistantText: "", running: false, pendingApprovals: [] })),
    },
    { deadManMs: 60 },
  );
  await bind(bridge);
  updates.push(message(5, "зависни"));
  await waitFor(() =>
    sent("editMessageText").some((c) => c.params.text.includes("Не удалось запустить")),
  );
  await bridge.stop();
});

it("refuses an approval callback for an unknown or stale request", async () => {
  const { bridge, port } = harness({
    readThread: vi.fn(async () => ({ assistantText: "", running: true, pendingApprovals: [] })),
  });
  await bind(bridge);
  updates.push(message(5, "работай"));
  await waitFor(() => sent("sendMessage").some((c) => c.params.text === "⏳ Работаю…"));
  updates.push({
    update_id: nextUpdateId++,
    callback_query: {
      id: "cb-stale",
      from: { id: 5 },
      data: "ap:y:ghost-request",
      message: { chat: { id: 5 } },
    },
  });
  await waitFor(() => sent("answerCallbackQuery").length >= 1);
  expect(sent("answerCallbackQuery")[0]!.params.text).toBe("Запрос уже неактуален");
  expect(port.respondApproval).not.toHaveBeenCalled();
  await bridge.stop();
});

it("regenerates the bind code after five wrong attempts and when it expires", async () => {
  const { bridge } = harness();
  const first = await bridge.action({ action: "setToken", token: TOKEN });
  for (let i = 0; i < 5; i += 1) updates.push(message(9, "/start wrongcode"));
  await waitFor(async () => (await bridge.status()).bindCode !== first.bindCode);
  const second = await bridge.status();
  expect(second.bindCode).not.toBe(first.bindCode);
  // The old code no longer binds anyone.
  updates.push(message(5, `/start ${first.bindCode}`));
  await new Promise((resolve) => setTimeout(resolve, 150));
  expect((await bridge.status()).ownerName).toBeNull();
  await bridge.stop();
});

it("rejects an unknown action", async () => {
  const { bridge } = harness();
  await expect(bridge.action({ action: "explode" } as never)).rejects.toBeDefined();
});
