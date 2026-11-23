import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import { ProviderInstanceConfigMap } from "./providerInstance";

const providerInstancesCodec = Schema.toCodecJson(ProviderInstanceConfigMap);

describe("ProviderInstanceConfigMap JSON codec", () => {
  it("preserves provider launch config when settings cross the JSON boundary", () => {
    const providerInstances = {
      claude_work: {
        driver: "claudeAgent",
        displayName: "Work Claude",
        config: { homePath: "/accounts/work", cliAlias: "claude-work" },
      },
    };
    const wire = JSON.parse(
      JSON.stringify(Schema.encodeUnknownSync(providerInstancesCodec)(providerInstances)),
    );

    expect(wire).toEqual(providerInstances);
    expect(Schema.decodeUnknownSync(providerInstancesCodec)(wire)).toEqual(providerInstances);
  });
});

describe("ProviderCustomEndpointSpec", () => {
  it("decodes a custom endpoint spec and rejects missing required fields", async () => {
    const { ProviderCustomEndpointSpec } = await import("./providerInstance");
    const decode = Schema.decodeUnknownSync(ProviderCustomEndpointSpec);
    expect(
      decode({
        id: "custom-pi_work",
        name: "Work API",
        baseUrl: "https://api.example.com/v1",
        models: [{ id: "m1", name: "Model One", contextWindow: 64000 }],
        apiKeyEnv: "IISHKO_CUSTOM_API_KEY",
      }),
    ).toMatchObject({ id: "custom-pi_work", apiKeyEnv: "IISHKO_CUSTOM_API_KEY" });
    expect(() => decode({ id: "x", name: "X", baseUrl: "https://x", models: "nope" })).toThrow();
    expect(() => decode({ id: "x", name: "X", baseUrl: "https://x", models: [{}] })).toThrow();
  });
});

describe("PiProviderStartOptions customProviders", () => {
  it("carries custom provider specs through the provider start options schema", async () => {
    const { PiProviderStartOptions } = await import("./orchestration");
    const decode = Schema.decodeUnknownSync(PiProviderStartOptions);
    const decoded = decode({
      customProviders: [
        {
          id: "custom-pi_work",
          name: "Work API",
          baseUrl: "https://api.example.com/v1",
          models: [{ id: "m1", contextWindow: 128000 }],
        },
      ],
    });
    expect(decoded.customProviders?.[0]?.models[0]?.id).toBe("m1");
    expect(decoded.customProviders?.[0]?.apiKeyEnv).toBeUndefined();
  });
});
