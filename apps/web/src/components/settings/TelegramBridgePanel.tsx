// FILE: TelegramBridgePanel.tsx
// Purpose: Settings page for driving the IDE from the user's own Telegram bot.
// Layer: Web settings feature
//
// The bot token is sent to the server once and never read back; only the bot name,
// the owner, the one-time bind code and the runtime state come back.

import { TELEGRAM_BRIDGE_ERROR_CODES, type TelegramBridgeStatus } from "@iishko/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Switch } from "~/components/ui/switch";
import { useTranslation } from "~/i18n";
import { openExternalLink } from "~/lib/linkChips";
import { ensureNativeApi } from "~/nativeApi";

const STATUS_KEY = ["telegramBridge", "status"] as const;

function errorCode(error: unknown): string | null {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { code: unknown }).code)
    : null;
}

function formatActivity(iso: string | null, locale: string): string | null {
  if (!iso) return null;
  return new Date(iso).toLocaleString(locale, { dateStyle: "short", timeStyle: "medium" });
}

export function TelegramBridgePanel({ className }: { className?: string }) {
  const { t, formatLocale } = useTranslation();
  const queryClient = useQueryClient();
  const [token, setToken] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const statusQuery = useQuery({
    queryKey: STATUS_KEY,
    queryFn: (): Promise<TelegramBridgeStatus> => ensureNativeApi().telegramBridge.status(),
    refetchInterval: 3000,
    refetchOnMount: "always",
  });
  const status = statusQuery.data;
  const action = useMutation({
    mutationFn: (
      input: Parameters<ReturnType<typeof ensureNativeApi>["telegramBridge"]["action"]>[0],
    ) => ensureNativeApi().telegramBridge.action(input),
    onSuccess: (next) => {
      setNotice(null);
      setToken("");
      queryClient.setQueryData(STATUS_KEY, next);
    },
    onError: (error) => {
      const code = errorCode(error);
      setNotice(
        code === TELEGRAM_BRIDGE_ERROR_CODES.invalidToken
          ? t("settings:telegram_invalidToken")
          : t("settings:telegram_network"),
      );
    },
  });

  const card =
    "flex flex-col gap-4 rounded-lg border border-border bg-card p-5 text-card-foreground";
  const stateLabel = status
    ? status.state === "running"
      ? t("settings:telegram_stateRunning")
      : status.state === "error"
        ? t("settings:telegram_stateError", { reason: status.reason ?? "" })
        : t("settings:telegram_stateOff")
    : "";
  const activity = formatActivity(status?.lastActivityAt ?? null, formatLocale);
  const noticeRow = notice ? (
    <p role="status" className="rounded-md border border-border bg-muted/40 px-3 py-2 text-ui-sm">
      {notice}
    </p>
  ) : null;

  if (!status?.hasToken) {
    return (
      <div className={className} data-testid="telegram-bridge-panel">
        <div className={card}>
          <div className="space-y-1">
            <p className="text-ui-lg font-medium">{t("settings:telegram_title")}</p>
            <p className="text-ui text-muted-foreground">{t("settings:telegram_intro")}</p>
          </div>
          <ol className="list-decimal space-y-1 pl-5 text-ui">
            <li>{t("settings:telegram_stepBotFather")}</li>
            <li>{t("settings:telegram_stepToken")}</li>
          </ol>
          {noticeRow}
          <form
            className="flex flex-col gap-2 sm:flex-row"
            onSubmit={(event) => {
              event.preventDefault();
              if (token.trim()) action.mutate({ action: "setToken", token: token.trim() });
            }}
          >
            <Input
              type="password"
              autoComplete="off"
              spellCheck={false}
              className="font-mono"
              aria-label={t("settings:telegram_tokenLabel")}
              placeholder={t("settings:telegram_tokenPlaceholder")}
              value={token}
              onChange={(event) => setToken(event.currentTarget.value)}
            />
            <Button type="submit" size="sm" disabled={action.isPending || !token.trim()}>
              {t("settings:telegram_connect")}
            </Button>
          </form>
          <Button
            size="sm"
            variant="link"
            className="self-start"
            onClick={() => openExternalLink("https://t.me/BotFather")}
          >
            {t("settings:telegram_openBotFather")}
          </Button>
        </div>
      </div>
    );
  }

  const botLink = status.botUsername
    ? `https://t.me/${status.botUsername}${status.bindCode ? `?start=${status.bindCode}` : ""}`
    : null;
  return (
    <div className={className} data-testid="telegram-bridge-panel">
      <div className={card}>
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 space-y-1">
            <p className="truncate text-ui-lg font-medium">@{status.botUsername}</p>
            <p className="text-ui-sm text-muted-foreground" data-testid="telegram-state">
              {stateLabel}
              {activity ? ` · ${t("settings:telegram_lastActivity", { time: activity })}` : ""}
            </p>
          </div>
          <label className="flex items-center gap-2 text-ui">
            {t("settings:telegram_enabled")}
            <Switch
              checked={status.enabled}
              disabled={action.isPending}
              onCheckedChange={(checked) =>
                action.mutate({ action: "setEnabled", enabled: Boolean(checked) })
              }
              aria-label={t("settings:telegram_enabled")}
            />
          </label>
        </div>
        {noticeRow}
        {status.ownerName ? (
          <p className="text-ui" data-testid="telegram-owner">
            {t("settings:telegram_owner", { name: status.ownerName })}
          </p>
        ) : (
          <div className="space-y-2">
            <p className="text-ui text-muted-foreground">{t("settings:telegram_bindHint")}</p>
            <p
              className="font-mono text-ui-lg tracking-wider select-all"
              data-testid="telegram-bind-code"
            >
              {status.bindCode}
            </p>
            <div className="flex flex-wrap gap-2">
              {botLink ? (
                <Button size="sm" variant="accent" onClick={() => openExternalLink(botLink)}>
                  {t("settings:telegram_openBot")}
                </Button>
              ) : null}
              <Button
                size="sm"
                variant="outline"
                disabled={action.isPending}
                onClick={() => action.mutate({ action: "newBindCode" })}
              >
                {t("settings:telegram_newCode")}
              </Button>
            </div>
          </div>
        )}
        <div>
          <Button
            size="sm"
            variant="ghost"
            disabled={action.isPending}
            onClick={() => action.mutate({ action: "disconnect" })}
          >
            {t("settings:telegram_disconnect")}
          </Button>
        </div>
      </div>
    </div>
  );
}
