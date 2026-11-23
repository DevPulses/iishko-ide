// FILE: piSubagents.test.ts
// Purpose: Tests for subagent discovery, frontmatter parsing and the subagent tool.

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type { ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";

import {
  createPiSubagentTool,
  discoverPiSubagents,
  parseSubagentMarkdown,
  runPiSubagentTask,
  type PiSubagentDefinition,
  type PiSubagentHost,
} from "./piSubagents.ts";

const dirs: string[] = [];
function tmp(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "pi-subagents-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const AGENT: PiSubagentDefinition = {
  name: "scout",
  description: "recon",
  systemPrompt: "be brief",
  source: "builtin",
  filePath: "<builtin:scout>",
};

describe("parseSubagentMarkdown", () => {
  it("parses frontmatter and body", () => {
    const parsed = parseSubagentMarkdown(
      "---\nname: a\ndescription: d\ntools: read, grep\nmodel: iishko/x\n---\nBody text\n",
    );
    expect(parsed?.frontmatter).toMatchObject({
      name: "a",
      description: "d",
      tools: "read, grep",
      model: "iishko/x",
    });
    expect(parsed?.body).toBe("Body text");
  });

  it("rejects files without frontmatter", () => {
    expect(parseSubagentMarkdown("no frontmatter")).toBeUndefined();
    expect(parseSubagentMarkdown("---\nname: a\n---\n")).toBeUndefined();
  });
});

describe("discoverPiSubagents", () => {
  it("loads builtin agents and lets later sources override by name", async () => {
    const home = tmp();
    const project = tmp();
    mkdirSync(path.join(home, "agents"), { recursive: true });
    mkdirSync(path.join(project, ".iishko", "agents"), { recursive: true });
    writeFileSync(
      path.join(home, "agents", "scout.md"),
      "---\nname: scout\ndescription: user scout\n---\nuser body",
    );
    writeFileSync(
      path.join(project, ".iishko", "agents", "custom.md"),
      "---\nname: custom\ndescription: project agent\ntools: [read, bash]\n---\nproject body",
    );
    writeFileSync(path.join(project, ".iishko", "agents", "bad.md"), "garbage");

    const agents = await discoverPiSubagents({ agentsHomeDir: home, cwd: project });
    const byName = new Map(agents.map((agent) => [agent.name, agent]));
    expect(byName.get("scout")?.source).toBe("user");
    expect(byName.get("scout")?.systemPrompt).toBe("user body");
    expect(byName.get("planner")?.source).toBe("builtin");
    expect(byName.get("custom")?.source).toBe("project");
    expect(byName.get("custom")?.tools).toEqual(["read", "bash"]);
    expect(byName.has("bad")).toBe(false);
  });
});

function stubSession(text: string, calls: { prompts: string[]; disposed: number }) {
  return {
    prompt: async (value: string) => {
      calls.prompts.push(value);
    },
    waitForIdle: async () => {},
    getLastAssistantText: () => text,
    subscribe: () => () => {},
    abort: async () => {},
    dispose: () => {
      calls.disposed += 1;
    },
  };
}

function stubHost(overrides?: {
  createSession?: PiSubagentHost["createAgentSessionFromServices"];
  onCreate?: (options: Record<string, unknown>) => void;
}): { host: PiSubagentHost; calls: { prompts: string[]; disposed: number; created: unknown[] } } {
  const calls = { prompts: [] as string[], disposed: 0, created: [] as unknown[] };
  const services = { cwd: "/tmp/proj", agentDir: "/tmp/agent" } as never;
  const host: PiSubagentHost = {
    createAgentSessionServices: async () => services,
    createAgentSessionFromServices:
      overrides?.createSession ??
      (async (options) => {
        calls.created.push(options);
        overrides?.onCreate?.(options as unknown as Record<string, unknown>);
        return {
          session: stubSession("subagent answer", calls),
          extensionsResult: {} as never,
        } as never;
      }),
    sessionManagerInMemory: () => ({}) as never,
    services,
    parentModel: undefined,
    thinkingLevel: undefined,
    resolveModel: () => undefined,
  };
  return { host, calls };
}

describe("runPiSubagentTask", () => {
  it("runs a nested session without customTools and returns text", async () => {
    const { host, calls } = stubHost();
    const result = await runPiSubagentTask(host, AGENT, "find X", undefined, undefined);
    expect(result).toEqual({ text: "subagent answer" });
    expect(calls.prompts).toEqual(["find X"]);
    expect(calls.disposed).toBe(1);
    const options = calls.created[0] as { customTools?: unknown[]; tools?: string[] };
    expect(options.customTools).toBeUndefined();
    expect(options.tools).toEqual(["read", "grep", "find", "ls"]);
  });

  it("returns the error instead of throwing", async () => {
    const { host } = stubHost({
      createSession: async () => {
        throw new Error("boom");
      },
    });
    const result = await runPiSubagentTask(host, AGENT, "task", undefined, undefined);
    expect(result.error).toBe("boom");
  });

  it("passes the supervised bash tool only to bash-enabled agents", async () => {
    const bashTool = { name: "bash" } as never;
    const { host, calls } = stubHost();
    const hostWithBash: PiSubagentHost = { ...host, bashTool };
    await runPiSubagentTask(
      hostWithBash,
      { ...AGENT, tools: ["read", "bash"] },
      "run ls",
      undefined,
      undefined,
    );
    const bashOptions = calls.created[0] as {
      customTools?: unknown[];
      tools?: string[];
    };
    expect(bashOptions.customTools).toEqual([bashTool]);
    expect(bashOptions.tools).toEqual(["read", "bash"]);

    calls.created.length = 0;
    await runPiSubagentTask(hostWithBash, AGENT, "read only", undefined, undefined);
    const readOnlyOptions = calls.created[0] as { customTools?: unknown[] };
    expect(readOnlyOptions.customTools).toBeUndefined();
  });

  it("honours an aborted signal", async () => {
    const { host, calls } = stubHost();
    const controller = new AbortController();
    controller.abort();
    const result = await runPiSubagentTask(host, AGENT, "task", controller.signal, undefined);
    expect(result.error).toBe("aborted");
    expect(calls.prompts).toEqual([]);
  });
});

describe("createPiSubagentTool", () => {
  it("runs single and parallel tasks and reports unknown agents", async () => {
    const seen: string[] = [];
    const tool = createPiSubagentTool({
      agents: [AGENT],
      maxTasks: 8,
      maxConcurrent: 2,
      runTask: async (agent, task) => {
        seen.push(`${agent.name}:${task}`);
        return { text: `ok ${task}` };
      },
    });
    const single = await tool.execute(
      "c1",
      { agent: "scout", task: "one" } as never,
      undefined,
      undefined,
      {} as ExtensionToolContext,
    );
    expect(single.isError).toBeUndefined();
    expect(JSON.stringify(single.content)).toContain("ok one");

    const parallel = await tool.execute(
      "c2",
      {
        tasks: [
          { agent: "scout", task: "a" },
          { agent: "ghost", task: "b" },
          { agent: "scout", task: "c" },
        ],
      } as never,
      undefined,
      undefined,
      {} as ExtensionToolContext,
    );
    expect(seen).toEqual(["scout:one", "scout:a", "scout:c"]);
    const text = JSON.stringify(parallel.content);
    expect(text).toContain("unknown agent");
    expect(text).toContain("ok a");
    expect(parallel.isError).toBe(true);
  });
});
