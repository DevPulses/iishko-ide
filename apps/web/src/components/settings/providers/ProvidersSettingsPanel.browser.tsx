import "../../../index.css";

import { type ServerProviderStatus } from "@iishko/contracts";
import { PROVIDER_DESCRIPTORS } from "@iishko/shared/providerMetadata";
import { page } from "vitest/browser";
import { beforeEach, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { useState } from "react";

const harness = vi.hoisted(() => ({
  statuses: [] as ServerProviderStatus[],
  reconciled: true,
  refresh: vi.fn(),
  invalidate: vi.fn(async () => {}),
}));

vi.mock("@tanstack/react-query", async (importOriginal) => {
  const queryClient = { invalidateQueries: harness.invalidate };
  return {
    ...(await importOriginal<typeof import("@tanstack/react-query")>()),
    useQueryClient: () => queryClient,
    useQuery: () => ({ data: { providers: harness.statuses, cwd: "/tmp" }, isPending: false }),
  };
});
vi.mock("~/lib/serverReactQuery", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/lib/serverReactQuery")>()),
  serverConfigQueryOptions: () => ({}),
  serverSettingsQueryOptions: () => ({}),
  hasReconciledServerProviderStatuses: () => harness.reconciled,
  serverQueryKeys: { config: () => ["config"], settings: () => ["settings"] },
}));
vi.mock("~/hooks/useProviderStatusesForLocalConfig", () => ({
  useProviderStatusesForLocalConfig: () => harness.statuses,
}));
vi.mock("~/hooks/useProviderStatusRefresh", () => ({
  useRefreshProviderStatusesNow: () => harness.refresh,
}));

const nativeHarness = vi.hoisted(() => ({
  listEndpointModels: vi.fn(async () => ({ models: [] as Array<Record<string, unknown>> })),
}));
vi.mock("~/nativeApi", async (importOriginal) => {
  const original = await importOriginal<typeof import("~/nativeApi")>();
  return {
    ...original,
    ensureNativeApi: () =>
      ({
        provider: { listEndpointModels: nativeHarness.listEndpointModels },
        server: { updateProvider: vi.fn(async () => {}) },
      }) as unknown as ReturnType<typeof original.ensureNativeApi>,
  };
});

import { AppSettingsSchema, type AppSettings } from "~/appSettings";
import { ProvidersSettingsPanel } from "./ProvidersSettingsPanel";

const defaults = AppSettingsSchema.makeUnsafe({});
const props = {
  defaults,
  settings: { ...defaults, disabledProviders: ["grok" as const] },
  updateSettings: vi.fn(),
  updateSettingsAndWait: vi.fn(async () => {}),
  active: true,
  resetEpoch: 0,
  onManageAccounts: vi.fn(),
};

beforeEach(() => {
  harness.reconciled = true;
  harness.refresh.mockReset();
  nativeHarness.listEndpointModels.mockReset();
  nativeHarness.listEndpointModels.mockResolvedValue({ models: [] });
  harness.statuses = PROVIDER_DESCRIPTORS.map(({ kind }) => ({
    provider: kind,
    instanceId: kind,
    driver: kind,
    status: kind === "opencode" ? "error" : "ready",
    available: kind !== "opencode",
    authStatus: kind === "claudeAgent" ? "unauthenticated" : "authenticated",
    checkedAt: "2026-09-16T21:46:18.000Z",
    ...(kind === "opencode"
      ? { message: "OpenCode CLI (`opencode`) is not installed or not on PATH." }
      : {}),
  }));
});

function activityRow(provider: string) {
  return page
    .getByRole("switch", { name: `Disable ${provider}`, exact: true })
    .element()
    .closest('[data-slot="settings-row"]')!;
}

function agentOptions(provider: string) {
  return page.getByRole("button", { name: `${provider} options`, exact: true });
}

