// FILE: piSubagents.ts
// Purpose: In-process subagents for the built-in Pi engine: markdown agent
//          definitions (bundled + user + project), discovery, and the
//          `subagent` custom tool that runs nested Pi sessions.
// Layer: Provider runtime support

import { mkdir, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import type {
  AgentSession,
  AgentSessionEvent,
  AgentSessionServices,
  CreateAgentSessionFromServicesOptions,
  CreateAgentSessionResult,
  CreateAgentSessionServicesOptions,
  SessionManager,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { AgentToolResult, AgentToolUpdateCallback } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";

export type PiSubagentSource = "builtin" | "user" | "project";

export interface PiSubagentDefinition {
  readonly name: string;
  readonly description: string;
  readonly tools?: ReadonlyArray<string>;
  readonly model?: string;
  readonly systemPrompt: string;
  readonly source: PiSubagentSource;
  readonly filePath: string;
}

export interface PiSubagentDiscoveryOptions {
  /** IISHKO home (`~/.iishko-ide` or `$IISHKO_HOME`); user agents live in `<home>/agents`. */
  readonly agentsHomeDir: string;
  /** Project root; project agents live under `.iishko/agents`, `.pi/agents`, `.claude/agents`. */
  readonly cwd: string;
  readonly onWarn?: ((message: string, filePath?: string) => void) | undefined;
}

const MAX_AGENTS = 64;
const MAX_AGENT_FILE_BYTES = 64 * 1024;
const MAX_TASKS = 8;
const MAX_CONCURRENT_TASKS = 4;
const MAX_RESULT_CHARS = 50_000;
const DEFAULT_AGENT_TOOLS = ["read", "grep", "find", "ls"] as const;

// ---------------------------------------------------------------------------
// Bundled agents (ported from pi-coding-agent's examples/extensions/subagent,
// MIT; `model:` lines removed so they run on the parent's model).
// ---------------------------------------------------------------------------

const BUILTIN_AGENT_FILES: ReadonlyArray<{ name: string; content: string }> = [
  {
    name: "scout",
    content: `---
name: scout
description: Fast codebase recon that returns compressed context for handoff to other agents
tools: read, grep, find, ls, bash
---

You are a scout. Quickly investigate a codebase and return structured findings that another agent can use without re-reading everything.

Your output will be passed to an agent who has NOT seen the files you explored.

Thoroughness (infer from task, default medium):
- Quick: Targeted lookups, key files only
- Medium: Follow imports, read critical sections
- Thorough: Trace all dependencies, check tests/types

Strategy:
1. grep/find to locate relevant code
2. Read key sections (not entire files)
3. Identify types, interfaces, key functions
4. Note dependencies between files

Output format:

## Files Retrieved
List with exact line ranges:
1. \`path/to/file.ts\` (lines 10-50) - Description of what's here
2. \`path/to/other.ts\` (lines 100-150) - Description
3. ...

## Key Code
Critical types, interfaces, or functions:

\`\`\`typescript
interface Example {
  // actual code from the files
}
\`\`\`

## Architecture
Brief explanation of how the pieces connect.

## Start Here
Which file to look at first and why.
`,
  },
  {
    name: "planner",
    content: `---
name: planner
description: Creates implementation plans from context and requirements
tools: read, grep, find, ls
---

You are a planning specialist. You receive context (from a scout) and requirements, then produce a clear implementation plan.

You must NOT make any changes. Only read, analyze, and plan.

Input format you'll receive:
- Context/findings from a scout agent
- Original query or requirements

Output format:

## Goal
One sentence summary of what needs to be done.

## Plan
Numbered steps, each small and actionable:
1. Step one - specific file/function to modify
2. Step two - what to add/change
3. ...

## Files to Modify
- \`path/to/file.ts\` - what changes
- \`path/to/other.ts\` - what changes

## New Files (if any)
- \`path/to/new.ts\` - purpose

## Risks
Anything to watch out for.

Keep the plan concrete. The worker agent will execute it verbatim.
`,
  },
  {
    name: "reviewer",
    content: `---
name: reviewer
description: Code review specialist for quality and security analysis
tools: read, grep, find, ls, bash
---

You are a senior code reviewer. Analyze code for quality, security, and maintainability.

Bash is for read-only commands only: \`git diff\`, \`git log\`, \`git show\`. Do NOT modify files or run builds.
Assume tool permissions are not perfectly enforceable; keep all bash usage strictly read-only.

Strategy:
1. Run \`git diff\` to see recent changes (if applicable)
2. Read the modified files
3. Check for bugs, security issues, code smells

Output format:

## Files Reviewed
- \`path/to/file.ts\` (lines X-Y)

## Critical (must fix)
- \`file.ts:42\` - Issue description

## Warnings (should fix)
- \`file.ts:100\` - Issue description

## Suggestions (consider)
- \`file.ts:150\` - Improvement idea

## Summary
Overall assessment in 2-3 sentences.

Be specific with file paths and line numbers.
`,
  },
  {
    name: "worker",
    content: `---
name: worker
description: General-purpose subagent with full capabilities, isolated context
---

You are a worker agent with full capabilities. You operate in an isolated context window to handle delegated tasks without polluting the main conversation.

Work autonomously to complete the assigned task. Use all available tools as needed.

Output format when finished:

## Completed
What was done.

## Files Changed
- \`path/to/file.ts\` - what changed

## Notes (if any)
Anything the main agent should know.

If handing off to another agent (e.g. reviewer), include:
- Exact file paths changed
- Key functions/types touched (short list)
`,
  },
];

// ---------------------------------------------------------------------------
// Agent definition parsing
// ---------------------------------------------------------------------------

interface AgentFrontmatter {
  name?: string;
  description?: string;
  tools?: string;
  model?: string;
}

/** Minimal YAML frontmatter reader for the agent format: `key: value` lines only. */
export function parseSubagentMarkdown(
  content: string,
): { frontmatter: AgentFrontmatter; body: string } | undefined {
  const normalized = content.replace(/\r\n?/gu, "\n");
  const match = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/u.exec(normalized);
  if (!match || !match[2]!.trim()) return undefined;
  const frontmatter: AgentFrontmatter = {};
  for (const line of match[1]!.split("\n")) {
    const kv = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/u.exec(line.trim());
    if (!kv) continue;
    const key = kv[1]!;
    let value = kv[2]!.trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key === "name") frontmatter.name = value;
    else if (key === "description") frontmatter.description = value;
    else if (key === "tools") frontmatter.tools = value;
    else if (key === "model") frontmatter.model = value;
  }
  return { frontmatter, body: match[2]!.trim() };
}

function parseToolList(value: string | undefined): ReadonlyArray<string> | undefined {
  if (!value) return undefined;
  const inner = value.startsWith("[") && value.endsWith("]") ? value.slice(1, -1) : value;
  const tools = inner
    .split(",")
    .map((tool) => tool.trim().replace(/^["']|["']$/gu, ""))
    .filter(Boolean);
  return tools.length > 0 ? tools : undefined;
}

function definitionFromMarkdown(
  content: string,
  source: PiSubagentSource,
  filePath: string,
): PiSubagentDefinition | undefined {
  const parsed = parseSubagentMarkdown(content);
  if (!parsed) return undefined;
  const { name, description } = parsed.frontmatter;
  if (!name?.trim() || !description?.trim() || !parsed.body) return undefined;
  const tools = parseToolList(parsed.frontmatter.tools);
  const model = parsed.frontmatter.model?.trim() || undefined;
  return {
    name: name.trim(),
    description: description.trim(),
    ...(tools ? { tools } : {}),
    ...(model ? { model } : {}),
    systemPrompt: parsed.body,
    source,
    filePath,
  };
}

async function loadAgentsFromDir(
  dir: string,
  source: PiSubagentSource,
  onWarn: PiSubagentDiscoveryOptions["onWarn"],
): Promise<PiSubagentDefinition[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const agents: PiSubagentDefinition[] = [];
  for (const entry of entries) {
    if (!entry.name.endsWith(".md") || (!entry.isFile() && !entry.isSymbolicLink())) continue;
    const filePath = join(dir, entry.name);
    try {
      const content = await readFile(filePath, "utf8");
      if (content.length > MAX_AGENT_FILE_BYTES) {
        onWarn?.(`Subagent file exceeds ${MAX_AGENT_FILE_BYTES} bytes, skipped`, filePath);
        continue;
      }
      const agent = definitionFromMarkdown(content, source, filePath);
      if (agent) agents.push(agent);
      else onWarn?.("Subagent file is missing name/description or a body, skipped", filePath);
    } catch {
      onWarn?.("Subagent file could not be read, skipped", filePath);
    }
  }
  return agents;
}

/**
 * Discover subagents: bundled defaults, then `~/.iishko-ide/agents`, then the
 * project's `.iishko/agents`, `.pi/agents` and `.claude/agents`. Later sources
 * override earlier ones by name.
 */
export async function discoverPiSubagents(
  options: PiSubagentDiscoveryOptions,
): Promise<PiSubagentDefinition[]> {
  const byName = new Map<string, PiSubagentDefinition>();
  const add = (agents: ReadonlyArray<PiSubagentDefinition>) => {
    for (const agent of agents) {
      if (byName.size >= MAX_AGENTS && !byName.has(agent.name)) continue;
      byName.set(agent.name, agent);
    }
  };

  add(
    BUILTIN_AGENT_FILES.map((file) =>
      definitionFromMarkdown(file.content, "builtin", `<builtin:${file.name}>`),
    ).filter((agent): agent is PiSubagentDefinition => agent !== undefined),
  );
  add(await loadAgentsFromDir(join(options.agentsHomeDir, "agents"), "user", options.onWarn));
  for (const dirName of [".iishko/agents", ".pi/agents", ".claude/agents"]) {
    add(await loadAgentsFromDir(join(options.cwd, dirName), "project", options.onWarn));
  }
  return [...byName.values()];
}

/** The user agents directory (`<iishko home>/agents`), created on demand. */
export function iishkoAgentsDir(agentsHomeDir: string): string {
  return join(agentsHomeDir, "agents");
}

export async function ensureIishkoAgentsDir(agentsHomeDir: string): Promise<string> {
  const dir = iishkoAgentsDir(agentsHomeDir);
  await mkdir(dir, { recursive: true });
  return dir;
}

// ---------------------------------------------------------------------------
// Nested session runner
// ---------------------------------------------------------------------------

/** The slice of the Pi SDK the runner needs; injectable for tests. */
export interface PiSubagentHost {
  readonly createAgentSessionServices: (
    options: CreateAgentSessionServicesOptions,
  ) => Promise<AgentSessionServices>;
  readonly createAgentSessionFromServices: (
    options: CreateAgentSessionFromServicesOptions,
  ) => Promise<CreateAgentSessionResult>;
  readonly sessionManagerInMemory: (cwd: string) => SessionManager;
  /** Parent session services: cwd, agentDir, modelRuntime, settingsManager. */
  readonly services: AgentSessionServices;
  /** Model the parent session resolved; fallback when the agent's model is unknown. */
  readonly parentModel: Model<any> | undefined;
  readonly thinkingLevel: ThinkingLevel | undefined;
  /** Resolve an agent `model:` reference in the shared registry. */
  readonly resolveModel: (modelRef: string) => Model<any> | undefined;
  /**
   * The parent's supervised bash tool. Nested sessions get it as a customTool
   * when the agent lists `bash`, so spawned processes stay under the parent's
   * process supervisor (no bare Pi built-in bash).
   */
  readonly bashTool?: ToolDefinition | undefined;
}

export interface PiSubagentRunResult {
  readonly text: string;
  readonly error?: string;
}

function truncateResult(text: string): string {
  return text.length > MAX_RESULT_CHARS ? `${text.slice(0, MAX_RESULT_CHARS)}\n…` : text;
}

/**
 * Run one subagent task in a nested in-memory Pi session. Never throws: errors
 * come back as `{ error }` so the parent turn always completes.
 */
export async function runPiSubagentTask(
  host: PiSubagentHost,
  agent: PiSubagentDefinition,
  task: string,
  signal: AbortSignal | undefined,
  onUpdate: AgentToolUpdateCallback | undefined,
): Promise<PiSubagentRunResult> {
  if (signal?.aborted) return { text: "", error: "aborted" };
  let session: AgentSession | undefined;
  let unsubscribe: (() => void) | undefined;
  try {
    const subServices = await host.createAgentSessionServices({
      cwd: host.services.cwd,
      agentDir: host.services.agentDir,
      modelRuntime: host.services.modelRuntime,
      settingsManager: host.services.settingsManager,
      resourceLoaderOptions: {
        noExtensions: true,
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        noContextFiles: true,
        appendSystemPrompt: [agent.systemPrompt],
      },
    });
    const model = agent.model ? host.resolveModel(agent.model) : undefined;
    const resolvedModel = model ?? host.parentModel;
    const agentTools = [...(agent.tools ?? DEFAULT_AGENT_TOOLS)];
    const bashTool = agentTools.includes("bash") ? host.bashTool : undefined;
    const { session: created } = await host.createAgentSessionFromServices({
      services: subServices,
      sessionManager: host.sessionManagerInMemory(host.services.cwd),
      ...(resolvedModel ? { model: resolvedModel } : {}),
      ...(host.thinkingLevel ? { thinkingLevel: host.thinkingLevel } : {}),
      tools: agentTools,
      // customTools carries only the supervised bash override; the subagent tool
      // itself is never passed, so nested sessions cannot recurse.
      ...(bashTool ? { customTools: [bashTool] } : {}),
    });
    session = created;
    if (!session) throw new Error("subagent session unavailable");

    const onAbort = () => void session?.abort();
    signal?.addEventListener("abort", onAbort, { once: true });
    unsubscribe = session.subscribe((event: AgentSessionEvent) => {
      if (event.type === "tool_execution_start") {
        onUpdate?.({
          content: [{ type: "text", text: `${agent.name}: ${event.toolName}` }],
          details: { agent: agent.name, phase: "tool", tool: event.toolName },
        });
      }
    });
    try {
      await session.prompt(task);
      await session.waitForIdle();
    } finally {
      signal?.removeEventListener("abort", onAbort);
      unsubscribe?.();
      unsubscribe = undefined;
    }
    const text = session.getLastAssistantText() ?? "";
    if (signal?.aborted) return { text: truncateResult(text), error: "aborted" };
    return { text: truncateResult(text) };
  } catch (cause) {
    return {
      text: "",
      error: cause instanceof Error ? cause.message : String(cause),
    };
  } finally {
    session?.dispose?.();
  }
}

// ---------------------------------------------------------------------------
// The `subagent` tool
// ---------------------------------------------------------------------------

export interface PiSubagentToolOptions {
  readonly agents: ReadonlyArray<PiSubagentDefinition>;
  /** Runs one task; defaults to a nested Pi session via the host. */
  readonly runTask: (
    agent: PiSubagentDefinition,
    task: string,
    signal: AbortSignal | undefined,
    onUpdate: AgentToolUpdateCallback | undefined,
  ) => Promise<PiSubagentRunResult>;
  readonly maxTasks?: number;
  readonly maxConcurrent?: number;
}

interface SubagentTaskInput {
  agent: string;
  task: string;
}

function asTaskArray(params: Record<string, unknown>): SubagentTaskInput[] {
  const raw = Array.isArray(params.tasks) ? params.tasks : [params];
  const tasks: SubagentTaskInput[] = [];
  for (const entry of raw) {
    if (entry === null || typeof entry !== "object") continue;
    const item = entry as Record<string, unknown>;
    const agent = typeof item.agent === "string" ? item.agent.trim() : "";
    const task = typeof item.task === "string" ? item.task.trim() : "";
    if (agent && task) tasks.push({ agent, task });
  }
  return tasks;
}

async function runPool<T, R>(
  items: ReadonlyArray<T>,
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const lanes = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await worker(items[index]!, index);
    }
  });
  await Promise.all(lanes);
  return results;
}

function formatTaskResult(agent: PiSubagentDefinition, result: PiSubagentRunResult): string {
  const status = result.error ? `error: ${result.error}` : "done";
  const body = result.error ? result.error : result.text || "(empty result)";
  return `## ${agent.name}: ${status}\n\n${body}`;
}

/**
 * The `subagent` tool: `{ agent, task }` or `{ tasks: [{agent, task}] }` for
 * parallel runs. Results are text; errors are reported, never thrown.
 */
export function createPiSubagentTool(options: PiSubagentToolOptions): ToolDefinition {
  const maxTasks = options.maxTasks ?? MAX_TASKS;
  const maxConcurrent = options.maxConcurrent ?? MAX_CONCURRENT_TASKS;
  const byName = new Map(options.agents.map((agent) => [agent.name, agent]));
  const agentList = options.agents
    .map((agent) => `${agent.name} (${agent.source}): ${agent.description}`)
    .join("; ");

  return {
    name: "subagent",
    label: "Subagent",
    description:
      "Delegate a task to a subagent with its own isolated context. " +
      `Available agents: ${agentList || "none"}. ` +
      "Pass { agent, task } for one run or { tasks: [{ agent, task }] } for up to " +
      `${maxTasks} parallel runs (max ${maxConcurrent} at once). ` +
      "Subagents are read-only by default unless their definition allows more tools.",
    parameters: {
      type: "object",
      properties: {
        agent: { type: "string", description: "Subagent name" },
        task: { type: "string", description: "Task for the subagent" },
        tasks: {
          type: "array",
          description: `Parallel tasks (max ${maxTasks})`,
          items: {
            type: "object",
            properties: {
              agent: { type: "string" },
              task: { type: "string" },
            },
            required: ["agent", "task"],
          },
        },
      },
    } as ToolDefinition["parameters"],
    execute: async (
      _toolCallId: string,
      params: Record<string, unknown>,
      signal: AbortSignal | undefined,
      onUpdate: AgentToolUpdateCallback | undefined,
    ): Promise<AgentToolResult> => {
      const requested = asTaskArray(params).slice(0, maxTasks);
      if (requested.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: `No valid tasks. Pass { agent, task } or { tasks: [{ agent, task }] }. Agents: ${agentList || "none"}.`,
            },
          ],
          details: { agent: "subagent", phase: "invalid" },
        };
      }
      const resolved = requested.map((item) => ({
        input: item,
        agent: byName.get(item.agent),
      }));
      const unknown = resolved.filter((entry) => !entry.agent);
      const runnable = resolved.filter(
        (entry): entry is { input: SubagentTaskInput; agent: PiSubagentDefinition } =>
          entry.agent !== undefined,
      );

      const results = await runPool(runnable, maxConcurrent, async ({ agent, input }) => {
        const result = await options.runTask(agent, input.task, signal, onUpdate);
        return formatTaskResult(agent, result);
      });

      const parts: string[] = [];
      for (const entry of unknown) {
        parts.push(`## ${entry.input.agent}: error: unknown agent`);
      }
      parts.push(...results);
      const text = parts.join("\n\n");
      const hasError = unknown.length > 0 || runnable.some(() => false);
      return {
        content: [{ type: "text", text }],
        details: {
          agent: "subagent",
          phase: "done",
          tasks: requested.length,
          errors: unknown.length,
        },
        ...(hasError ? { isError: true } : {}),
      };
    },
  } as ToolDefinition;
}

export { MAX_TASKS as PI_SUBAGENT_MAX_TASKS, MAX_CONCURRENT_TASKS as PI_SUBAGENT_MAX_CONCURRENT };
