import { describe, expect, it } from "vitest";

import { iishkoModelDisplayName } from "./iishkoModelNames";

describe("iishkoModelDisplayName", () => {
  it("humanises gateway ids", () => {
    expect(iishkoModelDisplayName("deepseek-v4-flash")).toBe("DeepSeek V4 Flash");
    expect(iishkoModelDisplayName("gpt-6-luna")).toBe("GPT 6 Luna");
    expect(iishkoModelDisplayName("kimi-k3")).toBe("Kimi K3");
    expect(iishkoModelDisplayName("iishko/glm-5.3")).toBe("GLM 5.3");
  });

  it("prefers a title from the model list and falls back to the id", () => {
    expect(iishkoModelDisplayName("kimi-k3", "Kimi K3 Pro")).toBe("Kimi K3 Pro");
    expect(iishkoModelDisplayName("kimi-k3", "kimi-k3")).toBe("Kimi K3");
  });
});