it.each([
  { name: "default", confirm: true, expanded: "false" },
  { name: "opt-out", confirm: false, expanded: "true" },
])(
  "uses the $name cold-cache preference for initial Claude disclosure",
  async ({ confirm, expanded }) => {
    await render(
      <ProvidersSettingsPanel
        {...props}
        settings={{ ...props.settings, claudeConfirmColdCacheResume: confirm }}
      />,
    );

    await expect.element(agentOptions("Claude")).toHaveAttribute("aria-expanded", expanded);
  },
);

it("saves provider CPU priority opt-out and exposes reset to the default", async () => {
  const updateSettings = vi.fn();
  const result = await render(
    <ProvidersSettingsPanel {...props} updateSettings={updateSettings} />,
  );
  const control = page.getByRole("switch", { name: "Keep IISHKO responsive" });
  await expect.element(control).toBeChecked();
  await control.click();
  expect(updateSettings).toHaveBeenCalledWith({ lowerProviderProcessPriority: false });
  await result.rerender(
    <ProvidersSettingsPanel
      {...props}
      settings={{ ...props.settings, lowerProviderProcessPriority: false }}
      updateSettings={updateSettings}
    />,
  );
  await page.getByRole("button", { name: "Reset Keep IISHKO responsive to default" }).click();
  expect(updateSettings).toHaveBeenLastCalledWith({ lowerProviderProcessPriority: true });
  expect(control.element().closest('[data-slot="settings-row"]')?.textContent).toContain(
    "Restart existing sessions",
  );
});

it("shows installation and auth beside activity switches with visible setup guides", async () => {
  await render(<ProvidersSettingsPanel {...props} />);
  expect(activityRow("OpenCode").textContent).toContain("Unavailable");
  expect(activityRow("Claude").textContent).toContain("Needs sign-in");
  expect(activityRow("Codex").textContent).toContain("Connected");
  // The server's diagnosis and the setup guide live in each agent's expanded row.
  for (const descriptor of PROVIDER_DESCRIPTORS) {
    // Grok is disabled in these props and lives in the recovery list instead.
    if (descriptor.kind === "grok") continue;
    await agentOptions(descriptor.displayName).click();
  }
  expect(activityRow("OpenCode").textContent).toContain("not installed or not on PATH");
  await page.getByRole("button", { name: /Disabled providers/u }).click();
  expect(
    page
      .getByRole("switch", { name: "Enable Grok", exact: true })
      .element()
      .closest('[data-slot="settings-row"]')?.textContent,
  ).toContain("Disabled · enable to check setup");
  // Permission to run remains enabled even if the CLI is missing.
  await expect
    .element(page.getByRole("switch", { name: "Disable OpenCode", exact: true }))
    .toBeChecked();
  for (const descriptor of PROVIDER_DESCRIPTORS) {
    const guide = page.getByRole("link", {
      name: `${descriptor.displayName} setup guide`,
      exact: true,
    });
    await expect.element(guide).toBeVisible();
    expect(guide.element().getAttribute("href")).toBe(descriptor.setupDocsHref);
  }
});

it("reports Claude as connected and visible when only a secondary account is ready", async () => {
  harness.statuses = [
    ...harness.statuses.filter((status) => status.provider !== "claudeAgent"),
    {
      provider: "claudeAgent",
      driver: "claudeAgent",
      instanceId: "claudeAgent",
      enabled: false,
      available: false,
      authStatus: "unknown",
      status: "warning",
      checkedAt: "2026-09-16T21:46:18.000Z",
    },
    {
      provider: "claudeAgent",
      driver: "claudeAgent",
      instanceId: "work_claude",
      enabled: true,
      available: true,
      authStatus: "authenticated",
      status: "ready",
      checkedAt: "2026-09-16T21:46:18.000Z",
    },
  ];
  await render(
    <ProvidersSettingsPanel
      {...props}
      providerTarget="claudeAgent"
      settings={{
        ...props.settings,
        providerInstances: {
          claudeAgent: { driver: "claudeAgent", displayName: "Privat", enabled: false },
          work_claude: { driver: "claudeAgent", displayName: "Work", enabled: true },
        },
      }}
    />,
  );

  expect(activityRow("Claude").textContent).toContain("Connected");
  await expect
    .element(page.getByRole("switch", { name: "Show Claude in the provider picker" }))
    .toBeChecked();
  // Provider instances are managed in the instances section below; the
  // per-agent rows still link to the Accounts page for sign-in.
  await expect
    .element(page.getByRole("switch", { name: "Enable Privat", exact: true }))
    .toBeVisible();
  await page.getByRole("button", { name: "Manage accounts" }).first().click();
  expect(props.onManageAccounts).toHaveBeenCalledWith("claudeAgent");
});

