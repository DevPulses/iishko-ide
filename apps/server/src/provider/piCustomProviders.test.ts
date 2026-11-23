// FILE: piCustomProviders.test.ts
// Purpose: Verifies custom OpenAI-compatible endpoint registration, per-instance
//   key isolation, and the guarded /models probe for the settings dialog.
// Layer: Provider unit tests

import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type { AddressInfo } from "node:net";
import { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { OutboundHttpRequest, OutboundHttpResponse } from "@iishko/shared/outboundHttp";
import { afterEach, describe, expect, it, vi } from "vitest";

import { findModelInRegistry } from "./Layers/PiAdapter.ts";
import {
  CUSTOM_PROVIDER_DEFAULT_API_KEY_ENV,
  fetchCustomEndpointModels,
  registerPiCustomProviders,
} from "./piCustomProviders.ts";
import { importTestPiPackage } from "./testing/piSdkFixture.ts";

const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function tempAgentDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "iishko-pi-custom-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

async function modelRuntime(agentDir: string): Promise<ModelRuntime> {
  return ModelRuntime.create({
    authPath: path.join(agentDir, "auth.json"),
    modelsPath: path.join(agentDir, "models.json"),
    refreshOnCreate: false,
  });
}

type RecordedRequest = { url: string; authorization: string | null; body: string };

async function stubChatServer(
  handler?: (req: RecordedRequest, res: import("node:http").ServerResponse) => void,
): Promise<{ server: Server; origin: string; requests: RecordedRequest[] }> {
  const requests: RecordedRequest[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const record: RecordedRequest = {
        url: req.url ?? "",
        authorization: (req.headers.authorization as string | undefined) ?? null,
        body: Buffer.concat(chunks).toString("utf8"),
      };
      requests.push(record);
      if (handler) {
        handler(record, res);
        return;
      }
      const sse = [
        `data: ${JSON.stringify({
          id: "chatcmpl-1",
          object: "chat.completion.chunk",
          created: 1,
          model: "stub-model",
          choices: [
            { index: 0, delta: { role: "assistant", content: "Hello" }, finish_reason: null },
          ],
        })}`,
        `data: ${JSON.stringify({
          id: "chatcmpl-1",
          object: "chat.completion.chunk",
          created: 1,
          model: "stub-model",
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
        })}`,
        "data: [DONE]",
        "",
      ].join("\n\n");
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(sse);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  cleanups.push(() => server.close());
  return { server, origin: `http://127.0.0.1:${port}`, requests };
}

describe("fetchCustomEndpointModels", () => {
  it("parses the OpenAI models list and sends the bearer key once", async () => {
    const seen: Array<{ authorization: string | null }> = [];
    const request = vi.fn(async (input: OutboundHttpRequest): Promise<OutboundHttpResponse> => {
      seen.push({ authorization: new Headers(input.headers).get("authorization") });
      return {
        status: 200,
        url: String(input.url),
        headers: new Headers({ "content-type": "application/json" }),
        body: Buffer.from(
          JSON.stringify({
            object: "list",
            data: [
              { id: "alpha", name: "Alpha", context_length: 131072 },
              { id: "beta" },
              { name: "no id" },
              { id: "  " },
            ],
          }),
        ),
      };
    });
    const models = await fetchCustomEndpointModels(
      { baseUrl: "https://api.example.com/v1/", apiKey: "sk-once" },
      request,
    );
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0]?.[0].url).toBe("https://api.example.com/v1/models");
    expect(seen).toEqual([{ authorization: "Bearer sk-once" }]);
    expect(models).toEqual([
      { id: "alpha", name: "Alpha", contextWindow: 131072 },
      { id: "beta", name: "beta" },
    ]);
  });

  it("rejects non-200 responses and malformed payloads", async () => {
    const failing = vi.fn(
      async (): Promise<OutboundHttpResponse> => ({
        status: 401,
        url: "https://api.example.com/v1/models",
        headers: new Headers(),
        body: Buffer.from("{}"),
      }),
    );
    await expect(
      fetchCustomEndpointModels({ baseUrl: "https://api.example.com/v1" }, failing),
    ).rejects.toThrow("HTTP 401");
    const malformed = vi.fn(
      async (input: OutboundHttpRequest): Promise<OutboundHttpResponse> => ({
        status: 200,
        url: String(input.url),
        headers: new Headers(),
        body: Buffer.from(JSON.stringify({ nope: true })),
      }),
    );
    await expect(
      fetchCustomEndpointModels({ baseUrl: "https://api.example.com/v1" }, malformed),
    ).rejects.toThrow("Invalid endpoint model list");
  });

  it("probes a loopback HTTP stub through the real outbound policy", async () => {
    const { origin, requests } = await stubChatServer((req, res) => {
      if (req.url === "/v1/models") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ data: [{ id: "local-model", context_length: 64000 }] }));
        return;
      }
      res.writeHead(404).end();
    });
    const models = await fetchCustomEndpointModels({
      baseUrl: `${origin}/v1`,
      apiKey: "sk-local",
    });
    expect(models).toEqual([{ id: "local-model", name: "local-model", contextWindow: 64000 }]);
    expect(requests[0]?.authorization).toBe("Bearer sk-local");
  });

  it("refuses plain HTTP to a non-loopback public address before any request", async () => {
    await expect(fetchCustomEndpointModels({ baseUrl: "http://192.0.2.1/v1" })).rejects.toThrow();
    await expect(fetchCustomEndpointModels({ baseUrl: "http://8.8.8.8/v1" })).rejects.toThrow();
  });

  it("lets private LAN addresses past the URL and address policy", async () => {
    // Port 9 (discard) is closed everywhere, so a reached socket proves the
    // policy admitted the destination; a policy rejection would say otherwise.
    for (const baseUrl of [
      "http://192.168.1.10:9/v1",
      "http://10.11.12.13:9/v1",
      "https://192.168.1.10:9/v1",
      "http://[fd00::1]:9/v1",
    ]) {
      const error = await fetchCustomEndpointModels({ baseUrl }).then(
        () => null,
        (cause: unknown) => cause,
      );
      expect(error).not.toBeNull();
      expect((error as { code?: string }).code).not.toBe("private-address");
      expect((error as { code?: string }).code).not.toBe("invalid-url");
    }
  });

  it("still refuses link-local and public-range HTTP endpoints", async () => {
    for (const baseUrl of [
      "http://169.254.1.1:9/v1",
      "http://100.64.0.1:9/v1",
      "http://[fe80::1]:9/v1",
    ]) {
      await expect(fetchCustomEndpointModels({ baseUrl })).rejects.toThrow();
    }
  });
});

