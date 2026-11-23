// FILE: IishkoModelStatusDialog.tsx
// Purpose: Dialog listing per-model IISHKO gateway probe status, opened from the
//          account footer and the profile card. Shares the profile react-query.
// Layer: Web IISHKO account feature

import { useTranslation } from "~/i18n";
import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "~/components/ui/dialog";
import { RefreshCwIcon } from "~/lib/icons";
import {
  iishkoLockedModelGroups,
  iishkoModelStatusRows,
  iishkoStatusDotClass,
  type IishkoModelStatusKind,
} from "~/lib/iishkoModelStatus";
import type { IishkoProfile } from "@iishko/contracts";
import { cn } from "~/lib/utils";

const STATUS_LABEL_KEYS: Record<IishkoModelStatusKind, string> = {
  up: "settings:iishkoModelStatus_up",
  busy: "settings:iishkoModelStatus_busy",
  unstable: "settings:iishkoModelStatus_unstable",
  down: "settings:iishkoModelStatus_down",
  unavailable: "settings:iishkoModelStatus_unavailable",
  unknown: "settings:iishkoModelStatus_unknown",
};

function relativeUpdated(iso: string, locale: string): string {
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms) || ms < 0) return "";
  const formatter = new Intl.RelativeTimeFormat(locale, { numeric: "always", style: "short" });
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return formatter.format(0, "minute");
  if (minutes < 60) return formatter.format(-minutes, "minute");
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return formatter.format(-hours, "hour");
  return formatter.format(-Math.floor(hours / 24), "day");
}

function formatLatency(ms: number, locale: string): string {
  const seconds = ms / 1000;
  const text = seconds >= 10 ? seconds.toFixed(0) : seconds.toFixed(1);
  return `${text.replace(".", locale === "ru" ? "," : ".")} ${locale === "ru" ? "с" : "s"}`;
}

export function IishkoModelStatusDialog(props: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly profile: IishkoProfile | undefined;
  readonly onRefresh: () => void;
  readonly refreshing: boolean;
}) {
  const { t, formatLocale } = useTranslation();
  const rows = props.profile ? iishkoModelStatusRows(props.profile) : [];
  const lockedGroups = props.profile ? iishkoLockedModelGroups(props.profile) : [];
  const lockedCount = lockedGroups.reduce((sum, group) => sum + group.count, 0);
  const updated = props.profile ? relativeUpdated(props.profile.fetchedAt, formatLocale) : "";

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      {props.open ? (
        <DialogPopup className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{t("settings:iishkoModelStatus_title")}</DialogTitle>
            <DialogDescription className="flex items-center justify-between gap-3">
              <span>
                {updated ? t("settings:iishkoModelStatus_updatedAgo", { when: updated }) : ""}
              </span>
              <Button
                size="xs"
                variant="ghost"
                disabled={props.refreshing}
                onClick={props.onRefresh}
              >
                <RefreshCwIcon className={cn("size-3.5", props.refreshing && "animate-spin")} />
                {t("settings:iishkoModelStatus_refresh")}
              </Button>
            </DialogDescription>
          </DialogHeader>
          <DialogPanel className="space-y-1">
            {rows.length === 0 ? (
              <p className="py-4 text-center text-ui text-muted-foreground">
                {t("settings:iishkoModelStatus_empty")}
              </p>
            ) : (
              <ul className="divide-y divide-border">
                {rows.map((row) => (
                  <li key={row.id} className="flex items-center gap-2.5 py-2">
                    <span
                      aria-hidden
                      className={cn("size-2 shrink-0 rounded-full", iishkoStatusDotClass(row.kind))}
                    />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-baseline gap-2">
                        <span className="truncate text-ui text-foreground">
                          {row.title ?? row.id}
                        </span>
                        <span className="truncate font-mono text-ui-sm text-muted-foreground">
                          {row.id}
                        </span>
                      </div>
                      {row.kind !== "up" && row.reason ? (
                        <p className="truncate text-ui-sm text-muted-foreground">{row.reason}</p>
                      ) : null}
                    </div>
                    {row.latencyMs !== undefined ? (
                      <span className="shrink-0 text-ui-sm tabular-nums text-muted-foreground">
                        {formatLatency(row.latencyMs, formatLocale)}
                      </span>
                    ) : null}
                    <span
                      className={cn(
                        "w-24 shrink-0 text-right text-ui-sm",
                        row.kind === "up" ? "text-foreground" : "text-muted-foreground",
                      )}
                    >
                      {t(STATUS_LABEL_KEYS[row.kind])}
                    </span>
                  </li>
                ))}
              </ul>
            )}
            {lockedCount > 0 ? (
              <details className="pt-2">
                <summary className="cursor-pointer text-ui-sm text-muted-foreground">
                  {t("settings:iishkoModelStatus_lockedGroup", { count: lockedCount })}
                </summary>
                <ul className="mt-1 space-y-1 pl-3">
                  {lockedGroups.map((group) => (
                    <li key={group.minTier} className="text-ui-sm text-muted-foreground">
                      {t("settings:iishkoModelStatus_lockedTier", {
                        rank: group.minTier,
                        count: group.count,
                      })}
                    </li>
                  ))}
                </ul>
              </details>
            ) : null}
          </DialogPanel>
        </DialogPopup>
      ) : null}
    </Dialog>
  );
}