it("keeps disabled providers only in a collapsed recovery list", async () => {
  await render(<ProvidersSettingsPanel {...props} />);
  expect(page.getByRole("switch", { name: "Enable Grok", exact: true }).elements()).toHaveLength(0);
  expect(page.getByRole("button", { name: "Reorder Grok", exact: true }).elements()).toHaveLength(
    0,
  );
  expect(page.getByRole("button", { name: "Grok", exact: true }).elements()).toHaveLength(0);
  const recovery = page.getByRole("button", { name: /Disabled providers/u });
  await expect.element(recovery).toHaveAttribute("aria-expanded", "false");
  await recovery.click();
  await expect
    .element(page.getByRole("switch", { name: "Enable Grok", exact: true }))
    .toBeVisible();
  expect(page.getByRole("button", { name: "Reorder Grok", exact: true }).elements()).toHaveLength(
    0,
  );
  expect(page.getByRole("button", { name: "Grok", exact: true }).elements()).toHaveLength(0);
});

it("restores provider options and saved configuration after re-enabling", async () => {
  function Harness() {
    const [settings, setSettings] = useState<AppSettings>({
      ...defaults,
      codexBinaryPath: "/custom/codex",
      hiddenProviders: ["codex"],
    });
    const updateSettings = (patch: Partial<AppSettings>) =>
      setSettings((current) => ({ ...current, ...patch }));
    return (
      <ProvidersSettingsPanel
        {...props}
        settings={settings}
        updateSettings={updateSettings}
        updateSettingsAndWait={async (patch) => updateSettings(patch)}
      />
    );
  }
  await render(<Harness />);
  await page.getByRole("switch", { name: "Disable Codex", exact: true }).click();
  expect(page.getByRole("button", { name: "Reorder Codex", exact: true }).elements()).toHaveLength(
    0,
  );
  expect(agentOptions("Codex").elements()).toHaveLength(0);
  await page.getByRole("button", { name: /Disabled providers/u }).click();
  await page.getByRole("switch", { name: "Enable Codex", exact: true }).click();
  await expect
    .element(page.getByRole("button", { name: "Reorder Codex", exact: true }))
    .toBeVisible();
  await expect
    .element(page.getByRole("switch", { name: "Show Codex in the provider picker", exact: true }))
    .not.toBeChecked();
  // Re-enabling keeps the row's disclosure as it was.
  await expect.element(agentOptions("Codex")).toHaveAttribute("aria-expanded", "true");
  // The binary path is a provider-wide CLI option, so it sits in the Codex row itself.
  const binaryPath = page.getByRole("textbox", { name: /^Codex binary path/u });
  await expect.element(binaryPath).toHaveValue("/custom/codex");
});

