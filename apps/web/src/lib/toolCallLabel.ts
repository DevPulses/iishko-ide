// FILE: toolCallLabel.ts
// Purpose: Normalizes generic tool-call titles and humanizes command executions for timeline rows.
// Layer: UI utility
// Exports: deriveReadableToolTitle, deriveReadableCommandDisplay, deriveFriendlyCommandTarget, command icon classifiers, deriveInlineCommandCall, deriveLiteralCommand, deriveCommandReadTargets, normalizeCompactToolLabel, isGenericToolTitle, extractWebFetchUrl
// Depends on: @iishko/contracts tool lifecycle item types

import type { ToolLifecycleItemType } from "@iishko/contracts";
import { t } from "~/i18n";
import { BROWSER_TOOL_TITLES } from "@iishko/shared/browserAutomationPresentation";
import {
  COMPUTER_TOOL_TITLE_KEYS,
  computerToolName,
  type ComputerToolName,
} from "./computerToolPresentation";
import { basenameOfPath } from "../file-icons";
import { extractToolArgumentField } from "./toolArgumentSummary";

export function normalizeCompactToolLabel(value: string): string {
  return value
    .trimEnd()
    .replace(/\s(?:complete|completed|done|finished|success|succeeded|started|running)$/i, "")
    .trim();
}

