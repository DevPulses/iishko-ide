// FILE: ProviderInstanceDialog.tsx
// Purpose: Add or edit a provider instance from Settings → Providers. Two
//   kinds: a CLI agent account (driver, binary path, environment) and an
//   OpenAI-compatible endpoint whose models Pi registers as a custom provider.
// Layer: Settings UI components
// Exports: ProviderInstanceDialog, ProviderInstanceFormValues, ProviderInstanceKind

import {
  PROVIDER_DISPLAY_NAMES,
  type ProviderCustomModelSpec,
  type ProviderInstanceEnvironment,
  type ProviderInstanceId,
  type ProviderKind,
} from "@iishko/contracts";
import { type FormEvent, useId, useState } from "react";

import {
  deriveProviderAccountId,
  validateProviderAccountId,
} from "~/lib/providerInstancePresentation";
import { useTranslation } from "~/i18n";
import { Loader2Icon, PlusIcon, XIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";
import { ensureNativeApi } from "~/nativeApi";
import type { AppSettings, ProviderInstanceOption } from "~/appSettings";

import { ProviderIcon } from "../../ProviderIcon";
import { Button } from "../../ui/button";
import {
  Dialog,
  DialogDescription,
  dialogFieldLabelClassName,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../../ui/dialog";
import { Input } from "../../ui/input";
import { SelectItem } from "../../ui/select";
import { toastManager } from "../../ui/toast";
import { ProviderAccentColorControl } from "../accounts/ProviderAccentColorControl";
import { ProviderInstanceEnvironmentEditor } from "../accounts/ProviderInstanceEnvironmentEditor";
import { SettingsSelectControl } from "../SettingControls";
import {
  PROVIDER_VISIBILITY_OPTIONS,
  providerInstanceLaunchConfigFor,
} from "./providerInstallSettings";

export type ProviderInstanceKind = "cli" | "openai";

export interface ProviderInstanceFormValues {
  readonly instanceId: string;
  readonly driver: ProviderKind;
  readonly displayName: string;
  readonly accentColor: string | undefined;
  readonly config: Record<string, unknown>;
  readonly environment: ProviderInstanceEnvironment;
}

export interface ProviderInstanceDialogTarget {
  readonly instanceId: string;
  readonly option: ProviderInstanceOption;
  /** Explicit stored config; empty object for a derived (built-in) instance. */
  readonly config: Record<string, unknown>;
  readonly environment: ProviderInstanceEnvironment | undefined;
}

const CUSTOM_PROVIDER_KIND = "openai-compatible";
const CUSTOM_PROVIDER_DEFAULT_API_KEY_ENV = "IISHKO_CUSTOM_API_KEY";

function isRecordValue(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readConfigString(config: Record<string, unknown>, key: string): string {
  const value = config[key];
  return typeof value === "string" ? value : "";
}

function readConfigModels(
  config: Record<string, unknown>,
): Array<{ id: string; name: string; contextWindow: string }> {
  const raw = config.models;
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry) => {
    if (!isRecordValue(entry)) return [];
    const id = typeof entry.id === "string" ? entry.id : "";
    if (!id.trim()) return [];
    const name = typeof entry.name === "string" ? entry.name : "";
    const contextWindow =
      typeof entry.contextWindow === "number" && Number.isFinite(entry.contextWindow)
        ? String(entry.contextWindow)
        : "";
    return [{ id, name, contextWindow }];
  });
}

interface ModelDraft {
  id: string;
  name: string;
  contextWindow: string;
}

export function ProviderInstanceDialog(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  settings: AppSettings;
  existingIds: ReadonlySet<string>;
  /** Set in edit mode; undefined means "add". */
  target?: ProviderInstanceDialogTarget | undefined;
  initialKind?: ProviderInstanceKind | undefined;
  onSave: (values: ProviderInstanceFormValues) => void;
}) {
  const { t } = useTranslation();
  const formId = useId();
  const editing = props.target !== undefined;

  const [kind, setKind] = useState<ProviderInstanceKind>("cli");
  const [driver, setDriver] = useState<ProviderKind>("pi");
  const [label, setLabel] = useState("");
  const [idOverride, setIdOverride] = useState<string | null>(null);
  const [accentColor, setAccentColor] = useState<string | undefined>(undefined);
  const [binaryPath, setBinaryPath] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [apiKeyEnv, setApiKeyEnv] = useState(CUSTOM_PROVIDER_DEFAULT_API_KEY_ENV);
  const [models, setModels] = useState<ModelDraft[]>([]);
  const [environment, setEnvironment] = useState<ProviderInstanceEnvironment>([]);
  const [submitAttempted, setSubmitAttempted] = useState(false);
  const [loadingModels, setLoadingModels] = useState(false);

  const apiKeyEnvName = apiKeyEnv.trim() || CUSTOM_PROVIDER_DEFAULT_API_KEY_ENV;
  // The endpoint key is edited through its dedicated field, never as a generic
  // env row, so the two cannot drift apart. CLI instances keep every variable.
  const editorEnvironment =
    kind === "openai" ? environment.filter((entry) => entry.name !== apiKeyEnvName) : environment;

  // Start from a blank or prefilled form every time the dialog opens.
  const [wasOpen, setWasOpen] = useState(props.open);
  if (wasOpen !== props.open) {
    setWasOpen(props.open);
    if (props.open) {
      const target = props.target;
      const targetConfig = target?.config ?? {};
      const targetIsOpenAi = readConfigString(targetConfig, "kind") === CUSTOM_PROVIDER_KIND;
      setKind(target ? (targetIsOpenAi ? "openai" : "cli") : (props.initialKind ?? "cli"));
      setDriver(target?.option.provider ?? "pi");
      setLabel(target?.option.label ?? "");
      setIdOverride(null);
      setAccentColor(target?.option.accentColor);
      setBinaryPath(readConfigString(targetConfig, "binaryPath"));
      setBaseUrl(readConfigString(targetConfig, "baseUrl"));
      setApiKey("");
      setApiKeyEnv(
        readConfigString(targetConfig, "apiKeyEnv") || CUSTOM_PROVIDER_DEFAULT_API_KEY_ENV,
      );
      setModels(readConfigModels(targetConfig));
      const storedApiKeyEnv =
        readConfigString(targetConfig, "apiKeyEnv") || CUSTOM_PROVIDER_DEFAULT_API_KEY_ENV;
      setEnvironment((target?.environment ?? []).filter((entry) => entry.name !== storedApiKeyEnv));
      setSubmitAttempted(false);
      setLoadingModels(false);
    }
  }

  const effectiveDriver: ProviderKind = kind === "openai" ? "pi" : driver;
  const instanceId = editing
    ? (props.target?.instanceId ?? "")
    : (idOverride ?? deriveProviderAccountId(effectiveDriver, label));
  const idError = editing ? null : validateProviderAccountId(instanceId, props.existingIds);
  const baseUrlInvalid =
    kind === "openai" && submitAttempted && !/^https?:\/\/\S+$/iu.test(baseUrl.trim());
  const modelsInvalid =
    kind === "openai" && submitAttempted && !models.some((model) => model.id.trim().length > 0);

  const loadModels = async () => {
    const trimmedBaseUrl = baseUrl.trim();
    if (!trimmedBaseUrl) return;
    setLoadingModels(true);
    try {
      const result = await ensureNativeApi().provider.listEndpointModels({
        baseUrl: trimmedBaseUrl,
        ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
        ...(editing && props.target
          ? { instanceId: props.target.instanceId as ProviderInstanceId }
          : {}),
      });
      setModels(
        result.models.map((model: ProviderCustomModelSpec) => ({
          id: model.id,
          name: model.name ?? "",
          contextWindow: typeof model.contextWindow === "number" ? String(model.contextWindow) : "",
        })),
      );
    } catch (error) {
      toastManager.add({
        type: "error",
        title: t("settings:customProviders_loadModelsFailed"),
        description: error instanceof Error ? error.message : undefined,
      });
    } finally {
      setLoadingModels(false);
    }
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setSubmitAttempted(true);
    if (idError !== null || baseUrlInvalid || modelsInvalid) return;

    const trimmedApiKeyEnv = apiKeyEnv.trim() || CUSTOM_PROVIDER_DEFAULT_API_KEY_ENV;
    let nextEnvironment =
      kind === "openai"
        ? environment.filter((entry) => entry.name !== trimmedApiKeyEnv)
        : environment;
    let nextConfig: Record<string, unknown>;
    if (kind === "openai") {
      const key = apiKey.trim();
      if (key) {
        nextEnvironment = [
          ...nextEnvironment,
          { name: trimmedApiKeyEnv, value: key, sensitive: true },
        ];
      } else if (editing) {
        // Keep the stored (possibly redacted) key entry untouched.
        const stored = props.target?.environment?.find((entry) => entry.name === trimmedApiKeyEnv);
        if (stored) nextEnvironment = [...nextEnvironment, stored];
      }
      nextConfig = {
        kind: CUSTOM_PROVIDER_KIND,
        baseUrl: baseUrl.trim(),
        models: models
          .filter((model) => model.id.trim().length > 0)
          .map((model) => {
            const contextWindow = Number.parseInt(model.contextWindow, 10);
            return {
              id: model.id.trim(),
              ...(model.name.trim() ? { name: model.name.trim() } : {}),
              ...(Number.isFinite(contextWindow) && contextWindow > 0 ? { contextWindow } : {}),
            };
          }),
        apiKeyEnv: trimmedApiKeyEnv,
      };
    } else {
      nextConfig = editing
        ? { binaryPath: binaryPath.trim() }
        : {
            ...providerInstanceLaunchConfigFor(driver, props.settings),
            ...(binaryPath.trim() ? { binaryPath: binaryPath.trim() } : {}),
          };
    }

    props.onSave({
      instanceId: instanceId.trim(),
      driver: effectiveDriver,
      displayName: label.trim(),
      accentColor,
      config: nextConfig,
      environment: nextEnvironment,
    });
    props.onOpenChange(false);
  };

  const driverOptions = PROVIDER_VISIBILITY_OPTIONS.filter(
    (option) => !props.settings.disabledProviders.includes(option.provider),
  );
  const driverLabel =
    driverOptions.find((option) => option.provider === driver)?.title ??
    PROVIDER_DISPLAY_NAMES[driver];

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogPopup className="max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {editing
              ? t("settings:customProviders_editInstance")
              : t("settings:customProviders_addProvider")}
          </DialogTitle>
          <DialogDescription>
            {editing
              ? t("settings:customProviders_editDescription")
              : t("settings:customProviders_addDescription")}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <form id={formId} className="space-y-3" onSubmit={submit} noValidate>
            {!editing ? (
              <div className="space-y-1">
                <span className={dialogFieldLabelClassName}>
                  {t("settings:customProviders_type")}
                </span>
                <div className="grid grid-cols-2 gap-2">
                  {(
                    [
                      ["cli", t("settings:customProviders_typeCli")],
                      ["openai", t("settings:customProviders_typeOpenAi")],
                    ] as const
                  ).map(([value, title]) => (
                    <button
                      key={value}
                      type="button"
                      onClick={() => setKind(value)}
                      className={cn(
                        "rounded-md border px-3 py-2 text-left text-ui-sm transition-colors",
                        kind === value
                          ? "border-foreground/40 bg-accent text-foreground"
                          : "border-border/70 text-muted-foreground hover:bg-accent/50",
                      )}
                    >
                      {title}
                    </button>
                  ))}
                </div>
              </div>
            ) : null}

            {kind === "cli" ? (
              <div className="space-y-1">
                <span className={dialogFieldLabelClassName}>
                  {t("workspace:models_customModelProvider")}
                </span>
                <SettingsSelectControl
                  value={driver}
                  onValueChange={(next) => {
                    setDriver(next as ProviderKind);
                    if (!editing && !idOverride) setIdOverride(null);
                  }}
                  ariaLabel={t("workspace:models_customModelProvider")}
                  triggerClassName="w-full"
                  valueContent={
                    <span className="flex items-center gap-2">
                      <ProviderIcon provider={driver} className="size-4 shrink-0" />
                      <span className="truncate">{driverLabel}</span>
                    </span>
                  }
                >
                  {driverOptions.map((option) => (
                    <SelectItem hideIndicator key={option.provider} value={option.provider}>
                      <span className="flex items-center gap-2">
                        <ProviderIcon provider={option.provider} className="size-4 shrink-0" />
                        <span className="truncate">{option.title}</span>
                      </span>
                    </SelectItem>
                  ))}
                </SettingsSelectControl>
              </div>
            ) : null}

            <label className="block space-y-1">
              <span className={dialogFieldLabelClassName}>
                {t("chat:pinned_renamePlaceholder")}
              </span>
              <Input
                size="sm"
                value={label}
                onChange={(event) => setLabel(event.target.value)}
                placeholder={t("settings:eGWork")}
                spellCheck={false}
                autoFocus={!editing}
              />
            </label>
            {!editing ? (
              <label className="block space-y-1">
                <span className={dialogFieldLabelClassName}>{t("settings:accountID")}</span>
                <Input
                  size="sm"
                  className="font-mono"
                  value={instanceId}
                  onChange={(event) => setIdOverride(event.target.value)}
                  placeholder={deriveProviderAccountId(effectiveDriver, "work")}
                  spellCheck={false}
                  aria-invalid={submitAttempted && idError !== null}
                />
                <span
                  className={
                    submitAttempted && idError !== null
                      ? "block text-ui-sm text-destructive"
                      : "block text-ui-sm text-muted-foreground"
                  }
                >
                  {submitAttempted && idError !== null
                    ? idError
                    : t("settings:routingKeyUsedByThreadsAndSessionsLettersDigits")}
                </span>
              </label>
            ) : null}
            <div className="space-y-1">
              <span className={dialogFieldLabelClassName}>{t("settings:accentColor")}</span>
              <ProviderAccentColorControl
                value={accentColor}
                onChange={setAccentColor}
                accountLabel={label.trim() || "the provider"}
              />
            </div>

            {kind === "cli" ? (
              <label className="block space-y-1">
                <span className={dialogFieldLabelClassName}>
                  {t("settings:customProviders_binaryPath")}
                </span>
                <Input
                  size="sm"
                  className="font-mono"
                  value={binaryPath}
                  onChange={(event) => setBinaryPath(event.target.value)}
                  placeholder={t("settings:customProviders_binaryPathPlaceholder")}
                  spellCheck={false}
                />
              </label>
            ) : (
              <>
                <label className="block space-y-1">
                  <span className={dialogFieldLabelClassName}>
                    {t("settings:customProviders_baseUrl")}
                  </span>
                  <Input
                    size="sm"
                    className="font-mono"
                    value={baseUrl}
                    onChange={(event) => setBaseUrl(event.target.value)}
                    placeholder="https://api.example.com/v1"
                    spellCheck={false}
                    aria-invalid={baseUrlInvalid}
                  />
                  {baseUrlInvalid ? (
                    <span className="block text-ui-sm text-destructive">
                      {t("settings:customProviders_baseUrlInvalid")}
                    </span>
                  ) : null}
                </label>
                <label className="block space-y-1">
                  <span className={dialogFieldLabelClassName}>
                    {t("settings:customProviders_apiKey")}
                  </span>
                  <Input
                    size="sm"
                    type="password"
                    value={apiKey}
                    onChange={(event) => setApiKey(event.target.value)}
                    placeholder={
                      editing
                        ? t("settings:customProviders_apiKeySaved")
                        : t("settings:customProviders_apiKeyOptional")
                    }
                    spellCheck={false}
                    autoComplete="off"
                  />
                  <span className="block text-ui-sm text-muted-foreground">
                    {t("settings:customProviders_apiKeyHint")}
                  </span>
                </label>
                <div className="space-y-2">
                  <div className="flex items-center justify-between gap-2">
                    <span className={dialogFieldLabelClassName}>
                      {t("settings:customProviders_models")}
                    </span>
                    <Button
                      type="button"
                      size="xs"
                      variant="outline"
                      disabled={loadingModels || baseUrl.trim().length === 0}
                      onClick={() => void loadModels()}
                    >
                      {loadingModels ? <Loader2Icon className="size-3.5 animate-spin" /> : null}
                      {t("settings:customProviders_loadModels")}
                    </Button>
                  </div>
                  {modelsInvalid ? (
                    <span className="block text-ui-sm text-destructive">
                      {t("settings:customProviders_modelsRequired")}
                    </span>
                  ) : null}
                  {models.map((model, index) => (
                    <div key={index} className="flex items-center gap-2">
                      <Input
                        size="sm"
                        className="w-2/5 font-mono"
                        value={model.id}
                        onChange={(event) =>
                          setModels((current) =>
                            current.map((entry, entryIndex) =>
                              entryIndex === index ? { ...entry, id: event.target.value } : entry,
                            ),
                          )
                        }
                        placeholder={t("settings:customProviders_modelId")}
                        spellCheck={false}
                      />
                      <Input
                        size="sm"
                        className="flex-1"
                        value={model.name}
                        onChange={(event) =>
                          setModels((current) =>
                            current.map((entry, entryIndex) =>
                              entryIndex === index ? { ...entry, name: event.target.value } : entry,
                            ),
                          )
                        }
                        placeholder={t("settings:customProviders_modelName")}
                        spellCheck={false}
                      />
                      <Input
                        size="sm"
                        className="w-24"
                        inputMode="numeric"
                        value={model.contextWindow}
                        onChange={(event) =>
                          setModels((current) =>
                            current.map((entry, entryIndex) =>
                              entryIndex === index
                                ? { ...entry, contextWindow: event.target.value }
                                : entry,
                            ),
                          )
                        }
                        placeholder={t("settings:customProviders_contextWindow")}
                        spellCheck={false}
                      />
                      <Button
                        type="button"
                        size="xs"
                        variant="ghost"
                        onClick={() =>
                          setModels((current) =>
                            current.filter((_, entryIndex) => entryIndex !== index),
                          )
                        }
                        aria-label={t("workspace:remove", { value0: model.id || "model" })}
                      >
                        <XIcon className="size-3.5" />
                      </Button>
                    </div>
                  ))}
                  <Button
                    type="button"
                    size="xs"
                    variant="outline"
                    onClick={() =>
                      setModels((current) => [...current, { id: "", name: "", contextWindow: "" }])
                    }
                  >
                    <PlusIcon className="size-3.5" />
                    {t("settings:customProviders_addModel")}
                  </Button>
                </div>
                <label className="block space-y-1">
                  <span className={dialogFieldLabelClassName}>
                    {t("settings:customProviders_apiKeyEnv")}
                  </span>
                  <Input
                    size="sm"
                    className="font-mono"
                    value={apiKeyEnv}
                    onChange={(event) => setApiKeyEnv(event.target.value)}
                    placeholder={CUSTOM_PROVIDER_DEFAULT_API_KEY_ENV}
                    spellCheck={false}
                  />
                  <span className="block text-ui-sm text-muted-foreground">
                    {t("settings:customProviders_apiKeyEnvHint")}
                  </span>
                </label>
              </>
            )}

            <ProviderInstanceEnvironmentEditor
              instanceId={instanceId || "new"}
              environment={editorEnvironment}
              onChange={setEnvironment}
            />
          </form>
        </DialogPanel>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => props.onOpenChange(false)}>
            {t("common:form_cancel")}
          </Button>
          <Button type="submit" form={formId}>
            {editing ? t("computer:form_save") : t("settings:customProviders_addProvider")}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