it("expands an agent row to its picker switch, provider-wide fields, and accounts link", async () => {
  const updateSettings = vi.fn();
  const onManageAccounts = vi.fn();
  await render(
    <ProvidersSettingsPanel
      {...props}
      updateSettings={updateSettings}
      onManageAccounts={onManageAccounts}
    />,
  );
  const options = agentOptions("Codex");
  await expect.element(options).toHaveAttribute("aria-expanded", "false");
  expect(
    page.getByRole("switch", { name: "Show Codex in the provider picker" }).elements(),
  ).toHaveLength(0);
  await options.click();
  await expect.element(options).toHaveAttribute("aria-expanded", "true");
  const row = activityRow("Codex");
  const picker = page.getByRole("switch", { name: "Show Codex in the provider picker" });
  await expect.element(picker).toBeChecked();
  expect(row.contains(picker.element())).toBe(true);
  const binaryPath = page.getByRole("textbox", { name: /^Codex binary path/u });
  await expect.element(binaryPath).toBeVisible();
  expect(row.contains(binaryPath.element())).toBe(true);
  // The default account's sign-in folder stays on the Accounts page.
  expect(page.getByRole("textbox", { name: /CODEX_HOME/u }).elements()).toHaveLength(0);
  await picker.click();
  expect(updateSettings).toHaveBeenLastCalledWith({ hiddenProviders: ["codex"] });
  const manage = page.getByRole("button", { name: "Manage accounts", exact: true });
  expect(manage.elements()).toHaveLength(1);
  await manage.click();
  expect(onManageAccounts).toHaveBeenCalledWith("codex");
});

it("resets the whole agents list, including enablement, from one header action", async () => {
  const updateSettings = vi.fn();
  const updateSettingsAndWait = vi.fn(async () => {});
  await render(
    <ProvidersSettingsPanel
      {...props}
      settings={{
        ...props.settings,
        hiddenProviders: ["codex"],
        codexBinaryPath: "/custom/codex",
      }}
      updateSettings={updateSettings}
      updateSettingsAndWait={updateSettingsAndWait}
    />,
  );
  await page.getByRole("button", { name: "Reset agents to default", exact: true }).click();
  expect(updateSettings).toHaveBeenCalledWith(
    expect.objectContaining({
      hiddenProviders: defaults.hiddenProviders,
      providerOrder: defaults.providerOrder,
      codexBinaryPath: defaults.codexBinaryPath,
    }),
  );
  expect(updateSettingsAndWait).toHaveBeenCalledWith({
    disabledProviders: defaults.disabledProviders,
  });
});

it("allows recovering after every provider is disabled", async () => {
  await render(
    <ProvidersSettingsPanel
      {...props}
      settings={{ ...defaults, disabledProviders: [...defaults.providerOrder] }}
    />,
  );
  expect(page.getByRole("button", { name: /^Reorder /u }).elements()).toHaveLength(0);
  expect(page.getByRole("switch", { name: /^Disable /u }).elements()).toHaveLength(0);
  await page.getByRole("button", { name: /Disabled providers/u }).click();
  await expect
    .element(page.getByRole("switch", { name: "Enable Codex", exact: true }))
    .toBeVisible();
});

it("does not report cached provider health as connected before reconciliation", async () => {
  harness.reconciled = false;
  await render(<ProvidersSettingsPanel {...props} />);
  expect(activityRow("Codex").textContent).toContain("Checking setup");
  expect(activityRow("Codex").textContent).not.toContain("Connected");
});

it("allows rechecking setup after installing externally and blocks duplicate refreshes", async () => {
  let finish!: () => void;
  harness.refresh.mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  await render(<ProvidersSettingsPanel {...props} />);
  await page.getByRole("button", { name: "Refresh status", exact: true }).click();
  expect(harness.refresh).toHaveBeenCalledOnce();
  await expect
    .element(page.getByRole("button", { name: "Checking setup", exact: true }))
    .toBeDisabled();
  finish();
  await expect
    .element(page.getByRole("button", { name: "Refresh status", exact: true }))
    .toBeEnabled();
});