// Canonical form for comparing tool display strings (heading vs preview vs
// label): ignores case, whitespace runs, and trailing status words so dedup
// decisions behave identically in the work-log builder and the timeline rows.
export function normalizeToolTextForComparison(value: string | undefined): string {
  return normalizeCompactToolLabel(value ?? "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

// Web-fetch tool calls (e.g. Claude's `WebFetch`) arrive as generic dynamic tool
// calls whose detail is the raw `ToolName: {json}` argument summary. Recognizing
// them lets the timeline surface the target site (favicon + URL) instead of the
// raw JSON arguments.
const WEB_FETCH_TOOL_NAMES = new Set(["webfetch", "fetch", "urlfetch", "fetchurl", "httpfetch"]);

function isWebFetchToolName(toolName: string | null | undefined): boolean {
  if (!toolName) {
    return false;
  }
  const normalized = toolName.toLowerCase().replace(/[^a-z]/g, "");
  if (WEB_FETCH_TOOL_NAMES.has(normalized)) {
    return true;
  }
  return (
    normalized.includes("fetch") &&
    (normalized.includes("web") || normalized.includes("url") || normalized.includes("http"))
  );
}

// Pulls the first http(s) URL out of a web-fetch tool call's argument summary.
// Prefers the JSON `url`/`uri` field (the actual shape) and falls back to a bare
// URL token so a slightly different summary still resolves. Returns null for
// non-fetch tools or when no usable URL is present, so callers fall back to the
// generic tool-call rendering.
export function extractWebFetchUrl(input: {
  readonly toolName?: string | null | undefined;
  readonly detail?: string | null | undefined;
}): string | null {
  if (!isWebFetchToolName(input.toolName)) {
    return null;
  }
  const detail = input.detail;
  if (!detail) {
    return null;
  }
  const candidate =
    extractToolArgumentField(detail, ["url", "uri"]) ??
    /https?:\/\/[^\s"'<>)\]}]+/i.exec(detail)?.[0]?.replace(/[.,;:!?]+$/, "");
  if (candidate && /^https?:\/\//i.test(candidate)) {
    return candidate;
  }
  return null;
}

// Turns internal MCP identifiers into readable inline labels for timeline rows.
function humanizeMcpToolIdentifier(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed.startsWith("mcp__")) {
    return null;
  }

  const [, server, tool, ...rest] = trimmed.split("__");
  const normalizedServer = humanizeMcpToken(server);
  const normalizedTool = [tool, ...rest]
    .map((part) => humanizeMcpToken(part))
    .filter((part) => part.length > 0)
    .join(" ");

  if (!normalizedServer || !normalizedTool) {
    return null;
  }
  return `${normalizedServer}: ${normalizedTool}`;
}

function humanizeMcpServerTool(server: string, tool: string): string | null {
  const normalizedServer = humanizeMcpToken(server);
  const normalizedTool = humanizeMcpToken(tool);
  if (!normalizedServer || !normalizedTool) {
    return null;
  }
  return `${normalizedServer}: ${normalizedTool}`;
}

export interface ReadableToolTitleInput {
  readonly title?: string | null;
  readonly fallbackLabel: string;
  readonly itemType?: ToolLifecycleItemType | undefined;
  readonly requestKind?:
    | "command"
    | "file-read"
    | "file-change"
    | "permissions"
    | "tool"
    | undefined;
  readonly command?: string | null;
  readonly payload?: Record<string, unknown> | null;
  readonly isRunning?: boolean;
}

interface IishkoMcpToolSourcePresentation {
  readonly running: string;
  readonly completed: string;
  readonly failed: string;
}

type IishkoMcpToolPresentation = Readonly<Record<IishkoMcpToolStatus, string>>;

// Historical messages still contain retired tools; presentation does not expose them to agents.
const BROWSER_HISTORY_TITLES = {
  ...BROWSER_TOOL_TITLES,
  browser_snapshot: "Snapshot browser page",
  browser_webmcp_tools: "Discover page WebMCP tools",
  browser_webmcp_call: "Call page WebMCP tool",
  browser_click: "Click browser target",
  browser_hover: "Hover browser target",
  browser_drag: "Drag between browser targets",
  browser_type: "Type into browser target",
  browser_select: "Select browser options",
  browser_press: "Press browser keys",
  browser_scroll: "Scroll browser page",
  browser_wait: "Wait for browser condition",
  browser_evaluate: "Evaluate browser expression",
} as const;
type BrowserHistoryToolName = keyof typeof BROWSER_HISTORY_TITLES;
type IishkoBrowserToolName = `iishko_${BrowserHistoryToolName}`;
const BROWSER_HISTORY_TOOL_NAMES = Object.keys(BROWSER_HISTORY_TITLES) as BrowserHistoryToolName[];
const BROWSER_TOOL_NAME_SET = new Set<string>(BROWSER_HISTORY_TOOL_NAMES);

const IISHKO_BROWSER_TOOL_PRESENTATIONS = Object.fromEntries(
  BROWSER_HISTORY_TOOL_NAMES.map((toolName) => {
    const title = BROWSER_HISTORY_TITLES[toolName];
    return [`iishko_${toolName}`, { running: title, completed: title, failed: title }];
  }),
) as Record<IishkoBrowserToolName, IishkoMcpToolSourcePresentation>;

/**
 * The desktop tools, spoken. Every browser tool had a curated presentation and
 * every computer tool had none, so the most consequential rows in the
 * transcript — an agent moving a pointer on the user's own machine — fell
 * through to the invented "Iishko is handling computer click" fallback.
 *
 * The wording deliberately keeps the machine in the sentence ("this computer's
 * desktop") rather than saying "the desktop", because on the backends that
 * matter it is the user's own.
 */
const IISHKO_COMPUTER_TOOL_PRESENTATIONS = {
  iishko_computer_screenshot: presentComputerTool("taking a screenshot", "took a screenshot"),
  iishko_computer_get_state: presentComputerTool("reading the screen", "read the screen"),
  iishko_computer_get_screen_size: presentComputerTool(
    "measuring the screen",
    "measured the screen",
  ),
  iishko_computer_list_windows: presentComputerTool("listing windows", "listed the windows"),
  iishko_computer_list_apps: presentComputerTool("listing apps", "listed the apps"),
  iishko_computer_verify_state: presentComputerTool(
    "checking desktop state",
    "checked desktop state",
  ),
  iishko_computer_zoom: presentComputerTool("zooming into a window", "zoomed into a window"),
  iishko_computer_get_accessibility_tree: presentComputerTool(
    "listing apps and windows",
    "listed apps and windows",
  ),
  iishko_computer_get_cursor_position: presentComputerTool(
    "reading the cursor position",
    "read the cursor position",
  ),
  iishko_computer_help: presentComputerTool(
    "reading the Computer playbook",
    "read the Computer playbook",
  ),
  iishko_computer_click: presentComputerTool("clicking the desktop", "clicked the desktop"),
  iishko_computer_move_cursor: presentComputerTool("moving the cursor", "moved the cursor"),
  iishko_computer_drag: presentComputerTool("dragging on the desktop", "dragged on the desktop"),
  iishko_computer_scroll: presentComputerTool("scrolling the desktop", "scrolled the desktop"),
  iishko_computer_type_text: presentComputerTool("typing on the desktop", "typed on the desktop"),
  iishko_computer_press_key: presentComputerTool("pressing a key", "pressed a key"),
  iishko_computer_set_value: presentComputerTool("setting a field", "set a field"),
  iishko_computer_select_text: presentComputerTool("selecting text", "selected text"),
  iishko_computer_perform_action: presentComputerTool(
    "activating a control",
    "activated a control",
  ),
  iishko_computer_launch_app: presentComputerTool("opening an app", "opened an app"),
  iishko_computer_activate_window: presentComputerTool("activating a window", "activated a window"),
  iishko_computer_set_window_frame: presentComputerTool(
    "moving or resizing a window",
    "moved or resized a window",
  ),
  iishko_computer_invoke_menu: presentComputerTool("invoking a menu item", "invoked a menu item"),
  iishko_computer_kill_app: presentComputerTool("force-quitting an app", "force-quit an app"),
  iishko_computer_set_window_minimized: presentComputerTool(
    "changing a window's visibility",
    "changed a window's visibility",
  ),
  iishko_computer_set_app_visibility: presentComputerTool(
    "changing an app's visibility",
    "changed an app's visibility",
  ),
  iishko_computer_wait: presentComputerTool("waiting for the desktop", "waited for the desktop"),
  iishko_computer_read_clipboard: presentComputerTool(
    "reading the clipboard",
    "read the clipboard",
  ),
  iishko_computer_write_clipboard: presentComputerTool(
    "writing to the clipboard",
    "wrote to the clipboard",
  ),
  iishko_computer_paste: presentComputerTool("pasting text", "pasted text"),
  iishko_computer_run: presentComputerTool("running a desktop sequence", "ran a desktop sequence"),
  iishko_computer_inspect: presentComputerTool("inspecting the computer", "inspected the computer"),
  iishko_computer_spaces: presentComputerTool(
    "inspecting desktop Spaces",
    "inspected desktop Spaces",
  ),
  iishko_computer_browser_state: presentComputerTool(
    "reading the browser page",
    "read the browser page",
  ),
  iishko_computer_browser_prepare: presentComputerTool("preparing a browser", "prepared a browser"),
  iishko_computer_browser_navigate: presentComputerTool(
    "opening a browser page",
    "opened a browser page",
  ),
  iishko_computer_browser_click: presentComputerTool(
    "clicking in the browser",
    "clicked in the browser",
  ),
  iishko_computer_browser_type: presentComputerTool(
    "typing in a browser field",
    "typed in a browser field",
  ),
  iishko_computer_browser_dialog: presentComputerTool(
    "handling a browser dialog",
    "handled a browser dialog",
  ),
  iishko_computer_browser_upload: presentComputerTool(
    "attaching files in the browser",
    "attached files in the browser",
  ),
  iishko_computer_browser_download: presentComputerTool("downloading a file", "downloaded a file"),
  iishko_computer_browser_pointer: presentComputerTool(
    "using the pointer in the browser",
    "used the pointer in the browser",
  ),
  iishko_computer_browser_press: presentComputerTool(
    "pressing Enter in the browser",
    "pressed Enter in the browser",
  ),
} as const satisfies Record<`iishko_${ComputerToolName}`, IishkoMcpToolSourcePresentation>;

function presentComputerTool(present: string, past: string): IishkoMcpToolSourcePresentation {
  return {
    running: `IISHKO is ${present}`,
    completed: `IISHKO ${past}`,
    failed: `IISHKO couldn't finish ${present}`,
  };
}

const IISHKO_MCP_TOOL_PRESENTATIONS = {
  iishko_context: {
    running: "IISHKO is checking its context",
    completed: "IISHKO checked its context",
    failed: "IISHKO couldn't check its context",
  },
  iishko_capabilities: {
    running: "IISHKO is checking available agents",
    completed: "IISHKO checked available agents",
    failed: "IISHKO couldn't check available agents",
  },
  iishko_overview: {
    running: "IISHKO is gathering an overview",
    completed: "IISHKO gathered an overview",
    failed: "IISHKO couldn't gather an overview",
  },
  iishko_list_allowed_projects: {
    running: "IISHKO is listing allowed projects",
    completed: "IISHKO listed allowed projects",
    failed: "IISHKO couldn't list allowed projects",
  },
  iishko_create_task: {
    running: "IISHKO is creating a task",
    completed: "IISHKO created a task",
    failed: "IISHKO couldn't create a task",
  },
  iishko_wait_for_task: {
    running: "IISHKO is waiting for a task",
    completed: "IISHKO finished waiting for a task",
    failed: "IISHKO couldn't wait for a task",
  },
  iishko_read_task: {
    running: "IISHKO is reading a task",
    completed: "IISHKO read a task",
    failed: "IISHKO couldn't read a task",
  },
  iishko_list_projects: {
    running: "IISHKO is listing projects",
    completed: "IISHKO listed projects",
    failed: "IISHKO couldn't list projects",
  },
  iishko_list_threads: {
    running: "IISHKO is listing threads",
    completed: "IISHKO listed threads",
    failed: "IISHKO couldn't list threads",
  },
  iishko_read_thread: {
    running: "IISHKO is reading a thread",
    completed: "IISHKO read a thread",
    failed: "IISHKO couldn't read a thread",
  },
  iishko_read_thread_activity: {
    running: "IISHKO is reading thread activity",
    completed: "IISHKO read thread activity",
    failed: "IISHKO couldn't read thread activity",
  },
  iishko_read_thread_events: {
    running: "IISHKO is reading thread events",
    completed: "IISHKO read thread events",
    failed: "IISHKO couldn't read thread events",
  },
  iishko_read_thread_runtime_events: {
    running: "IISHKO is reading thread runtime events",
    completed: "IISHKO read thread runtime events",
    failed: "IISHKO couldn't read thread runtime events",
  },
  iishko_diagnose_thread: {
    running: "IISHKO is diagnosing a thread",
    completed: "IISHKO diagnosed a thread",
    failed: "IISHKO couldn't diagnose a thread",
  },
  iishko_create_thread: {
    running: "IISHKO is creating a thread",
    completed: "IISHKO created a thread",
    failed: "IISHKO couldn't create a thread",
  },
  iishko_create_threads: {
    running: "IISHKO is creating threads",
    completed: "IISHKO created threads",
    failed: "IISHKO couldn't create threads",
  },
  iishko_wait_for_threads: {
    running: "IISHKO is waiting for threads",
    completed: "IISHKO finished waiting for threads",
    failed: "IISHKO couldn't wait for threads",
  },
  iishko_send_message: {
    running: "IISHKO is sending a message",
    completed: "IISHKO sent a message",
    failed: "IISHKO couldn't send a message",
  },
  iishko_read_kanban_board: {
    running: "IISHKO is reading the board",
    completed: "IISHKO read the board",
    failed: "IISHKO couldn't read the board",
  },
  iishko_read_kanban_card: {
    running: "IISHKO is reading a board card",
    completed: "IISHKO read a board card",
    failed: "IISHKO couldn't read a board card",
  },
  iishko_create_kanban_task: {
    running: "IISHKO is creating a board task",
    completed: "IISHKO created a board task",
    failed: "IISHKO couldn't create a board task",
  },
  iishko_move_kanban_card: {
    running: "IISHKO is moving a board card",
    completed: "IISHKO moved a board card",
    failed: "IISHKO couldn't move a board card",
  },
  iishko_show_visual: {
    running: "IISHKO is showing a visual",
    completed: "IISHKO showed a visual",
    failed: "IISHKO couldn't show a visual",
  },
  iishko_create_todo: {
    running: "IISHKO is adding a to-do",
    completed: "IISHKO added a to-do",
    failed: "IISHKO couldn't add a to-do",
  },
  iishko_list_todos: {
    running: "IISHKO is reading your to-dos",
    completed: "IISHKO read your to-dos",
    failed: "IISHKO couldn't read your to-dos",
  },
  iishko_update_todo: {
    running: "IISHKO is updating a to-do",
    completed: "IISHKO updated a to-do",
    failed: "IISHKO couldn't update a to-do",
  },
  iishko_interrupt_thread: {
    running: "IISHKO is interrupting a thread",
    completed: "IISHKO interrupted a thread",
    failed: "IISHKO couldn't interrupt a thread",
  },
  iishko_set_thread_title: {
    running: "IISHKO is renaming a thread",
    completed: "IISHKO renamed a thread",
    failed: "IISHKO couldn't rename a thread",
  },
  iishko_set_thread_archived: {
    running: "IISHKO is updating a thread",
    completed: "IISHKO updated a thread",
    failed: "IISHKO couldn't update a thread",
  },
  iishko_create_automation: {
    running: "IISHKO is creating an automation",
    completed: "IISHKO created an automation",
    failed: "IISHKO couldn't create an automation",
  },
  iishko_list_automations: {
    running: "IISHKO is listing automations",
    completed: "IISHKO listed automations",
    failed: "IISHKO couldn't list automations",
  },
  iishko_view_automation: {
    running: "IISHKO is viewing an automation",
    completed: "IISHKO viewed an automation",
    failed: "IISHKO couldn't view an automation",
  },
  iishko_update_automation: {
    running: "IISHKO is updating an automation",
    completed: "IISHKO updated an automation",
    failed: "IISHKO couldn't update an automation",
  },
  iishko_update_automation_memory: {
    running: "IISHKO is updating automation memory",
    completed: "IISHKO updated automation memory",
    failed: "IISHKO couldn't update automation memory",
  },
  iishko_report_automation_result: {
    running: "IISHKO is reporting an automation result",
    completed: "IISHKO reported an automation result",
    failed: "IISHKO couldn't report an automation result",
  },
  iishko_cancel_automation: {
    running: "IISHKO is stopping an automation",
    completed: "IISHKO stopped an automation",
    failed: "IISHKO couldn't stop an automation",
  },
  ...IISHKO_BROWSER_TOOL_PRESENTATIONS,
  ...IISHKO_COMPUTER_TOOL_PRESENTATIONS,
} as const satisfies Record<string, IishkoMcpToolSourcePresentation>;

// Semantic presentation IDs are separate from the source titles used to classify historical events.
const IISHKO_MCP_TOOL_PRESENTATION_KEYS = {
  iishko_computer_screenshot: {
    running: "common:iishkoIsTakingAScreenshot",
    completed: "common:iishkoTookAScreenshot",
    failed: "common:iishkoCouldnTFinishTakingAScreenshot",
    cancelled: "common:iishkoStoppedTakingAScreenshot",
  },
  iishko_computer_get_state: {
    running: "common:iishkoIsReadingTheScreen",
    completed: "common:iishkoReadTheScreen",
    failed: "common:iishkoCouldnTFinishReadingTheScreen",
    cancelled: "common:iishkoStoppedReadingTheScreen",
  },
  iishko_computer_get_screen_size: {
    running: "common:iishkoIsMeasuringTheScreen",
    completed: "common:iishkoMeasuredTheScreen",
    failed: "common:iishkoCouldnTFinishMeasuringTheScreen",
    cancelled: "common:iishkoStoppedMeasuringTheScreen",
  },
  iishko_computer_list_windows: {
    running: "common:iishkoIsListingWindows",
    completed: "common:iishkoListedTheWindows",
    failed: "common:iishkoCouldnTFinishListingWindows",
    cancelled: "common:iishkoStoppedListingWindows",
  },
  iishko_computer_list_apps: {
    running: "common:iishkoIsListingApps",
    completed: "common:iishkoListedTheApps",
    failed: "common:iishkoCouldnTFinishListingApps",
    cancelled: "common:iishkoStoppedListingApps",
  },
  iishko_computer_verify_state: {
    running: "common:iishkoIsCheckingDesktopState",
    completed: "common:iishkoCheckedDesktopState",
    failed: "common:iishkoCouldnTFinishCheckingDesktopState",
    cancelled: "common:iishkoStoppedCheckingDesktopState",
  },
  iishko_computer_zoom: {
    running: "common:iishkoIsZoomingIntoAWindow",
    completed: "common:iishkoZoomedIntoAWindow",
    failed: "common:iishkoCouldnTFinishZoomingIntoAWindow",
    cancelled: "common:iishkoStoppedZoomingIntoAWindow",
  },
  iishko_computer_get_accessibility_tree: {
    running: "common:iishkoIsListingAppsAndWindows",
    completed: "common:iishkoListedAppsAndWindows",
    failed: "common:iishkoCouldnTFinishListingAppsAndWindows",
    cancelled: "common:iishkoStoppedListingAppsAndWindows",
  },
  iishko_computer_get_cursor_position: {
    running: "common:iishkoIsReadingTheCursorPosition",
    completed: "common:iishkoReadTheCursorPosition",
    failed: "common:iishkoCouldnTFinishReadingTheCursorPosition",
    cancelled: "common:iishkoStoppedReadingTheCursorPosition",
  },
  iishko_computer_help: {
    running: "common:iishkoIsReadingTheComputerPlaybook",
    completed: "common:iishkoReadTheComputerPlaybook",
    failed: "common:iishkoCouldnTFinishReadingTheComputerPlaybook",
    cancelled: "common:iishkoStoppedReadingTheComputerPlaybook",
  },
  iishko_computer_click: {
    running: "common:iishkoIsClickingTheDesktop",
    completed: "common:iishkoClickedTheDesktop",
    failed: "common:iishkoCouldnTFinishClickingTheDesktop",
    cancelled: "common:iishkoStoppedClickingTheDesktop",
  },
  iishko_computer_move_cursor: {
    running: "common:iishkoIsMovingTheCursor",
    completed: "common:iishkoMovedTheCursor",
    failed: "common:iishkoCouldnTFinishMovingTheCursor",
    cancelled: "common:iishkoStoppedMovingTheCursor",
  },
  iishko_computer_drag: {
    running: "common:iishkoIsDraggingOnTheDesktop",
    completed: "common:iishkoDraggedOnTheDesktop",
    failed: "common:iishkoCouldnTFinishDraggingOnTheDesktop",
    cancelled: "common:iishkoStoppedDraggingOnTheDesktop",
  },
  iishko_computer_scroll: {
    running: "common:iishkoIsScrollingTheDesktop",
    completed: "common:iishkoScrolledTheDesktop",
    failed: "common:iishkoCouldnTFinishScrollingTheDesktop",
    cancelled: "common:iishkoStoppedScrollingTheDesktop",
  },
  iishko_computer_type_text: {
    running: "common:iishkoIsTypingOnTheDesktop",
    completed: "common:iishkoTypedOnTheDesktop",
    failed: "common:iishkoCouldnTFinishTypingOnTheDesktop",
    cancelled: "common:iishkoStoppedTypingOnTheDesktop",
  },
  iishko_computer_press_key: {
    running: "common:iishkoIsPressingAKey",
    completed: "common:iishkoPressedAKey",
    failed: "common:iishkoCouldnTFinishPressingAKey",
    cancelled: "common:iishkoStoppedPressingAKey",
  },
  iishko_computer_set_value: {
    running: "common:iishkoIsSettingAField",
    completed: "common:iishkoSetAField",
    failed: "common:iishkoCouldnTFinishSettingAField",
    cancelled: "common:iishkoStoppedSettingAField",
  },
  iishko_computer_select_text: {
    running: "common:iishkoIsSelectingText",
    completed: "common:iishkoSelectedText",
    failed: "common:iishkoCouldnTFinishSelectingText",
    cancelled: "common:iishkoStoppedSelectingText",
  },
  iishko_computer_perform_action: {
    running: "common:iishkoIsActivatingAControl",
    completed: "common:iishkoActivatedAControl",
    failed: "common:iishkoCouldnTFinishActivatingAControl",
    cancelled: "common:iishkoStoppedActivatingAControl",
  },
  iishko_computer_launch_app: {
    running: "common:iishkoIsOpeningAnApp",
    completed: "common:iishkoOpenedAnApp",
    failed: "common:iishkoCouldnTFinishOpeningAnApp",
    cancelled: "common:iishkoStoppedOpeningAnApp",
  },
  iishko_computer_activate_window: {
    running: "common:iishkoIsActivatingAWindow",
    completed: "common:iishkoActivatedAWindow",
    failed: "common:iishkoCouldnTFinishActivatingAWindow",
    cancelled: "common:iishkoStoppedActivatingAWindow",
  },
  iishko_computer_set_window_frame: {
    running: "common:iishkoIsMovingOrResizingAWindow",
    completed: "common:iishkoMovedOrResizedAWindow",
    failed: "common:iishkoCouldnTFinishMovingOrResizingAWindow",
    cancelled: "common:iishkoStoppedMovingOrResizingAWindow",
  },
  iishko_computer_invoke_menu: {
    running: "common:iishkoIsInvokingAMenuItem",
    completed: "common:iishkoInvokedAMenuItem",
    failed: "common:iishkoCouldnTFinishInvokingAMenuItem",
    cancelled: "common:iishkoStoppedInvokingAMenuItem",
  },
  iishko_computer_kill_app: {
    running: "common:iishkoIsForceQuittingAnApp",
    completed: "common:iishkoForceQuitAnApp",
    failed: "common:iishkoCouldnTFinishForceQuittingAnApp",
    cancelled: "common:iishkoStoppedForceQuittingAnApp",
  },
  iishko_computer_set_window_minimized: {
    running: "common:iishkoIsChangingAWindowSVisibility",
    completed: "common:iishkoChangedAWindowSVisibility",
    failed: "common:iishkoCouldnTFinishChangingAWindowSVisibility",
    cancelled: "common:iishkoStoppedChangingAWindowSVisibility",
  },
  iishko_computer_set_app_visibility: {
    running: "common:iishkoIsChangingAnAppSVisibility",
    completed: "common:iishkoChangedAnAppSVisibility",
    failed: "common:iishkoCouldnTFinishChangingAnAppSVisibility",
    cancelled: "common:iishkoStoppedChangingAnAppSVisibility",
  },
  iishko_computer_wait: {
    running: "common:iishkoIsWaitingForTheDesktop",
    completed: "common:iishkoWaitedForTheDesktop",
    failed: "common:iishkoCouldnTFinishWaitingForTheDesktop",
    cancelled: "common:iishkoStoppedWaitingForTheDesktop",
  },
  iishko_computer_read_clipboard: {
    running: "common:iishkoIsReadingTheClipboard",
    completed: "common:iishkoReadTheClipboard",
    failed: "common:iishkoCouldnTFinishReadingTheClipboard",
    cancelled: "common:iishkoStoppedReadingTheClipboard",
  },
  iishko_computer_write_clipboard: {
    running: "common:iishkoIsWritingToTheClipboard",
    completed: "common:iishkoWroteToTheClipboard",
    failed: "common:iishkoCouldnTFinishWritingToTheClipboard",
    cancelled: "common:iishkoStoppedWritingToTheClipboard",
  },
  iishko_computer_paste: {
    running: "common:iishkoIsPastingText",
    completed: "common:iishkoPastedText",
    failed: "common:iishkoCouldnTFinishPastingText",
    cancelled: "common:iishkoStoppedPastingText",
  },
  iishko_computer_run: {
    running: "common:iishkoIsRunningADesktopSequence",
    completed: "common:iishkoRanADesktopSequence",
    failed: "common:iishkoCouldnTFinishRunningADesktopSequence",
    cancelled: "common:iishkoStoppedRunningADesktopSequence",
  },
  iishko_computer_inspect: {
    running: "common:iishkoIsInspectingTheComputer",
    completed: "common:iishkoInspectedTheComputer",
    failed: "common:iishkoCouldnTFinishInspectingTheComputer",
    cancelled: "common:iishkoStoppedInspectingTheComputer",
  },
  iishko_computer_spaces: {
    running: "common:iishkoIsInspectingDesktopSpaces",
    completed: "common:iishkoInspectedDesktopSpaces",
    failed: "common:iishkoCouldnTFinishInspectingDesktopSpaces",
    cancelled: "common:iishkoStoppedInspectingDesktopSpaces",
  },
  iishko_computer_browser_state: {
    running: "common:iishkoIsReadingTheBrowserPage",
    completed: "common:iishkoReadTheBrowserPage",
    failed: "common:iishkoCouldnTFinishReadingTheBrowserPage",
    cancelled: "common:iishkoStoppedReadingTheBrowserPage",
  },
  iishko_computer_browser_prepare: {
    running: "common:iishkoIsPreparingABrowser",
    completed: "common:iishkoPreparedABrowser",
    failed: "common:iishkoCouldnTFinishPreparingABrowser",
    cancelled: "common:iishkoStoppedPreparingABrowser",
  },
  iishko_computer_browser_navigate: {
    running: "common:iishkoIsOpeningABrowserPage",
    completed: "common:iishkoOpenedABrowserPage",
    failed: "common:iishkoCouldnTFinishOpeningABrowserPage",
    cancelled: "common:iishkoStoppedOpeningABrowserPage",
  },
  iishko_computer_browser_click: {
    running: "common:iishkoIsClickingInTheBrowser",
    completed: "common:iishkoClickedInTheBrowser",
    failed: "common:iishkoCouldnTFinishClickingInTheBrowser",
    cancelled: "common:iishkoStoppedClickingInTheBrowser",
  },
  iishko_computer_browser_type: {
    running: "common:iishkoIsTypingInABrowserField",
    completed: "common:iishkoTypedInABrowserField",
    failed: "common:iishkoCouldnTFinishTypingInABrowserField",
    cancelled: "common:iishkoStoppedTypingInABrowserField",
  },
  iishko_computer_browser_dialog: {
    running: "common:iishkoIsHandlingABrowserDialog",
    completed: "common:iishkoHandledABrowserDialog",
    failed: "common:iishkoCouldnTFinishHandlingABrowserDialog",
    cancelled: "common:iishkoStoppedHandlingABrowserDialog",
  },
  iishko_computer_browser_upload: {
    running: "common:iishkoIsAttachingFilesInTheBrowser",
    completed: "common:iishkoAttachedFilesInTheBrowser",
    failed: "common:iishkoCouldnTFinishAttachingFilesInTheBrowser",
    cancelled: "common:iishkoStoppedAttachingFilesInTheBrowser",
  },
  iishko_computer_browser_download: {
    running: "common:iishkoIsDownloadingAFile",
    completed: "common:iishkoDownloadedAFile",
    failed: "common:iishkoCouldnTFinishDownloadingAFile",
    cancelled: "common:iishkoStoppedDownloadingAFile",
  },
  iishko_computer_browser_pointer: {
    running: "common:iishkoIsUsingThePointerInTheBrowser",
    completed: "common:iishkoUsedThePointerInTheBrowser",
    failed: "common:iishkoCouldnTFinishUsingThePointerInThe",
    cancelled: "common:iishkoStoppedUsingThePointerInTheBrowser",
  },
  iishko_computer_browser_press: {
    running: "common:iishkoIsPressingEnterInTheBrowser",
    completed: "common:iishkoPressedEnterInTheBrowser",
    failed: "common:iishkoCouldnTFinishPressingEnterInTheBrowser",
    cancelled: "common:iishkoStoppedPressingEnterInTheBrowser",
  },
  iishko_context: {
    running: "chat:iishkoIsCheckingItsContext",
    completed: "chat:iishkoCheckedItsContext",
    failed: "chat:iishkoCouldnTCheckItsContext",
    cancelled: "common:iishkoStoppedCheckingItsContext",
  },
  iishko_capabilities: {
    running: "chat:iishkoIsCheckingAvailableAgents",
    completed: "chat:iishkoCheckedAvailableAgents",
    failed: "chat:iishkoCouldnTCheckAvailableAgents",
    cancelled: "common:iishkoStoppedCheckingAvailableAgents",
  },
  iishko_overview: {
    running: "chat:iishkoIsGatheringAnOverview",
    completed: "chat:iishkoGatheredAnOverview",
    failed: "chat:iishkoCouldnTGatherAnOverview",
    cancelled: "common:iishkoStoppedGatheringAnOverview",
  },
  iishko_list_allowed_projects: {
    running: "chat:iishkoIsListingAllowedProjects",
    completed: "chat:iishkoListedAllowedProjects",
    failed: "chat:iishkoCouldnTListAllowedProjects",
    cancelled: "common:iishkoStoppedListingAllowedProjects",
  },
  iishko_create_task: {
    running: "chat:iishkoIsCreatingATask",
    completed: "chat:iishkoCreatedATask",
    failed: "chat:iishkoCouldnTCreateATask",
    cancelled: "common:iishkoStoppedCreatingATask",
  },
  iishko_wait_for_task: {
    running: "chat:iishkoIsWaitingForATask",
    completed: "chat:iishkoFinishedWaitingForATask",
    failed: "chat:iishkoCouldnTWaitForATask",
    cancelled: "common:iishkoStoppedWaitingForATask",
  },
  iishko_read_task: {
    running: "chat:iishkoIsReadingATask",
    completed: "chat:iishkoReadATask",
    failed: "chat:iishkoCouldnTReadATask",
    cancelled: "common:iishkoStoppedReadingATask",
  },
  iishko_list_projects: {
    running: "chat:iishkoIsListingProjects",
    completed: "chat:iishkoListedProjects",
    failed: "chat:iishkoCouldnTListProjects",
    cancelled: "common:iishkoStoppedListingProjects",
  },
  iishko_list_threads: {
    running: "chat:iishkoIsListingThreads",
    completed: "chat:iishkoListedThreads",
    failed: "chat:iishkoCouldnTListThreads",
    cancelled: "common:iishkoStoppedListingThreads",
  },
  iishko_read_thread: {
    running: "chat:iishkoIsReadingAThread",
    completed: "chat:iishkoReadAThread",
    failed: "chat:iishkoCouldnTReadAThread",
    cancelled: "common:iishkoStoppedReadingAThread",
  },
  iishko_read_thread_activity: {
    running: "chat:iishkoIsReadingThreadActivity",
    completed: "chat:iishkoReadThreadActivity",
    failed: "chat:iishkoCouldnTReadThreadActivity",
    cancelled: "common:iishkoStoppedReadingThreadActivity",
  },
  iishko_read_thread_events: {
    running: "chat:iishkoIsReadingThreadEvents",
    completed: "chat:iishkoReadThreadEvents",
    failed: "chat:iishkoCouldnTReadThreadEvents",
    cancelled: "common:iishkoStoppedReadingThreadEvents",
  },
  iishko_read_thread_runtime_events: {
    running: "chat:iishkoIsReadingThreadRuntimeEvents",
    completed: "chat:iishkoReadThreadRuntimeEvents",
    failed: "chat:iishkoCouldnTReadThreadRuntimeEvents",
    cancelled: "common:iishkoStoppedReadingThreadRuntimeEvents",
  },
  iishko_diagnose_thread: {
    running: "chat:iishkoIsDiagnosingAThread",
    completed: "chat:iishkoDiagnosedAThread",
    failed: "chat:iishkoCouldnTDiagnoseAThread",
    cancelled: "common:iishkoStoppedDiagnosingAThread",
  },
  iishko_create_thread: {
    running: "chat:iishkoIsCreatingAThread",
    completed: "chat:iishkoCreatedAThread",
    failed: "chat:iishkoCouldnTCreateAThread",
    cancelled: "common:iishkoStoppedCreatingAThread",
  },
  iishko_create_threads: {
    running: "chat:iishkoIsCreatingThreads",
    completed: "chat:iishkoCreatedThreads",
    failed: "chat:iishkoCouldnTCreateThreads",
    cancelled: "common:iishkoStoppedCreatingThreads",
  },
  iishko_wait_for_threads: {
    running: "chat:iishkoIsWaitingForThreads",
    completed: "chat:iishkoFinishedWaitingForThreads",
    failed: "chat:iishkoCouldnTWaitForThreads",
    cancelled: "common:iishkoStoppedWaitingForThreads",
  },
  iishko_send_message: {
    running: "chat:iishkoIsSendingAMessage",
    completed: "chat:iishkoSentAMessage",
    failed: "chat:iishkoCouldnTSendAMessage",
    cancelled: "common:iishkoStoppedSendingAMessage",
  },
  iishko_read_kanban_board: {
    running: "chat:iishkoIsReadingTheBoard",
    completed: "chat:iishkoReadTheBoard",
    failed: "chat:iishkoCouldnTReadTheBoard",
    cancelled: "common:iishkoStoppedReadingTheBoard",
  },
  iishko_read_kanban_card: {
    running: "chat:iishkoIsReadingABoardCard",
    completed: "chat:iishkoReadABoardCard",
    failed: "chat:iishkoCouldnTReadABoardCard",
    cancelled: "common:iishkoStoppedReadingABoardCard",
  },
  iishko_create_kanban_task: {
    running: "chat:iishkoIsCreatingABoardTask",
    completed: "chat:iishkoCreatedABoardTask",
    failed: "chat:iishkoCouldnTCreateABoardTask",
    cancelled: "common:iishkoStoppedCreatingABoardTask",
  },
  iishko_move_kanban_card: {
    running: "chat:iishkoIsMovingABoardCard",
    completed: "chat:iishkoMovedABoardCard",
    failed: "chat:iishkoCouldnTMoveABoardCard",
    cancelled: "common:iishkoStoppedMovingABoardCard",
  },
  iishko_show_visual: {
    running: "chat:iishkoIsShowingAVisual",
    completed: "chat:iishkoShowedAVisual",
    failed: "chat:iishkoCouldnTShowAVisual",
    cancelled: "common:iishkoStoppedShowingAVisual",
  },
  iishko_create_todo: {
    running: "chat:iishkoIsAddingAToDo",
    completed: "chat:iishkoAddedAToDo",
    failed: "chat:iishkoCouldnTAddAToDo",
    cancelled: "common:iishkoStoppedAddingAToDo",
  },
  iishko_list_todos: {
    running: "chat:iishkoIsReadingYourToDos",
    completed: "chat:iishkoReadYourToDos",
    failed: "chat:iishkoCouldnTReadYourToDos",
    cancelled: "common:iishkoStoppedReadingYourToDos",
  },
  iishko_update_todo: {
    running: "chat:iishkoIsUpdatingAToDo",
    completed: "chat:iishkoUpdatedAToDo",
    failed: "chat:iishkoCouldnTUpdateAToDo",
    cancelled: "common:iishkoStoppedUpdatingAToDo",
  },
  iishko_interrupt_thread: {
    running: "chat:iishkoIsInterruptingAThread",
    completed: "chat:iishkoInterruptedAThread",
    failed: "chat:iishkoCouldnTInterruptAThread",
    cancelled: "common:iishkoStoppedInterruptingAThread",
  },
  iishko_set_thread_title: {
    running: "chat:iishkoIsRenamingAThread",
    completed: "chat:iishkoRenamedAThread",
    failed: "chat:iishkoCouldnTRenameAThread",
    cancelled: "common:iishkoStoppedRenamingAThread",
  },
  iishko_set_thread_archived: {
    running: "chat:iishkoIsUpdatingAThread",
    completed: "chat:iishkoUpdatedAThread",
    failed: "chat:iishkoCouldnTUpdateAThread",
    cancelled: "common:iishkoStoppedUpdatingAThread",
  },
  iishko_create_automation: {
    running: "chat:iishkoIsCreatingAnAutomation",
    completed: "chat:iishkoCreatedAnAutomation",
    failed: "chat:iishkoCouldnTCreateAnAutomation",
    cancelled: "common:iishkoStoppedCreatingAnAutomation",
  },
  iishko_list_automations: {
    running: "chat:iishkoIsListingAutomations",
    completed: "chat:iishkoListedAutomations",
    failed: "chat:iishkoCouldnTListAutomations",
    cancelled: "common:iishkoStoppedListingAutomations",
  },
  iishko_view_automation: {
    running: "chat:iishkoIsViewingAnAutomation",
    completed: "chat:iishkoViewedAnAutomation",
    failed: "chat:iishkoCouldnTViewAnAutomation",
    cancelled: "common:iishkoStoppedViewingAnAutomation",
  },
  iishko_update_automation: {
    running: "chat:iishkoIsUpdatingAnAutomation",
    completed: "chat:iishkoUpdatedAnAutomation",
    failed: "chat:iishkoCouldnTUpdateAnAutomation",
    cancelled: "common:iishkoStoppedUpdatingAnAutomation",
  },
  iishko_update_automation_memory: {
    running: "chat:iishkoIsUpdatingAutomationMemory",
    completed: "chat:iishkoUpdatedAutomationMemory",
    failed: "chat:iishkoCouldnTUpdateAutomationMemory",
    cancelled: "common:iishkoStoppedUpdatingAutomationMemory",
  },
  iishko_report_automation_result: {
    running: "chat:iishkoIsReportingAnAutomationResult",
    completed: "chat:iishkoReportedAnAutomationResult",
    failed: "chat:iishkoCouldnTReportAnAutomationResult",
    cancelled: "common:iishkoStoppedReportingAnAutomationResult",
  },
  iishko_cancel_automation: {
    running: "chat:iishkoIsStoppingAnAutomation",
    completed: "chat:iishkoStoppedAnAutomation",
    failed: "chat:iishkoCouldnTStopAnAutomation",
    cancelled: "common:iishkoStoppedStoppingAnAutomation",
  },
  iishko_browser_status: {
    running: "common:checkBrowserStatus",
    completed: "common:checkBrowserStatus",
    failed: "common:checkBrowserStatus",
    cancelled: "common:cancelledCheckBrowserStatus",
  },
  iishko_browser_tabs: {
    running: "common:listBrowserTabs",
    completed: "common:listBrowserTabs",
    failed: "common:listBrowserTabs",
    cancelled: "common:cancelledListBrowserTabs",
  },
  iishko_browser_open: {
    running: "common:openBrowserTab",
    completed: "common:openBrowserTab",
    failed: "common:openBrowserTab",
    cancelled: "common:cancelledOpenBrowserTab",
  },
  iishko_browser_navigate: {
    running: "common:navigateBrowserTab",
    completed: "common:navigateBrowserTab",
    failed: "common:navigateBrowserTab",
    cancelled: "common:cancelledNavigateBrowserTab",
  },
  iishko_browser_back: {
    running: "common:goBackInBrowserHistory",
    completed: "common:goBackInBrowserHistory",
    failed: "common:goBackInBrowserHistory",
    cancelled: "common:cancelledGoBackInBrowserHistory",
  },
  iishko_browser_forward: {
    running: "common:goForwardInBrowserHistory",
    completed: "common:goForwardInBrowserHistory",
    failed: "common:goForwardInBrowserHistory",
    cancelled: "common:cancelledGoForwardInBrowserHistory",
  },
  iishko_browser_reload: {
    running: "common:reloadBrowserPage",
    completed: "common:reloadBrowserPage",
    failed: "common:reloadBrowserPage",
    cancelled: "common:cancelledReloadBrowserPage",
  },
  iishko_browser_resize: {
    running: "common:resizeBrowserViewport",
    completed: "common:resizeBrowserViewport",
    failed: "common:resizeBrowserViewport",
    cancelled: "common:cancelledResizeBrowserViewport",
  },
  iishko_browser_screenshot: {
    running: "common:captureBrowserScreenshot",
    completed: "common:captureBrowserScreenshot",
    failed: "common:captureBrowserScreenshot",
    cancelled: "common:cancelledCaptureBrowserScreenshot",
  },
  iishko_browser_logs: {
    running: "common:readBrowserDiagnostics",
    completed: "common:readBrowserDiagnostics",
    failed: "common:readBrowserDiagnostics",
    cancelled: "common:cancelledReadBrowserDiagnostics",
  },
  iishko_browser_upload: {
    running: "common:uploadWorkspaceFiles",
    completed: "common:uploadWorkspaceFiles",
    failed: "common:uploadWorkspaceFiles",
    cancelled: "common:cancelledUploadWorkspaceFiles",
  },
  iishko_browser_run: {
    running: "common:runBrowserActions",
    completed: "common:runBrowserActions",
    failed: "common:runBrowserActions",
    cancelled: "common:cancelledRunBrowserActions",
  },
  iishko_browser_close: {
    running: "common:closeBrowserTab",
    completed: "common:closeBrowserTab",
    failed: "common:closeBrowserTab",
    cancelled: "common:cancelledCloseBrowserTab",
  },
  iishko_browser_snapshot: {
    running: "chat:snapshotBrowserPage",
    completed: "chat:snapshotBrowserPage",
    failed: "chat:snapshotBrowserPage",
    cancelled: "common:cancelledSnapshotBrowserPage",
  },
  iishko_browser_webmcp_tools: {
    running: "chat:discoverPageWebMCPTools",
    completed: "chat:discoverPageWebMCPTools",
    failed: "chat:discoverPageWebMCPTools",
    cancelled: "common:cancelledDiscoverPageWebMCPTools",
  },
  iishko_browser_webmcp_call: {
    running: "chat:callPageWebMCPTool",
    completed: "chat:callPageWebMCPTool",
    failed: "chat:callPageWebMCPTool",
    cancelled: "common:cancelledCallPageWebMCPTool",
  },
  iishko_browser_click: {
    running: "chat:clickBrowserTarget",
    completed: "chat:clickBrowserTarget",
    failed: "chat:clickBrowserTarget",
    cancelled: "common:cancelledClickBrowserTarget",
  },
  iishko_browser_hover: {
    running: "chat:hoverBrowserTarget",
    completed: "chat:hoverBrowserTarget",
    failed: "chat:hoverBrowserTarget",
    cancelled: "common:cancelledHoverBrowserTarget",
  },
  iishko_browser_drag: {
    running: "chat:dragBetweenBrowserTargets",
    completed: "chat:dragBetweenBrowserTargets",
    failed: "chat:dragBetweenBrowserTargets",
    cancelled: "common:cancelledDragBetweenBrowserTargets",
  },
  iishko_browser_type: {
    running: "chat:typeIntoBrowserTarget",
    completed: "chat:typeIntoBrowserTarget",
    failed: "chat:typeIntoBrowserTarget",
    cancelled: "common:cancelledTypeIntoBrowserTarget",
  },
  iishko_browser_select: {
    running: "chat:selectBrowserOptions",
    completed: "chat:selectBrowserOptions",
    failed: "chat:selectBrowserOptions",
    cancelled: "common:cancelledSelectBrowserOptions",
  },
  iishko_browser_press: {
    running: "chat:pressBrowserKeys",
    completed: "chat:pressBrowserKeys",
    failed: "chat:pressBrowserKeys",
    cancelled: "common:cancelledPressBrowserKeys",
  },
  iishko_browser_scroll: {
    running: "chat:scrollBrowserPage",
    completed: "chat:scrollBrowserPage",
    failed: "chat:scrollBrowserPage",
    cancelled: "common:cancelledScrollBrowserPage",
  },
  iishko_browser_wait: {
    running: "chat:waitForBrowserCondition",
    completed: "chat:waitForBrowserCondition",
    failed: "chat:waitForBrowserCondition",
    cancelled: "common:cancelledWaitForBrowserCondition",
  },
  iishko_browser_evaluate: {
    running: "chat:evaluateBrowserExpression",
    completed: "chat:evaluateBrowserExpression",
    failed: "chat:evaluateBrowserExpression",
    cancelled: "common:cancelledEvaluateBrowserExpression",
  },
} as const satisfies Record<
  keyof typeof IISHKO_MCP_TOOL_PRESENTATIONS,
  Record<IishkoMcpToolStatus, string>
>;

function normalizeIishkoMcpIdentifier(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

const IISHKO_BROWSER_TOOL_NAME_BY_PRESENTATION = new Map<string, IishkoBrowserToolName>(
  BROWSER_HISTORY_TOOL_NAMES.map((toolName) => [
    normalizeIishkoMcpIdentifier(BROWSER_HISTORY_TITLES[toolName]),
    `iishko_${toolName}`,
  ]),
);

const IISHKO_MCP_TOOL_PRESENTATION_ENTRIES = Object.entries(IISHKO_MCP_TOOL_PRESENTATIONS).map(
  ([toolName, presentation]) => ({
    toolName,
    presentation,
    normalizedRunning: normalizeIishkoMcpIdentifier(presentation.running),
    normalizedCompleted: normalizeIishkoMcpIdentifier(presentation.completed),
    normalizedFailed: normalizeIishkoMcpIdentifier(presentation.failed),
  }),
);

function extractIishkoMcpToolName(normalizedCandidate: string): string | null {
  if (BROWSER_TOOL_NAME_SET.has(normalizedCandidate)) {
    return `iishko_${normalizedCandidate}`;
  }
  if (normalizedCandidate.startsWith("mcp_iishko_iishko_")) {
    return normalizedCandidate.slice("mcp_iishko_".length);
  }
  if (normalizedCandidate.startsWith("mcp_iishko_")) {
    return `iishko_${normalizedCandidate.slice("mcp_iishko_".length)}`;
  }
  if (normalizedCandidate.startsWith("iishko_iishko_")) {
    return normalizedCandidate.slice("iishko_".length);
  }
  if (normalizedCandidate.startsWith("iishko_")) {
    return normalizedCandidate;
  }
  return null;
}

function resolveIishkoBrowserToolName(
  candidates: ReadonlyArray<string | null | undefined>,
): IishkoBrowserToolName | null {
  for (const candidate of candidates) {
    if (!candidate) continue;
    const normalizedCandidate = normalizeIishkoMcpIdentifier(candidate);
    const extractedToolName = extractIishkoMcpToolName(normalizedCandidate);
    const candidateToolName =
      extractedToolName ??
      IISHKO_BROWSER_TOOL_NAME_BY_PRESENTATION.get(normalizedCandidate) ??
      normalizedCandidate;
    if (candidateToolName in IISHKO_BROWSER_TOOL_PRESENTATIONS) {
      return candidateToolName as IishkoBrowserToolName;
    }
  }
  return null;
}

function fallbackIishkoMcpToolPresentation(
  toolName: string,
  translate: typeof t,
): IishkoMcpToolPresentation {
  const action =
    toolName
      .replace(/^iishko_/, "")
      .replace(/_+/g, " ")
      .trim() || translate("chat:anAction");
  return {
    running: translate("chat:iishkoIsHandling", { action }),
    completed: translate("chat:iishkoHandled", { action }),
    failed: translate("chat:iishkoCouldnTHandle", { action }),
    cancelled: translate("chat:iishkoStoppedHandling", { action }),
  };
}

function localizeIishkoMcpToolPresentation(
  toolName: keyof typeof IISHKO_MCP_TOOL_PRESENTATIONS,
  translate: typeof t,
): IishkoMcpToolPresentation {
  const keys = IISHKO_MCP_TOOL_PRESENTATION_KEYS[toolName];
  return {
    running: translate(keys.running),
    completed: translate(keys.completed),
    failed: translate(keys.failed),
    cancelled: translate(keys.cancelled),
  };
}

function resolveIishkoMcpToolPresentation(
  candidates: ReadonlyArray<string | null | undefined>,
  translate: typeof t,
): IishkoMcpToolPresentation | null {
  for (const candidate of candidates) {
    if (!candidate) {
      continue;
    }
    const normalizedCandidate = normalizeIishkoMcpIdentifier(candidate);
    for (const entry of IISHKO_MCP_TOOL_PRESENTATION_ENTRIES) {
      if (
        normalizedCandidate === entry.normalizedRunning ||
        normalizedCandidate === entry.normalizedCompleted ||
        normalizedCandidate === entry.normalizedFailed
      ) {
        return localizeIishkoMcpToolPresentation(
          entry.toolName as keyof typeof IISHKO_MCP_TOOL_PRESENTATIONS,
          translate,
        );
      }
    }
    const toolName = extractIishkoMcpToolName(normalizedCandidate);
    const knownPresentation = toolName
      ? (IISHKO_MCP_TOOL_PRESENTATIONS[toolName as keyof typeof IISHKO_MCP_TOOL_PRESENTATIONS] as
          | IishkoMcpToolSourcePresentation
          | undefined)
      : undefined;
    if (knownPresentation) {
      return localizeIishkoMcpToolPresentation(
        toolName as keyof typeof IISHKO_MCP_TOOL_PRESENTATIONS,
        translate,
      );
    }
    // Free-text summaries (e.g. reconciler activity lines) can begin with the
    // word "Iishko" and normalize into a fake tool identifier; only
    // identifier-shaped candidates may take an invented fallback presentation.
    if (/\s/.test(candidate.trim())) {
      continue;
    }
    if (normalizedCandidate.startsWith("iishko_is_handling_")) {
      return fallbackIishkoMcpToolPresentation(
        `iishko_${normalizedCandidate.slice("iishko_is_handling_".length)}`,
        translate,
      );
    }
    if (normalizedCandidate.startsWith("iishko_handled_")) {
      return fallbackIishkoMcpToolPresentation(
        `iishko_${normalizedCandidate.slice("iishko_handled_".length)}`,
        translate,
      );
    }
    if (normalizedCandidate.startsWith("iishko_couldn_t_handle_")) {
      return fallbackIishkoMcpToolPresentation(
        `iishko_${normalizedCandidate.slice("iishko_couldn_t_handle_".length)}`,
        translate,
      );
    }
    if (!toolName) {
      continue;
    }
    return fallbackIishkoMcpToolPresentation(toolName, translate);
  }
  return null;
}

export type IishkoMcpToolStatus = "running" | "completed" | "failed" | "cancelled";

export interface IishkoMcpToolTitleInput {
  readonly toolName?: string | null | undefined;
  readonly title?: string | null | undefined;
  readonly fallbackLabel?: string | null | undefined;
  readonly status?: IishkoMcpToolStatus | undefined;
}

export function isIishkoBrowserToolCall(input: IishkoMcpToolTitleInput): boolean {
  return resolveIishkoBrowserToolName([input.toolName, input.title, input.fallbackLabel]) !== null;
}

// Every provider exposes Iishko's MCP tools differently: MCP, dynamic, and even
// file-change rows can all represent the same gateway action. Normalize by tool
// identity instead of provider item type so transport details never reach the UI.
export function deriveIishkoMcpToolTitle(
  input: IishkoMcpToolTitleInput,
  translate: typeof t = t,
): string | null {
  const presentation = resolveIishkoMcpToolPresentation(
    [input.toolName, input.title, input.fallbackLabel],
    translate,
  );
  if (!presentation) {
    return null;
  }
  return presentation[input.status ?? "completed"];
}

export function sanitizeIishkoMcpToolPreview(
  input: {
    readonly preview?: string | null | undefined;
    readonly heading: string;
    readonly status?: IishkoMcpToolStatus | undefined;
  },
  translate: typeof t = t,
): string | null {
  const preview = input.preview?.trim();
  if (!preview) return null;
  const previewTitle = deriveIishkoMcpToolTitle(
    { title: preview, status: input.status },
    translate,
  );
  if (
    previewTitle &&
    normalizeToolTextForComparison(previewTitle) === normalizeToolTextForComparison(input.heading)
  ) {
    return null;
  }
  return preview;
}

export function deriveReadableToolTitle(
  input: ReadableToolTitleInput,
  translate: typeof t = t,
): string | null {
  const normalizedTitle = normalizeCompactToolLabel(input.title ?? "");
  const normalizedFallback = normalizeCompactToolLabel(input.fallbackLabel);
  const commandLabel = input.command
    ? deriveReadableCommandDisplay(input.command, input.isRunning, translate).verb
    : null;
  const commandLike = input.itemType === "command_execution" || input.requestKind === "command";

  // Derive a verbal label from requestKind when the title is generic
  const requestKindLabel = humanizeRequestKind(input.requestKind, input.itemType, translate);

  if (normalizedTitle.length > 0 && !isGenericToolTitle(normalizedTitle)) {
    return (input.itemType === "mcp_tool_call" || input.itemType === "dynamic_tool_call") &&
      /[_-]/.test(normalizedTitle)
      ? (normalizeToolDescriptor(normalizedTitle, translate) ?? normalizedTitle)
      : normalizedTitle;
  }

  if (commandLike && commandLabel) {
    return commandLabel;
  }

  const descriptor = normalizeToolDescriptor(
    extractToolDescriptorFromPayload(input.payload),
    translate,
  );
  if (descriptor && !isGenericToolTitle(descriptor)) {
    return descriptor;
  }

  // A generic request kind describes the transport, while the payload can name
  // the actual tool. Only use it after the provider metadata has been checked.
  if (requestKindLabel) {
    return requestKindLabel;
  }

  if (normalizedFallback.length > 0 && !isGenericToolTitle(normalizedFallback)) {
    return normalizedFallback;
  }
  if (normalizedTitle.length > 0) {
    return normalizedTitle;
  }
  if (normalizedFallback.length > 0) {
    return normalizedFallback;
  }
  return null;
}

export interface ReadableCommandDisplay {
  readonly verb: string;
  readonly target: string;
  readonly fullCommand: string;
}

// "read" and "search" split the read-only inspections so a file read and a
// pattern search wear different glyphs; listings (`ls`) are plain commands.
export type CommandVisualKind = "read" | "search" | "git" | "github" | "terminal";

function humanizeRequestKind(
  requestKind: ReadableToolTitleInput["requestKind"],
  itemType: ReadableToolTitleInput["itemType"],
  translate: typeof t,
): string | null {
  if (requestKind === "file-read") return translate("chat:detail_read", { context: "command" });
  if (requestKind === "file-change" || itemType === "file_change")
    return translate("chat:timeline_edited");
  if (requestKind === "tool") return translate("chat:tool");
  // Don't handle command types here — let humanizeCommandToolLabel produce more specific labels
  if (itemType === "web_search") return translate("chat:searchedTheWeb");
  if (itemType === "image_generation") return translate("chat:generatedImage_generatedImage");
  if (itemType === "image_view") return translate("chat:viewedImage");
  if (itemType === "collab_agent_tool_call") return translate("chat:agentTask");
  return null;
}

export function isGenericToolTitle(value: string): boolean {
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return (
    normalized === "tool" ||
    normalized === "tool call" ||
    normalized === "dynamic tool call" ||
    normalized === "mcp tool call" ||
    normalized === "agent task" ||
    normalized === "subagent task" ||
    normalized === "task" ||
    normalized === "command run" ||
    normalized === "ran command" ||
    normalized === "running command" ||
    normalized === "command execution" ||
    normalized === "file change" ||
    normalized === "find" ||
    normalized === "read file"
  );
}

function normalizeToolDescriptor(value: string | null, translate: typeof t): string | null {
  if (!value) {
    return null;
  }
  const computerTool = computerToolName(value);
  if (computerTool) {
    return translate(COMPUTER_TOOL_TITLE_KEYS[computerTool], { context: "computerTool" });
  }
  const mcpIdentifier = humanizeMcpToolIdentifier(value);
  if (mcpIdentifier) {
    return mcpIdentifier;
  }
  const normalized = value.replace(/[_-]/g, " ").replace(/\s+/g, " ").trim();
  if (!normalized) {
    return null;
  }
  const dedupedTokens: string[] = [];
  for (const token of normalized.split(" ")) {
    if (dedupedTokens.at(-1)?.toLowerCase() === token.toLowerCase()) {
      continue;
    }
    dedupedTokens.push(token);
  }
  const collapsed = dedupedTokens.join(" ").trim();
  if (!collapsed) {
    return null;
  }
  const lowerCollapsed = collapsed.toLowerCase();
  if (lowerCollapsed === "read") {
    return translate("chat:detail_read", { context: "command" });
  }
  if (lowerCollapsed === "search" || lowerCollapsed === "find" || lowerCollapsed === "searched") {
    return translate("workspace:primaryActions_search");
  }
  const readable = /[_-]/.test(value) ? humanizeMcpToken(collapsed) : collapsed;
  return readable.length > 64 ? `${readable.slice(0, 61).trimEnd()}...` : readable;
}

function humanizeMcpToken(value: string | undefined): string {
  if (!value) {
    return "";
  }
  const normalized = value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized) {
    return "";
  }

  return normalized
    .split(" ")
    .map((token) => {
      const lower = token.toLowerCase();
      if (lower === "mcp") return "MCP";
      if (token.toUpperCase() === token && token.length <= 5) return token;
      return `${lower.charAt(0).toUpperCase()}${lower.slice(1)}`;
    })
    .join(" ");
}

function extractToolDescriptorFromPayload(
  payload: Record<string, unknown> | null | undefined,
): string | null {
  if (!payload) {
    return null;
  }
  const mcpServerTool = extractMcpServerToolDescriptor(payload, 0);
  if (mcpServerTool) {
    return mcpServerTool;
  }
  const descriptorKeys = ["kind", "name", "tool", "tool_name", "toolName", "title"];
  const candidates: string[] = [];
  collectDescriptorCandidates(payload, descriptorKeys, candidates, 0);
  for (const candidate of candidates) {
    const normalized = candidate.trim();
    if (!normalized) {
      continue;
    }
    if (isGenericToolTitle(normalizeCompactToolLabel(normalized))) {
      continue;
    }
    return normalized;
  }
  return null;
}

function extractMcpServerToolDescriptor(value: unknown, depth: number): string | null {
  const pair = findMcpServerToolPair(value, depth);
  return pair ? humanizeMcpServerTool(pair.server, pair.tool) : null;
}

// Codex reports MCP calls as `{ server, tool }` somewhere inside the payload.
function findMcpServerToolPair(
  value: unknown,
  depth: number,
): { readonly server: string; readonly tool: string } | null {
  if (depth > 4 || !value || typeof value !== "object") {
    return null;
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      const nested = findMcpServerToolPair(entry, depth + 1);
      if (nested) {
        return nested;
      }
    }
    return null;
  }

  const record = value as Record<string, unknown>;
  if (typeof record.server === "string" && typeof record.tool === "string") {
    return { server: record.server, tool: record.tool };
  }
  for (const nestedKey of [
    "item",
    "data",
    "event",
    "payload",
    "result",
    "input",
    "call",
    "invocation",
    "source",
  ]) {
    const nested = findMcpServerToolPair(record[nestedKey], depth + 1);
    if (nested) {
      return nested;
    }
  }
  return null;
}

/**
 * The MCP server behind a tool call: Claude names tools `mcp__<server>__<tool>`,
 * Codex reports a `{ server, tool }` pair in the payload. Null for other tools.
 */
export function extractMcpServerName(
  toolName: string | null | undefined,
  payload: unknown,
): string | null {
  const trimmed = toolName?.trim() ?? "";
  if (trimmed.startsWith("mcp__")) {
    const server = trimmed.split("__")[1]?.trim();
    if (server) return server;
  }
  const server = findMcpServerToolPair(payload, 0)?.server.trim();
  return server ? server : null;
}

function collectDescriptorCandidates(
  value: unknown,
  keys: ReadonlyArray<string>,
  target: string[],
  depth: number,
) {
  if (depth > 4 || target.length >= 24) {
    return;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed) {
      target.push(trimmed);
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      collectDescriptorCandidates(entry, keys, target, depth + 1);
      if (target.length >= 24) {
        return;
      }
    }
    return;
  }
  if (!value || typeof value !== "object") {
    return;
  }

  const record = value as Record<string, unknown>;
  for (const key of keys) {
    if (typeof record[key] === "string") {
      const trimmed = (record[key] as string).trim();
      if (trimmed) {
        target.push(trimmed);
      }
    }
  }
  for (const nestedKey of ["item", "data", "event", "payload", "result", "input", "tool", "call"]) {
    if (nestedKey in record) {
      collectDescriptorCandidates(record[nestedKey], keys, target, depth + 1);
      if (target.length >= 24) {
        return;
      }
    }
  }
}

