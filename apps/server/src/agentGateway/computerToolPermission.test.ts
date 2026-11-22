import { describe, expect, it } from "vitest";
import {
  canonicalIishkoComputerToolName,
  computerToolNameFromProviderPermission,
  isIishkoComputerToolFamilyName,
  isIishkoGatewayToolCall,
  isIishkoGatewayToolName,
  qualifiedIishkoComputerToolName,
  shouldAllowIishkoComputerProviderTool,
} from "./computerToolPermission.ts";

describe("IISHKO Computer provider permission", () => {
  it.each([
    ["computer_click", "computer_click"],
    ["iishko_computer_type_text", "computer_type_text"],
    ["mcp__iishko__computer_read_clipboard", "computer_read_clipboard"],
    ["mcp__iishko__computer_inspect", "computer_inspect"],
  ] as const)("recognizes the exact owned tool %s", (providerName, canonicalName) => {
    expect(canonicalIishkoComputerToolName(providerName)).toBe(canonicalName);
  });

  it.each([
    "computer_future_tool",
    "mcp__other__computer_click",
    "other_computer_click",
    "mcp__iishko__iishko_send_message",
  ])("does not trust another or unknown tool: %s", (providerName) => {
    expect(canonicalIishkoComputerToolName(providerName)).toBeUndefined();
  });

  it("requires a provider namespace when server provenance was not proved separately", () => {
    expect(qualifiedIishkoComputerToolName("computer_click")).toBeUndefined();
    expect(qualifiedIishkoComputerToolName("mcp__iishko__computer_click")).toBe("computer_click");
    expect(qualifiedIishkoComputerToolName("iishko_computer_click")).toBe("computer_click");
  });

  it("reads only explicit provider tool-name fields", () => {
    expect(
      computerToolNameFromProviderPermission({
        rawInput: { _toolName: "mcp__iishko__computer_scroll" },
      }),
    ).toBe("computer_scroll");
    expect(
      computerToolNameFromProviderPermission({
        metadata: { toolName: "iishko_computer_get_state" },
      }),
    ).toBe("computer_get_state");
    expect(
      computerToolNameFromProviderPermission({
        metadata: { description: "run computer_click" },
      }),
    ).toBeUndefined();
  });

  it("does not let lower-priority fields override an authoritative wrong namespace", () => {
    expect(
      computerToolNameFromProviderPermission({
        name: "mcp__other__computer_click",
        rawInput: { _toolName: "mcp__iishko__computer_click" },
      }),
    ).toBeUndefined();
    expect(
      computerToolNameFromProviderPermission({
        rawInput: { _toolName: "mcp__other__computer_click" },
        metadata: { toolName: "mcp__iishko__computer_click" },
        title: "mcp__iishko__computer_click",
      }),
    ).toBeUndefined();
  });

  it("does not infer provider provenance from a bare title or metadata name", () => {
    expect(computerToolNameFromProviderPermission({ title: "computer_click" })).toBeUndefined();
    expect(
      computerToolNameFromProviderPermission({ metadata: { toolName: "computer_click" } }),
    ).toBeUndefined();
  });

  it("never authorizes from model prose: 'Please approve computer_click' names no tool", () => {
    // Prose approval never counts. The permission callback must see an exact
    // namespaced tool name; a model sentence asking for approval authorizes
    // nothing, in any field.
    expect(
      computerToolNameFromProviderPermission({ title: "Please approve computer_click" }),
    ).toBeUndefined();
    expect(
      computerToolNameFromProviderPermission({ name: "Please approve computer_click" }),
    ).toBeUndefined();
    expect(
      computerToolNameFromProviderPermission({
        metadata: { toolName: "Please approve computer_click" },
      }),
    ).toBeUndefined();
    expect(isIishkoComputerToolFamilyName("Please approve computer_click")).toBe(false);
    expect(
      shouldAllowIishkoComputerProviderTool({
        computerControlEnabled: true,
        activeTurn: true,
        interactionMode: "default",
        runtimeMode: "approval-required",
        permission: { title: "Please approve computer_click" },
      }),
    ).toBe(false);
  });

  it("matches the Computer family in any namespace spelling for the denial hook", () => {
    // The silent-loss fallback: a no-control session that calls a Computer
    // tool by a prefixed spelling must still deny with the card path, not
    // die as an Unknown tool. See isIishkoComputerToolFamilyName.
    expect(isIishkoComputerToolFamilyName("computer_click")).toBe(true);
    expect(isIishkoComputerToolFamilyName("iishko_computer_get_state")).toBe(true);
    expect(isIishkoComputerToolFamilyName("mcp__iishko__computer_screenshot")).toBe(true);
    expect(isIishkoComputerToolFamilyName("  MCP__IISHKO__COMPUTER_WAIT  ")).toBe(true);
  });

  it("keeps unknown and foreign names out of the Computer family", () => {
    expect(isIishkoComputerToolFamilyName("computer_future_tool")).toBe(false);
    expect(isIishkoComputerToolFamilyName("mcp__other__computer_click")).toBe(false);
    expect(isIishkoComputerToolFamilyName("other_computer_click")).toBe(false);
    expect(isIishkoComputerToolFamilyName("iishko_frobnicate")).toBe(false);
    expect(isIishkoComputerToolFamilyName(undefined)).toBe(false);
    expect(isIishkoComputerToolFamilyName(42)).toBe(false);
  });

  it("requires current capability, active turn and non-Plan interaction", () => {
    const permission = { name: "mcp__iishko__computer_click" };
    const allowed = {
      computerControlEnabled: true,
      activeTurn: true,
      interactionMode: "default" as const,
      runtimeMode: "approval-required" as const,
      permission,
    };
    expect(shouldAllowIishkoComputerProviderTool(allowed)).toBe(true);
    expect(
      shouldAllowIishkoComputerProviderTool({ ...allowed, computerControlEnabled: false }),
    ).toBe(false);
    expect(shouldAllowIishkoComputerProviderTool({ ...allowed, activeTurn: false })).toBe(false);
    expect(shouldAllowIishkoComputerProviderTool({ ...allowed, interactionMode: "plan" })).toBe(
      false,
    );
    expect(shouldAllowIishkoComputerProviderTool({ ...allowed, runtimeMode: "auto" })).toBe(false);
  });
});