it("resets the agents list without touching accounts or the default account's sign-in folder", async () => {
  let latest!: AppSettings;
  function Harness() {
    const [settings, setSettings] = useState<AppSettings>({
      ...defaults,
      hiddenProviders: ["codex"],
      codexBinaryPath: "/custom/codex",
      codexHomePath: "~/.codex-personal",
      selectedCodexAccountId: "work",
      codexAccounts: [{ id: "work", label: "Work", homePath: "", shadowHomePath: "" }],
      providerInstances: {
        codex_team: { driver: "codex", displayName: "Team", enabled: true, config: {} },
      },
    });
    latest = settings;
    const updateSettings = (patch: Partial<AppSettings>) =>
      setSettings((current) => ({ ...current, ...patch }));
    return (
      <ProvidersSettingsPanel
        {...props}
        settings={settings}
        updateSettings={updateSettings}
        updateSettingsAndWait={async (patch) => updateSettings(patch)}
      />
    );
  }
  await render(<Harness />);
  await page.getByRole("button", { name: "Reset agents to default", exact: true }).click();

  await expect.poll(() => latest.hiddenProviders).toEqual(defaults.hiddenProviders);
  expect(latest.codexBinaryPath).toBe(defaults.codexBinaryPath);
  // Accounts belong to the Accounts page and survive the Agents reset.
  expect(latest.providerInstances).toEqual({
    codex_team: { driver: "codex", displayName: "Team", enabled: true, config: {} },
  });
  expect(latest.codexAccounts).toEqual([
    { id: "work", label: "Work", homePath: "", shadowHomePath: "" },
  ]);
  expect(latest.selectedCodexAccountId).toBe("work");
  expect(latest.codexHomePath).toBe("~/.codex-personal");
  // Nothing the Agents list resets is left, so its reset goes away.
  await expect
    .element(page.getByRole("button", { name: "Reset agents to default", exact: true }))
    .not.toBeInTheDocument();
});

it("offers no agents reset for account-only changes", async () => {
  await render(
    <ProvidersSettingsPanel
      {...props}
      settings={{
        ...props.settings,
        disabledProviders: defaults.disabledProviders,
        codexHomePath: "~/.codex-personal",
        providerInstances: {
          codex_team: { driver: "codex", displayName: "Team", enabled: true, config: {} },
        },
      }}
    />,
  );
  await expect.element(page.getByRole("button", { name: "Refresh status" })).toBeVisible();
  expect(
    page.getByRole("button", { name: "Reset agents to default", exact: true }).elements(),
  ).toHaveLength(0);
});

it("adds a CLI provider instance through the provider dialog", async () => {
  const updateSettingsAndWait = vi.fn(async (_patch: Partial<AppSettings>) => {});
  await render(<ProvidersSettingsPanel {...props} updateSettingsAndWait={updateSettingsAndWait} />);
  await page.getByRole("button", { name: "Add provider", exact: true }).click();
  await page.getByRole("textbox", { name: "Label", exact: true }).fill("Team agent");
  await page.getByRole("textbox", { name: /Account ID/u }).fill("pi_team");
  await page.getByRole("textbox", { name: "Binary path", exact: true }).fill("/opt/team-agent");
  await page.getByRole("button", { name: "Add provider", exact: true }).last().click();

  await expect.poll(() => updateSettingsAndWait).toHaveBeenCalled();
  const patch = updateSettingsAndWait.mock.calls.at(-1)?.[0] as unknown as {
    providerInstances?: Record<string, Record<string, unknown>>;
  };
  expect(patch.providerInstances?.pi_team).toMatchObject({
    driver: "pi",
    displayName: "Team agent",
    enabled: true,
  });
  expect(patch.providerInstances?.pi_team?.config).toMatchObject({
    binaryPath: "/opt/team-agent",
  });
});