// Read-only inspection commands: file reads wear the file glyph, searches and
// finds the magnifier; listings and everything else keep the terminal icon.
// These sets are the single source of truth for both the command labels below
// and the icon decision.
const READ_FILE_COMMAND_TOOLS = new Set(["cat", "nl", "head", "tail", "sed", "less", "more"]);
const SEARCH_COMMAND_TOOLS = new Set(["rg", "grep", "ag", "ack"]);
const FIND_COMMAND_TOOLS = new Set(["find", "fd"]);
const LIST_COMMAND_TOOLS = new Set(["ls"]);

// Derives the compact command sentence shown inline while preserving the full command for hover/detail UI.
export function deriveReadableCommandDisplay(
  rawCommand: string,
  isRunning = false,
  translate: typeof t = t,
): ReadableCommandDisplay {
  const command = stripCommandDisplayWrappers(unwrapShellCommandIfPresent(rawCommand));
  const primaryCommand = firstShellCommandSegment(command);
  const [tool, args] = splitToolAndArgs(primaryCommand);

  if (READ_FILE_COMMAND_TOOLS.has(tool)) {
    return {
      verb: translate(isRunning ? "chat:reading" : "chat:detail_read", { context: "command" }),
      target: lastPathComponents(args, translate("common:file"), translate),
      fullCommand: rawCommand,
    };
  }
  if (SEARCH_COMMAND_TOOLS.has(tool)) {
    return {
      verb: translate(isRunning ? "chat:searching" : "chat:searched", { context: "command" }),
      target: searchSummary(args, translate),
      fullCommand: rawCommand,
    };
  }
  if (LIST_COMMAND_TOOLS.has(tool)) {
    return {
      verb: translate(isRunning ? "chat:listing" : "chat:listed", { context: "command" }),
      target: lastPathComponents(args, translate("workspace:directory"), translate),
      fullCommand: rawCommand,
    };
  }
  if (FIND_COMMAND_TOOLS.has(tool)) {
    return {
      verb: translate(isRunning ? "chat:finding" : "chat:found", { context: "command" }),
      target: findTarget(args, translate("chat:files"), translate),
      fullCommand: rawCommand,
    };
  }

  switch (tool) {
    case "mkdir":
      return {
        verb: translate(isRunning ? "chat:creating" : "settings:created", { context: "command" }),
        target: lastPathComponents(args, translate("workspace:directory"), translate),
        fullCommand: rawCommand,
      };
    case "rm":
      return {
        verb: translate(isRunning ? "chat:removing" : "chat:removed", { context: "command" }),
        target: lastPathComponents(args, translate("common:file"), translate),
        fullCommand: rawCommand,
      };
    case "cp":
    case "mv":
      return {
        verb: translate(
          isRunning
            ? tool === "cp"
              ? "chat:copying"
              : "chat:moving"
            : tool === "cp"
              ? "chat:theme_copied"
              : "chat:moved",
          { context: "command" },
        ),
        target: lastPathComponents(args, translate("common:file"), translate),
        fullCommand: rawCommand,
      };
    case "git":
      return humanizeGitCommand(args, rawCommand, isRunning, translate);
    case "node":
    case "bun":
    case "deno":
    case "python":
    case "python3":
    case "ruby":
    case "perl":
      return {
        verb: translate(isRunning ? "chat:runStatus_running" : "chat:ran", { context: "command" }),
        target: inlineScriptTarget(tool, command, args, translate) ?? compactInlineCommand(command),
        fullCommand: rawCommand,
      };
    case "osascript":
      return {
        verb: translate(isRunning ? "chat:runStatus_running" : "chat:ran", { context: "command" }),
        target: "AppleScript",
        fullCommand: rawCommand,
      };
    default:
      return {
        verb: translate(isRunning ? "chat:runStatus_running" : "chat:ran", { context: "command" }),
        target: compactInlineCommand(command),
        fullCommand: rawCommand,
      };
  }
}

