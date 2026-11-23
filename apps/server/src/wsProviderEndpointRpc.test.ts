// FILE: wsProviderEndpointRpc.test.ts
// Purpose: Verifies the stored endpoint key is only usable for the origin it
//   was saved for, that a dialog-entered key is single-use, and that the
//   handler stays owner-only.
// Layer: Server RPC unit tests

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { DEFAULT_SERVER_SETTINGS, type ServerSettings } from "@iishko/contracts";
import { WS_METHODS } from "@iishko/contracts";
import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";

import { CurrentWsSessionRole } from "./wsConnectionSessions";
import { makeProviderEndpointRpcHandlers } from "./wsProviderEndpointRpc";

const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

type RecordedRequest = { url: string; authorization: string | null };

async function modelsStub(): Promise<{ origin: string; requests: RecordedRequest[] }> {
  const requests: RecordedRequest[] = [];
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      requests.push({
        url: req.url ?? "",
        authorization: (req.headers.authorization as string | undefined) ?? null,
      });
      if (req.url?.endsWith("/models")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ data: [{ id: "stub-model" }] }));
        return;
      }
      res.writeHead(404).end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  cleanups.push(() => server.close());
  return { origin: `http://127.0.0.1:${port}`, requests };
}

function settingsWithEndpoint(baseUrl: string): ServerSettings {
  return {
    ...DEFAULT_SERVER_SETTINGS,
    providerInstances: {
      pi_endpoint: {
        driver: "pi",
        displayName: "Endpoint",
        enabled: true,
        environment: [{ name: "IISHKO_CUSTOM_API_KEY", value: "sk-stored", sensitive: true }],
        config: {
          kind: "openai-compatible",
          baseUrl,
          models: [{ id: "stub-model" }],
        },
      },
    },
  } as ServerSettings;
}

function callHandler(
  settings: ServerSettings,
  input: { baseUrl: string; apiKey?: string; instanceId?: string },
  role: "owner" | "client" = "owner",
) {
  const handlers = makeProviderEndpointRpcHandlers({ readSettings: async () => settings });
  const operation = handlers[WS_METHODS.providerListEndpointModels](input as never);
  return Effect.runPromise(operation.pipe(Effect.provideService(CurrentWsSessionRole, role)));
}

describe("providerListEndpointModels", () => {
  it("uses the stored key only for the saved origin", async () => {
    const stub = await modelsStub();
    const other = await modelsStub();
    const settings = settingsWithEndpoint(`${stub.origin}/v1`);

    const result = await callHandler(settings, {
      baseUrl: `${stub.origin}/v1/`,
      instanceId: "pi_endpoint",
    });
    expect(result.models).toEqual([{ id: "stub-model", name: "stub-model" }]);
    expect(stub.requests[0]?.authorization).toBe("Bearer sk-stored");

    await expect(
      callHandler(settings, {
        baseUrl: `${other.origin}/v1`,
        instanceId: "pi_endpoint",
      }),
    ).rejects.toThrow("Ключ сохранён для другого адреса");
    expect(other.requests).toHaveLength(0);
  });

  it("lets a dialog-entered key authenticate any allowed origin once", async () => {
    const stub = await modelsStub();
    const other = await modelsStub();
    const settings = settingsWithEndpoint(`${stub.origin}/v1`);

    const result = await callHandler(settings, {
      baseUrl: `${other.origin}/v1`,
      apiKey: "sk-typed",
      instanceId: "pi_endpoint",
    });
    expect(result.models).toEqual([{ id: "stub-model", name: "stub-model" }]);
    expect(other.requests[0]?.authorization).toBe("Bearer sk-typed");
    expect(stub.requests).toHaveLength(0);
  });

  it("requires the owner role", async () => {
    const stub = await modelsStub();
    await expect(
      callHandler(
        settingsWithEndpoint(`${stub.origin}/v1`),
        {
          baseUrl: `${stub.origin}/v1`,
          instanceId: "pi_endpoint",
        },
        "client",
      ),
    ).rejects.toThrow("Owner authorization");
    expect(stub.requests).toHaveLength(0);
  });
});