it("adds an OpenAI-compatible endpoint, loads models once, and stores the key as a secret env var", async () => {
  nativeHarness.listEndpointModels.mockResolvedValue({
    models: [{ id: "model-a", name: "Model A", contextWindow: 64000 }, { id: "model-b" }],
  });
  const updateSettingsAndWait = vi.fn(async (_patch: Partial<AppSettings>) => {});
  await render(<ProvidersSettingsPanel {...props} updateSettingsAndWait={updateSettingsAndWait} />);
  await page.getByRole("button", { name: "Add provider", exact: true }).click();
  await page.getByRole("button", { name: "OpenAI-compatible API", exact: true }).click();
  await page.getByRole("textbox", { name: "Label", exact: true }).fill("Local API");
  await page.getByRole("textbox", { name: /Account ID/u }).fill("pi_localapi");
  await page
    .getByRole("textbox", { name: "Base URL", exact: true })
    .fill("https://api.example.com/v1");
  await page.getByRole("textbox", { name: /API key Stored/u }).fill("sk-test-key");
  await page.getByRole("button", { name: "Load models", exact: true }).click();

  await expect
    .poll(() => nativeHarness.listEndpointModels)
    .toHaveBeenCalledWith({ baseUrl: "https://api.example.com/v1", apiKey: "sk-test-key" });
  await expect.element(page.getByPlaceholder("Model ID").first()).toHaveValue("model-a");

  await page.getByRole("button", { name: "Add provider", exact: true }).last().click();
  await expect.poll(() => updateSettingsAndWait).toHaveBeenCalled();
  const patch = updateSettingsAndWait.mock.calls.at(-1)?.[0] as unknown as {
    providerInstances?: Record<string, Record<string, unknown>>;
  };
  expect(patch.providerInstances?.pi_localapi).toMatchObject({
    driver: "pi",
    displayName: "Local API",
    enabled: true,
    config: {
      kind: "openai-compatible",
      baseUrl: "https://api.example.com/v1",
      apiKeyEnv: "IISHKO_CUSTOM_API_KEY",
      models: [{ id: "model-a", name: "Model A", contextWindow: 64000 }, { id: "model-b" }],
    },
    environment: [{ name: "IISHKO_CUSTOM_API_KEY", value: "sk-test-key", sensitive: true }],
  });
});

it("edits, toggles, and deletes a custom provider instance but never the built-in", async () => {
  const updateSettings = vi.fn();
  const updateSettingsAndWait = vi.fn(async (_patch: Partial<AppSettings>) => {});
  const settings: AppSettings = {
    ...props.settings,
    providerInstances: {
      pi_team: {
        driver: "pi",
        displayName: "Team",
        enabled: true,
        config: { binaryPath: "/old/pi" },
      },
    },
  };
  await render(
    <ProvidersSettingsPanel
      {...props}
      settings={settings}
      updateSettings={updateSettings}
      updateSettingsAndWait={updateSettingsAndWait}
    />,
  );

  // Built-in instances get no delete button; the custom one does.
  expect(page.getByRole("button", { name: "Remove Pi", exact: true }).elements()).toHaveLength(0);

  await page.getByRole("switch", { name: "Enable Team", exact: true }).click();
  const togglePatch = updateSettings.mock.calls.at(-1)?.[0] as unknown as {
    providerInstances?: Record<string, { enabled?: boolean }>;
  };
  expect(togglePatch.providerInstances?.pi_team?.enabled).toBe(false);

  await page.getByRole("button", { name: "Edit Team", exact: true }).click();
  await expect
    .element(page.getByRole("textbox", { name: "Label", exact: true }))
    .toHaveValue("Team");
  await page.getByRole("textbox", { name: "Label", exact: true }).fill("Team Two");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect.poll(() => updateSettingsAndWait).toHaveBeenCalled();
  const editPatch = updateSettingsAndWait.mock.calls.at(-1)?.[0] as unknown as {
    providerInstances?: Record<string, Record<string, unknown>>;
  };
  expect(editPatch.providerInstances?.pi_team).toMatchObject({
    displayName: "Team Two",
    config: { binaryPath: "/old/pi" },
  });

  updateSettingsAndWait.mockClear();
  await page.getByRole("button", { name: "Remove Team", exact: true }).click();
  await page.getByRole("button", { name: "Delete", exact: true }).click();
  await expect.poll(() => updateSettingsAndWait).toHaveBeenCalled();
  const deletePatch = updateSettingsAndWait.mock.calls.at(-1)?.[0] as unknown as {
    providerInstances?: Record<string, unknown>;
  };
  expect(deletePatch.providerInstances?.pi_team).toBeUndefined();
});