function firstCommandExecutable(rawCommand: string): string {
  const trimmed = rawCommand.trim();
  const match = /^(?:"([^"]+)"|'([^']+)'|(\S+))/u.exec(trimmed);
  const executable = match?.[1] ?? match?.[2] ?? match?.[3] ?? "";
  return executable.split(/[\\/]/u).at(-1)?.toLowerCase() ?? "";
}

// The object half of a command row's sentence ("Searched <for foo in src>"),
// kept short enough to read inline. Shell wrappers that carry no meaning for a
// human (a full pwsh.exe path) collapse to the shell's friendly name.
export function deriveFriendlyCommandTarget(rawCommand: string): string {
  const executable = firstCommandExecutable(rawCommand);
  if (
    executable === "pwsh" ||
    executable === "pwsh.exe" ||
    executable === "powershell" ||
    executable === "powershell.exe"
  ) {
    return "PowerShell";
  }
  if (executable === "cmd" || executable === "cmd.exe") {
    return t("chat:commandPrompt");
  }

  const target = deriveReadableCommandDisplay(rawCommand).target.trim();
  return target.length <= 72 ? target : `${target.slice(0, 69).trimEnd()}…`;
}

// Classifies command rows for transcript glyphs after peeling away shell/env wrappers.
// This keeps `git -C`, `env ... gh`, and `/bin/zsh -lc "cd ... && git ..."` visually branded.
export function resolveCommandVisualKind(rawCommand: string): CommandVisualKind {
  if (deriveCommandReadTargets(rawCommand) !== null) {
    return "read";
  }
  const command = stripCommandDisplayWrappers(unwrapShellCommandIfPresent(rawCommand));
  const [tool] = splitToolAndArgs(firstShellCommandSegment(command));
  if (SEARCH_COMMAND_TOOLS.has(tool) || FIND_COMMAND_TOOLS.has(tool)) {
    return "search";
  }
  if (tool === "git") {
    return "git";
  }
  if (tool === "gh" || tool === "hub") {
    return "github";
  }
  return "terminal";
}