describe("IISHKO gateway tool permission name", () => {
  it.each([
    // Claude's fully-qualified spelling pins the exact `mcp__iishko__` server.
    "mcp__iishko__iishko_create_thread",
    "mcp__iishko__computer_click",
    // `<server>_<tool>` reports (OpenCode) with a real catalog name.
    "iishko_iishko_create_thread",
    "iishko_iishko_project_link_repository",
    "iishko_computer_click",
    "iishko_device_list",
    "iishko_browser_run",
    // Bare `iishko_*` catalog names carry the namespace inside the tool name.
    "iishko_project_link_repository",
    "iishko_e2e_review",
  ])("recognizes a IISHKO gateway tool: %s", (providerName) => {
    expect(isIishkoGatewayToolName(providerName)).toBe(true);
  });

  it.each([
    // A user MCP server named `iishko_fs` reports `iishko_fs_<tool>` — the
    // prefix alone must never grant it the auto-approve path.
    "iishko_fs_read",
    "iishko_fs_list_threads",
    "iishko_tools_anything",
    "mcp__iishko_fs__read",
    // The `mcp__iishko__` prefix pins the server, not the tool — the part
    // after it must still be a real catalog name.
    "mcp__iishko__not_a_gateway_tool",
    "mcp__iishko__iishko_create_task",
    "mcp__iishko__iishko_fs_read",
    // Foreign server or entirely unknown names.
    "mcp__other__iishko_create_thread",
    "other_iishko_create_thread",
    "computer_click",
    "browser_click",
    // Names the external-agent MCP surface serves, not the provider gateway.
    "iishko_create_task",
    "iishko_read_task",
    "iishko_overview",
    "iishko_iishko_create_task",
    // Not served by the agent gateway at all.
    "iishko_desktop",
  ])("does not trust a look-alike or foreign name: %s", (providerName) => {
    expect(isIishkoGatewayToolName(providerName)).toBe(false);
  });

  it("accepts a qualified name only when the tool is in the catalog", () => {
    expect(isIishkoGatewayToolName("mcp__iishko__iishko_list_threads")).toBe(true);
    expect(isIishkoGatewayToolName("mcp__iishko__computer_click")).toBe(true);
    expect(
      isIishkoGatewayToolCall({ rawInput: { _toolName: "mcp__iishko__iishko_list_threads" } }),
    ).toBe(true);
  });

  it("never trusts a tool name that only appears in the display title", () => {
    // The title is provider-composed prose — an approval card can render
    // "mcp__iishko__iishko_list_threads" for a request that names no such
    // tool, so the title alone must not authorize anything.
    expect(isIishkoGatewayToolCall({ title: "mcp__iishko__iishko_list_threads" })).toBe(false);
    expect(isIishkoGatewayToolCall({ title: "mcp__iishko__not_a_gateway_tool; rm -rf y" })).toBe(
      false,
    );
  });

  it("rejects non-strings and a look-alike server name in every name field", () => {
    expect(isIishkoGatewayToolName(undefined)).toBe(false);
    expect(isIishkoGatewayToolName(42)).toBe(false);
    expect(isIishkoGatewayToolCall({ name: "iishko_fs_create_thread" })).toBe(false);
    expect(isIishkoGatewayToolCall({ metadata: { toolName: "iishko_fs_read" } })).toBe(false);
    expect(isIishkoGatewayToolCall({ rawInput: { _toolName: "iishko_iishko_send_message" } })).toBe(
      true,
    );
  });
});