describe("registerPiCustomProviders", () => {
  const spec = (id: string, baseUrl: string) => ({
    id,
    name: `Endpoint ${id}`,
    baseUrl,
    models: [{ id: "stub-model", name: "Stub", contextWindow: 64000 }],
    apiKeyEnv: CUSTOM_PROVIDER_DEFAULT_API_KEY_ENV,
  });

  it("registers models with clamped context windows and streams a chat turn", async () => {
    const { origin, requests } = await stubChatServer();
    const runtime = await modelRuntime(tempAgentDir());
    await registerPiCustomProviders(runtime, importTestPiPackage, {
      providers: [
        {
          id: "custom-pi_alpha",
          name: "Alpha API",
          baseUrl: `${origin}/v1`,
          models: [
            { id: "stub-model", name: "Stub", contextWindow: 64 }, // clamps to 32000
            { id: "huge-model", contextWindow: 999_999 }, // clamps to 400000
            { id: "plain-model" }, // defaults to 128000
          ],
          apiKeyEnv: CUSTOM_PROVIDER_DEFAULT_API_KEY_ENV,
        },
      ],
      environment: { [CUSTOM_PROVIDER_DEFAULT_API_KEY_ENV]: "sk-alpha" },
    });
    const registry = new ModelRegistry(runtime);
    const model = findModelInRegistry(registry, "custom-pi_alpha/stub-model");
    expect(model).toMatchObject({
      provider: "custom-pi_alpha",
      id: "stub-model",
      api: "openai-completions",
      baseUrl: `${origin}/v1`,
      contextWindow: 32_000,
    });
    expect(findModelInRegistry(registry, "custom-pi_alpha/huge-model")?.contextWindow).toBe(
      400_000,
    );
    expect(findModelInRegistry(registry, "custom-pi_alpha/plain-model")?.contextWindow).toBe(
      128_000,
    );

    const result = await runtime
      .streamSimple(model!, {
        messages: [{ role: "user", content: "Say hello", timestamp: 1 }],
      })
      .result();
    expect(result.stopReason).toBe("stop");
    expect(JSON.stringify(result.content)).toContain("Hello");

    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe("/v1/chat/completions");
    expect(requests[0]?.authorization).toBe("Bearer sk-alpha");
    expect(JSON.parse(requests[0]!.body)).toMatchObject({ model: "stub-model", stream: true });
  });

  it("never mixes keys between two custom instances", async () => {
    const { origin, requests } = await stubChatServer((req, res) => {
      const sse = `data: ${JSON.stringify({
        id: "c",
        object: "chat.completion.chunk",
        created: 1,
        model: "stub-model",
        choices: [{ index: 0, delta: { content: "ok" }, finish_reason: "stop" }],
      })}\n\ndata: [DONE]\n\n`;
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(sse);
    });
    const runtimeA = await modelRuntime(tempAgentDir());
    const runtimeB = await modelRuntime(tempAgentDir());
    await registerPiCustomProviders(runtimeA, importTestPiPackage, {
      providers: [spec("custom-pi_a", `${origin}/a`)],
      environment: { [CUSTOM_PROVIDER_DEFAULT_API_KEY_ENV]: "key-a" },
    });
    await registerPiCustomProviders(runtimeB, importTestPiPackage, {
      providers: [spec("custom-pi_b", `${origin}/b`)],
      environment: { [CUSTOM_PROVIDER_DEFAULT_API_KEY_ENV]: "key-b" },
    });
    const modelA = findModelInRegistry(new ModelRegistry(runtimeA), "custom-pi_a/stub-model")!;
    const modelB = findModelInRegistry(new ModelRegistry(runtimeB), "custom-pi_b/stub-model")!;
    const context = { messages: [{ role: "user" as const, content: "hi", timestamp: 1 }] };
    await runtimeA.streamSimple(modelA, context).result();
    await runtimeB.streamSimple(modelB, context).result();
    expect(requests.map((request) => [request.url, request.authorization])).toEqual([
      ["/a/chat/completions", "Bearer key-a"],
      ["/b/chat/completions", "Bearer key-b"],
    ]);
  });

  it("sends no key when the instance environment lacks it", async () => {
    const { origin, requests } = await stubChatServer();
    const runtime = await modelRuntime(tempAgentDir());
    await registerPiCustomProviders(runtime, importTestPiPackage, {
      providers: [spec("custom-pi_none", `${origin}/v1`)],
      environment: {},
    });
    const model = findModelInRegistry(new ModelRegistry(runtime), "custom-pi_none/stub-model")!;
    const result = await runtime
      .streamSimple(model, {
        messages: [{ role: "user", content: "hi", timestamp: 1 }],
      })
      .result();
    expect(result.stopReason).toBe("stop");
    expect(requests).toHaveLength(1);
    expect(requests[0]?.authorization).toBeNull();
  });
});