export function deriveInlineCommandCall(rawCommand: string): string {
  return stripCommandDisplayWrappers(unwrapShellCommandIfPresent(rawCommand));
}

// The command a row shows: what actually ran, minus the shell wrapper
// (`/bin/zsh -lc "…"`) and leading `cd <dir> &&` preambles. Pipes, chains and
// quoting stay verbatim, unlike `deriveInlineCommandCall`, which keeps only the
// first pipeline stage for classification.
export function deriveLiteralCommand(rawCommand: string): string {
  let value = rawCommand.trim();
  const lowered = value.toLowerCase();
  for (const prefix of SHELL_WRAPPER_PREFIXES) {
    if (!lowered.startsWith(prefix)) {
      continue;
    }
    value = value.slice(prefix.length).trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1).trim();
    }
    break;
  }
  return stripLeadingShellPreambles(value).replace(/\s+/g, " ").trim();
}

// Files a command only reads, or null when the command does anything else.
// A row may say "Read <file>" instead of the literal command only when that
// is the whole story: no pipes, chains, redirects or substitutions, and no
// in-place edit (`sed -i`).
export function deriveCommandReadTargets(rawCommand: string): string[] | null {
  const literal = deriveLiteralCommand(rawCommand);
  if (literal.length === 0 || hasUnquotedShellOperator(literal)) {
    return null;
  }
  const [tool, args] = splitToolAndArgs(stripCommandDisplayWrappers(literal));
  if (!READ_FILE_COMMAND_TOOLS.has(tool)) {
    return null;
  }
  const tokens = tokenizeCommandArgs(args);
  const files: string[] = [];
  let skipNext = false;
  let sedScriptPending = tool === "sed";
  let sedPrintOnly = false;
  for (const token of tokens) {
    if (skipNext) {
      skipNext = false;
      continue;
    }
    if (token.startsWith("-") && token.length > 1) {
      if (tool === "sed") {
        if (token === "-i" || token.startsWith("-i") || token.startsWith("--in-place")) {
          return null;
        }
        if (token === "-n" || token === "--quiet" || token === "--silent") {
          sedPrintOnly = true;
        }
        if (token === "-e" || token === "--expression") {
          sedScriptPending = false;
          skipNext = true;
        }
      }
      if ((tool === "head" || tool === "tail") && (token === "-n" || token === "-c")) {
        skipNext = true;
      }
      continue;
    }
    if (sedScriptPending) {
      sedScriptPending = false;
      continue;
    }
    files.push(compactPath(token));
  }
  if (tool === "sed" && !sedPrintOnly) {
    return null;
  }
  return files.length > 0 ? files : null;
}

const SHELL_WRAPPER_PREFIXES = [
  "/usr/bin/bash -lc ",
  "/usr/bin/bash -c ",
  "/bin/bash -lc ",
  "/bin/bash -c ",
  "/usr/bin/zsh -lc ",
  "/usr/bin/zsh -c ",
  "/bin/zsh -lc ",
  "/bin/zsh -c ",
  "/bin/sh -lc ",
  "/bin/sh -c ",
  "bash -lc ",
  "bash -c ",
  "zsh -lc ",
  "zsh -c ",
  "sh -lc ",
  "sh -c ",
];

// Pipes, chains, redirects, background jobs and substitutions outside quotes.
function hasUnquotedShellOperator(value: string): boolean {
  let quote: '"' | "'" | null = null;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (char === "\\") {
      index += 1;
      continue;
    }
    if (quote) {
      if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (
      char === "|" ||
      char === "&" ||
      char === ";" ||
      char === ">" ||
      char === "<" ||
      char === "`" ||
      (char === "$" && value[index + 1] === "(")
    ) {
      return true;
    }
  }
  return false;
}

function humanizeGitCommand(
  args: string,
  rawCommand: string,
  isRunning: boolean,
  translate: typeof t,
): ReadableCommandDisplay {
  const normalizedArgs = stripGitGlobalOptions(args);
  const subcommand = normalizedArgs.split(/\s+/, 1)[0]?.toLowerCase() ?? "";
  switch (subcommand) {
    case "status":
      return {
        verb: translate(isRunning ? "chat:providerModelPicker_checking" : "chat:checked", {
          context: "command",
        }),
        target: "git status",
        fullCommand: rawCommand,
      };
    case "diff":
      return {
        verb: translate(isRunning ? "chat:comparing" : "chat:compared", { context: "command" }),
        target: translate("chat:changes"),
        fullCommand: rawCommand,
      };
    case "show":
      return {
        verb: translate(isRunning ? "chat:inspecting" : "chat:inspected", { context: "command" }),
        target: "commit",
        fullCommand: rawCommand,
      };
    case "log":
      return {
        verb: translate(isRunning ? "chat:reviewing" : "chat:reviewed", { context: "command" }),
        target: translate("chat:gitHistory"),
        fullCommand: rawCommand,
      };
    case "add":
      return {
        verb: translate(isRunning ? "chat:staging" : "git:gitPanel_staged", { context: "command" }),
        target: translate("chat:changes"),
        fullCommand: rawCommand,
      };
    case "commit":
      return {
        verb: translate(isRunning ? "chat:committing" : "chat:committed", { context: "command" }),
        target: translate("chat:changes"),
        fullCommand: rawCommand,
      };
    case "push":
      return {
        verb: translate(isRunning ? "chat:pushing" : "workspace:pushed", { context: "command" }),
        target: translate("chat:toRemote"),
        fullCommand: rawCommand,
      };
    case "pull":
      return {
        verb: translate(isRunning ? "chat:pulling" : "chat:pulled", { context: "command" }),
        target: translate("chat:fromRemote"),
        fullCommand: rawCommand,
      };
    case "checkout":
    case "switch":
      return {
        verb: translate(isRunning ? "chat:switchingTo" : "chat:switchedTo", { context: "command" }),
        target: checkoutTarget(args, translate),
        fullCommand: rawCommand,
      };
    default:
      return {
        verb: translate(isRunning ? "chat:runStatus_running" : "chat:ran", { context: "command" }),
        target: compactInlineCommand(`git ${normalizedArgs}`.trim()),
        fullCommand: rawCommand,
      };
  }
}

function stripGitGlobalOptions(args: string): string {
  const tokens = tokenizeCommandArgs(args);
  let index = 0;
  while (index < tokens.length) {
    const token = tokens[index]!;
    if (token === "-C" || token === "-c" || token === "--git-dir" || token === "--work-tree") {
      index += 2;
      continue;
    }
    if (
      token.startsWith("-C") ||
      token.startsWith("-c") ||
      token.startsWith("--git-dir=") ||
      token.startsWith("--work-tree=")
    ) {
      index += 1;
      continue;
    }
    if (token.startsWith("--")) {
      index += 1;
      continue;
    }
    break;
  }
  return tokens.slice(index).join(" ");
}

function checkoutTarget(args: string, translate: typeof t): string {
  const branch = tokenizeCommandArgs(args).at(-1)?.trim();
  return branch ? branch : translate("common:branch");
}

function lastPathComponents(args: string, fallback: string, translate: typeof t): string {
  const tokens = tokenizeCommandArgs(args);
  for (let index = tokens.length - 1; index >= 0; index -= 1) {
    const token = tokens[index]!.replace(/^['"]|['"]$/g, "");
    if (!token || token.startsWith("-")) {
      continue;
    }
    return compactPath(token, true, translate);
  }
  return fallback;
}

function findTarget(args: string, fallback: string, translate: typeof t): string {
  const tokens = tokenizeCommandArgs(args);
  let skipNext = false;
  for (const token of tokens) {
    if (skipNext) {
      skipNext = false;
      continue;
    }
    if (token.startsWith("-")) {
      if (
        token === "-maxdepth" ||
        token === "-mindepth" ||
        token === "-name" ||
        token === "-type" ||
        token === "-path"
      ) {
        skipNext = true;
      }
      continue;
    }
    return compactPath(token, true, translate);
  }
  return fallback;
}

function compactPath(path: string, localized = false, translate: typeof t = t): string {
  if (path === ".") {
    return localized ? translate("chat:currentDirectory") : "current directory";
  }
  if (path === "..") {
    return localized ? translate("chat:parentDirectory") : "parent directory";
  }
  const parts = path.split(/[\\/]/).filter(Boolean);
  if (parts.length <= 2) {
    return path;
  }
  return parts.slice(-2).join("/");
}

function compactInlineCommand(command: string): string {
  const normalized = command.replace(/\s+/g, " ").trim();
  if (normalized.length <= 140) {
    return normalized;
  }
  return `${normalized.slice(0, 137).trimEnd()}...`;
}

function firstShellCommandSegment(command: string): string {
  const chain = findShellChain(command);
  return chain ? command.slice(0, chain.operatorStart).trim() : command;
}

function inlineScriptTarget(
  tool: string,
  command: string,
  args: string,
  translate: typeof t,
): string | null {
  const normalizedTool = tool === "python3" ? "python" : tool;
  if (containsHeredoc(command) || hasInlineScriptFlag(args)) {
    return translate("chat:script", { tool: normalizedTool });
  }
  return null;
}

function containsHeredoc(command: string): boolean {
  return /(^|\s)<<-?\s*['"]?[A-Za-z0-9_]+/.test(command);
}

function hasInlineScriptFlag(args: string): boolean {
  const tokens = tokenizeCommandArgs(args);
  return tokens.some((token) => token === "-e" || token === "-c" || token.startsWith("-e="));
}

function searchSummary(args: string, translate: typeof t): string {
  const { pattern, path, directoryReference } = extractSearchPatternAndPath(args);
  const displayPath = directoryReference
    ? translate(path === "parent directory" ? "chat:parentDirectory" : "chat:currentDirectory")
    : path;
  if (pattern && path) {
    return translate("chat:forIn", { pattern, path: displayPath });
  }
  if (pattern) {
    return translate("chat:for", { pattern });
  }
  if (path) {
    return translate("chat:in", { path: displayPath });
  }
  return translate("chat:files");
}

function extractSearchPatternAndPath(args: string): {
  pattern: string | null;
  path: string | null;
  directoryReference: boolean;
} {
  const tokens = tokenizeCommandArgs(args);
  let pattern: string | null = null;
  let path: string | null = null;
  let directoryReference = false;
  let skipNext = false;

  for (const token of tokens) {
    if (skipNext) {
      skipNext = false;
      continue;
    }
    if (token.startsWith("-")) {
      if (
        token === "-t" ||
        token === "-g" ||
        token === "--type" ||
        token === "--glob" ||
        token === "--max-count"
      ) {
        skipNext = true;
      }
      continue;
    }
    if (!pattern) {
      const normalizedPattern = normalizeSearchPatternToken(token);
      if (!normalizedPattern) {
        const normalizedPath = normalizeSearchPathToken(token);
        if (normalizedPath && (!path || path === "current directory")) {
          path = normalizedPath;
          directoryReference = token.trim() === "." || token.trim() === "..";
        }
        continue;
      }
      pattern = normalizedPattern;
      continue;
    }
    if (!path || path === "current directory") {
      const normalizedPath = normalizeSearchPathToken(token);
      if (normalizedPath) {
        path = normalizedPath;
        directoryReference = token.trim() === "." || token.trim() === "..";
      }
      continue;
    }
  }

  if (pattern && path === "current directory" && looksLikeSearchPath(pattern)) {
    path = normalizeSearchPathToken(pattern);
    directoryReference = false;
    pattern = null;
  }

  return { pattern, path, directoryReference };
}

function normalizeSearchPatternToken(token: string): string | null {
  const trimmed = token.trim();
  if (!trimmed || trimmed === "." || trimmed === "..") {
    return null;
  }
  if (!/[a-z0-9]/i.test(trimmed)) {
    return null;
  }
  return trimmed.length > 30 ? `${trimmed.slice(0, 27)}...` : trimmed;
}

function normalizeSearchPathToken(token: string): string | null {
  const trimmed = token.trim();
  if (!trimmed) {
    return null;
  }
  return compactPath(trimmed);
}

function looksLikeSearchPath(token: string): boolean {
  return token.includes("/") || token.startsWith(".") || token.includes("\\");
}

function tokenizeCommandArgs(args: string): string[] {
  const tokens: string[] = [];
  let index = 0;

  while (index < args.length) {
    while (args[index] === " ") {
      index += 1;
    }
    if (index >= args.length) {
      break;
    }

    const quote = args[index];
    if (quote === '"' || quote === "'") {
      index += 1;
      let token = "";
      while (index < args.length && args[index] !== quote) {
        if (args[index] === "\\" && index + 1 < args.length) {
          token += args[index + 1];
          index += 2;
          continue;
        }
        token += args[index];
        index += 1;
      }
      if (args[index] === quote) {
        index += 1;
      }
      tokens.push(token);
      continue;
    }

    let token = "";
    while (index < args.length && args[index] !== " ") {
      token += args[index];
      index += 1;
    }
    if (token) {
      tokens.push(token);
    }
  }

  return tokens;
}

function splitToolAndArgs(command: string): [tool: string, args: string] {
  const normalized = command.trim().replace(/\s+/g, " ");
  if (!normalized) {
    return ["", ""];
  }
  const separator = normalized.indexOf(" ");
  if (separator === -1) {
    return [basenameOfPath(normalized).toLowerCase(), ""];
  }
  const tool = basenameOfPath(normalized.slice(0, separator)).toLowerCase();
  const args = normalized.slice(separator + 1).trim();
  return [tool, args];
}

function unwrapShellCommandIfPresent(rawCommand: string): string {
  let value = rawCommand.trim();
  if (!value) {
    return value;
  }

  const lowered = value.toLowerCase();
  for (const prefix of SHELL_WRAPPER_PREFIXES) {
    if (!lowered.startsWith(prefix)) {
      continue;
    }
    value = value.slice(prefix.length).trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1).trim();
    }
    value = stripLeadingShellPreambles(value);
    break;
  }

  const pipeIndex = value.indexOf("|");
  if (pipeIndex > 0) {
    value = value.slice(0, pipeIndex).trim();
  }

  return value;
}

function stripLeadingShellPreambles(value: string): string {
  let current = value.trim();
  for (let attempts = 0; attempts < 4; attempts += 1) {
    const chain = findShellChain(current);
    if (!chain) {
      return current;
    }
    const head = current.slice(0, chain.operatorStart).trim();
    if (!isShellSetupPreamble(head)) {
      return current;
    }
    current = current.slice(chain.commandStart).trim();
  }
  return current;
}

function isShellSetupPreamble(value: string): boolean {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return false;
  }
  if (/^(?:builtin\s+)?cd\s+/.test(normalized)) {
    return true;
  }
  if (/^(?:source|\.)\s+/.test(normalized)) {
    return true;
  }
  if (/^set\s+[-+][A-Za-z]/.test(normalized)) {
    return true;
  }
  if (
    /^(?:export\s+)?[A-Za-z_][A-Za-z0-9_]*=[^\s]+(?:\s+[A-Za-z_][A-Za-z0-9_]*=[^\s]+)*$/.test(
      normalized,
    )
  ) {
    return true;
  }
  return false;
}

function findShellChain(value: string): { operatorStart: number; commandStart: number } | null {
  let quote: '"' | "'" | null = null;

  for (let index = 0; index < value.length - 1; index += 1) {
    const char = value[index];
    if (char === "\\" && index + 1 < value.length) {
      index += 1;
      continue;
    }
    if (quote) {
      if (char === quote) {
        quote = null;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    const next = value[index + 1];
    if (char === "&" && next === "&") {
      return { operatorStart: index, commandStart: index + 2 };
    }
    if (char === ";") {
      return { operatorStart: index, commandStart: index + 1 };
    }
  }

  return null;
}

function stripCommandDisplayWrappers(command: string): string {
  let current = command.replace(/\s+/g, " ").trim();
  for (let attempts = 0; attempts < 4; attempts += 1) {
    const [tool, args] = splitToolAndArgs(current);
    const next =
      tool === "env"
        ? stripEnvCommand(args)
        : tool === "timeout" || tool === "gtimeout"
          ? stripTimeoutCommand(args)
          : tool === "nice"
            ? stripNiceCommand(args)
            : tool === "arch"
              ? stripArchCommand(args)
              : tool === "command"
                ? args
                : null;
    if (!next || next === current) {
      return current;
    }
    current = next.trim();
  }
  return current;
}

function stripEnvCommand(args: string): string | null {
  const tokens = tokenizeCommandArgs(args);
  let index = 0;
  while (index < tokens.length) {
    const token = tokens[index]!;
    if (token === "--") {
      index += 1;
      break;
    }
    if (token === "-u" || token === "--unset" || token === "-C" || token === "--chdir") {
      index += 2;
      continue;
    }
    if (token.startsWith("--unset=") || token.startsWith("--chdir=")) {
      index += 1;
      continue;
    }
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) {
      index += 1;
      continue;
    }
    if (token.startsWith("-")) {
      index += 1;
      continue;
    }
    break;
  }
  return index < tokens.length ? tokens.slice(index).join(" ") : null;
}

function stripTimeoutCommand(args: string): string | null {
  const tokens = tokenizeCommandArgs(args);
  let index = 0;
  while (index < tokens.length && tokens[index]?.startsWith("-")) {
    index += tokens[index] === "-s" || tokens[index] === "-k" ? 2 : 1;
  }
  if (index < tokens.length && /^\d+(?:\.\d+)?[smhd]?$/.test(tokens[index]!)) {
    index += 1;
  }
  return index < tokens.length ? tokens.slice(index).join(" ") : null;
}

function stripNiceCommand(args: string): string | null {
  const tokens = tokenizeCommandArgs(args);
  let index = 0;
  if (tokens[index] === "-n") {
    index += 2;
  } else {
    while (tokens[index]?.startsWith("-")) {
      index += 1;
    }
  }
  return index < tokens.length ? tokens.slice(index).join(" ") : null;
}

function stripArchCommand(args: string): string | null {
  const tokens = tokenizeCommandArgs(args);
  let index = 0;
  while (tokens[index]?.startsWith("-")) {
    index += 1;
  }
  return index < tokens.length ? tokens.slice(index).join(" ") : null;
}
