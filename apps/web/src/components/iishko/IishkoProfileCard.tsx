// FILE: IishkoProfileCard.tsx
// Purpose: The IISHKO profile page body: rank, limits, balance, models and this device.
// Layer: Web IISHKO account feature
//
// Every profile field except user, rank and models is optional; sections render only
// what the gateway reported.

import type { IishkoProfile } from "@iishko/contracts";
import { useQueryClient } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";

import { Button } from "~/components/ui/button";
import { useTranslation } from "~/i18n";
import { InfoIcon } from "~/lib/icons";
import { iishkoAccountQueryKeys } from "~/lib/iishkoAccountReactQuery";
import { iishkoModelDisplayName } from "~/lib/iishkoModelNames";
import { iishkoModelStatusKind, iishkoStatusDotClass } from "~/lib/iishkoModelStatus";
import { cn } from "~/lib/utils";
import { IishkoModelStatusDialog } from "./IishkoModelStatusDialog";

const MODELS_COLLAPSED_COUNT = 12;

function LockGlyph() {
  return (
    <svg
      aria-hidden
      viewBox="0 0 16 16"
      className="size-3 shrink-0"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
    >
      <rect x="3" y="7" width="10" height="6.5" rx="1.5" />
      <path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" />
    </svg>
  );
}

function initials(name: string): string {
  const letters = name
    .trim()
    .split(/\s+/u)
    .map((part) => part.replace(/^@/u, "").charAt(0))
    .filter(Boolean)
    .slice(0, 2)
    .join("");
  return (letters || "И").toUpperCase();
}

function LimitRow(props: {
  readonly label: string;
  readonly used: number;
  readonly limit: number;
}) {
  const ratio = props.limit > 0 ? Math.min(1, Math.max(0, props.used / props.limit)) : 0;
  return (
    <div className="space-y-1.5">
      <div className="flex items-baseline justify-between gap-3 text-ui">
        <span className="min-w-0 truncate">{props.label}</span>
        <span className="shrink-0 tabular-nums text-muted-foreground">
          {props.used} / {props.limit}
        </span>
      </div>
      <div
        role="progressbar"
        aria-label={props.label}
        aria-valuemin={0}
        aria-valuemax={props.limit}
        aria-valuenow={props.used}
        className="h-1 overflow-hidden rounded-full bg-muted"
      >
        <div
          className={cn(
            "h-full rounded-full",
            ratio >= 0.9 ? "bg-destructive" : "bg-[var(--iishko-accent)]",
          )}
          style={{ width: `${Math.round(ratio * 100)}%` }}
        />
      </div>
    </div>
  );
}

function Section(props: { readonly title: string; readonly children: ReactNode }) {
  return (
    <section className="space-y-3">
      <h3 className="text-ui-sm font-medium tracking-wide text-muted-foreground uppercase">
        {props.title}
      </h3>
      {props.children}
    </section>
  );
}

function StatTile(props: { readonly label: string; readonly value: string }) {
  return (
    <div className="rounded-lg border border-border bg-muted/30 px-3 py-2.5">
      <p className="text-ui-sm text-muted-foreground">{props.label}</p>
      <p className="text-ui-lg font-medium tabular-nums">{props.value}</p>
    </div>
  );
}

function SpendTile(props: {
  readonly label: string;
  readonly usd: number | undefined;
  readonly requests: number | undefined;
}) {
  const { t } = useTranslation();
  return (
    <div className="rounded-lg border border-border bg-muted/30 px-3 py-2.5">
      <p className="text-ui-sm text-muted-foreground">{props.label}</p>
      <p className="text-ui-lg font-medium tabular-nums">
        {props.usd !== undefined ? formatUsd(props.usd) : "—"}
      </p>
      {props.requests !== undefined ? (
        <p className="text-ui-sm text-muted-foreground">
          {t("settings:iishkoProfile_spendRequests", { count: props.requests })}
        </p>
      ) : null}
    </div>
  );
}

function ModelChips(props: {
  readonly models: ReadonlyArray<{
    readonly id: string;
    readonly title?: string | undefined;
    readonly status?: string | undefined;
    readonly unstable?: boolean | undefined;
  }>;
  readonly locked?: boolean;
  readonly testId: string;
}) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const shown = expanded ? props.models : props.models.slice(0, MODELS_COLLAPSED_COUNT);
  const hidden = props.models.length - shown.length;
  return (
    <div className="space-y-2">
      <ul className="flex flex-wrap gap-1.5" data-testid={props.testId}>
        {shown.map((model) => {
          const kind =
            !props.locked && model.status !== undefined
              ? iishkoModelStatusKind(model.status, model.unstable)
              : null;
          return (
            <li
              key={model.id}
              title={model.id}
              className={cn(
                "inline-flex items-center gap-1 rounded-md border px-2 py-0.5 font-mono text-ui-sm",
                props.locked
                  ? "border-border text-muted-foreground opacity-60"
                  : "border-[var(--iishko-accent)] text-foreground",
              )}
            >
              {props.locked ? (
                <LockGlyph />
              ) : kind ? (
                <span
                  aria-hidden
                  className={cn("size-1.5 rounded-full", iishkoStatusDotClass(kind))}
                />
              ) : null}
              {iishkoModelDisplayName(model.id, model.title)}
            </li>
          );
        })}
      </ul>
      {hidden > 0 ? (
        <Button size="xs" variant="ghost" onClick={() => setExpanded(true)}>
          {t("settings:iishkoProfile_showAll", { count: hidden })}
        </Button>
      ) : null}
    </div>
  );
}

function relativeReset(iso: string, locale: string): string | null {
  const ms = Date.parse(iso) - Date.now();
  if (!Number.isFinite(ms) || ms <= 0) return null;
  const formatter = new Intl.RelativeTimeFormat(locale, { numeric: "always", style: "short" });
  const hours = Math.round(ms / 3_600_000);
  if (hours >= 1) return formatter.format(hours, "hour");
  return formatter.format(Math.max(1, Math.round(ms / 60_000)), "minute");
}

function useTierTitle() {
  const { t } = useTranslation();
  return (tier: string): string => {
    switch (tier) {
      case "0":
      case "1":
        return t("settings:iishkoProfile_tier1");
      case "2":
        return t("settings:iishkoProfile_tier2");
      case "3":
        return t("settings:iishkoProfile_tier3");
      case "4":
        return t("settings:iishkoProfile_tier4");
      case "5":
        return t("settings:iishkoProfile_tier5");
      default:
        return tier;
    }
  };
}

function formatUsd(value: number): string {
  return `$${value.toFixed(value >= 100 ? 0 : 2)}`;
}

export function IishkoProfileCard(props: {
  readonly profile: IishkoProfile;
  readonly busy: boolean;
  readonly onSignOut: () => void;
  readonly className?: string;
}) {
  const { t, formatLocale } = useTranslation();
  const tierTitle = useTierTitle();
  const queryClient = useQueryClient();
  const [statusDialogOpen, setStatusDialogOpen] = useState(false);
  const { profile } = props;
  const name = profile.user.firstName ?? profile.user.username ?? "";
  const { limits, balance, spend } = profile;
  const hasLimits =
    limits !== undefined &&
    (limits.requestsLimit !== undefined ||
      limits.dailyUsdCap !== undefined ||
      limits.rpm !== undefined ||
      limits.concurrency !== undefined ||
      (limits.premium?.length ?? 0) > 0);
  const reset = limits?.resetAt ? relativeReset(limits.resetAt, formatLocale) : null;
  const lockedByTier = new Map<string, Array<{ id: string; title?: string | undefined }>>();
  for (const model of profile.models.locked) {
    lockedByTier.set(model.minTier, [...(lockedByTier.get(model.minTier) ?? []), model]);
  }
  return (
    <div className={cn("flex flex-col gap-6", props.className)} data-testid="iishko-profile">
      <div className="flex items-center gap-4 rounded-lg border border-border bg-card p-5">
        {profile.user.photoUrl ? (
          <img
            src={profile.user.photoUrl}
            alt=""
            referrerPolicy="no-referrer"
            className="size-14 shrink-0 rounded-full object-cover"
          />
        ) : (
          <span
            aria-hidden
            className="inline-flex size-14 shrink-0 items-center justify-center rounded-full bg-muted text-ui-lg font-semibold text-foreground"
          >
            {initials(name || profile.user.username || "")}
          </span>
        )}
        <div className="min-w-0 flex-1 space-y-1">
          <p className="truncate text-ui-lg font-medium">{name}</p>
          {profile.user.username ? (
            <p className="truncate text-ui-sm text-muted-foreground">@{profile.user.username}</p>
          ) : null}
          <p className="flex flex-wrap items-center gap-2">
            <span
              className="inline-flex items-center gap-1 rounded-full bg-[var(--iishko-accent)] px-2.5 py-0.5 text-ui-sm font-medium text-[#111111]"
              data-testid="iishko-rank-badge"
            >
              {profile.rank.emoji ? <span aria-hidden>{profile.rank.emoji}</span> : null}
              {profile.rank.title}
            </span>
            {profile.rank.next ? (
              <span className="text-ui-sm text-muted-foreground">
                {t("settings:iishkoProfile_nextRank", { rank: profile.rank.next.title })}
              </span>
            ) : null}
          </p>
          {profile.user.daysInProject !== undefined ? (
            <p className="text-ui-sm text-muted-foreground">
              {t("settings:iishkoProfile_daysInProject", { count: profile.user.daysInProject })}
            </p>
          ) : null}
        </div>
      </div>

      {profile.ideOnly?.applies ? (
        <div
          role="note"
          className="flex items-start gap-2.5 rounded-lg border border-border bg-muted/40 px-3.5 py-3 text-ui-sm text-foreground"
        >
          <InfoIcon
            aria-hidden
            className="mt-0.5 size-4 shrink-0 text-[var(--color-text-accent)]"
          />
          <span>{t("settings:iishkoProfile_ideOnly")}</span>
        </div>
      ) : null}

      {hasLimits && limits ? (
        <Section title={t("settings:iishkoProfile_limits")}>
          {limits.requestsLimit !== undefined ? (
            <LimitRow
              label={t("settings:iishkoProfile_requestsToday")}
              used={limits.requestsToday ?? 0}
              limit={limits.requestsLimit}
            />
          ) : null}
          {(limits.premium ?? []).map((entry) => (
            <LimitRow key={entry.name} label={entry.name} used={entry.used} limit={entry.limit} />
          ))}
          {limits.dailyUsdCap !== undefined ? (
            <LimitRow
              label={t("settings:iishkoProfile_dailyBudget")}
              used={Math.round((limits.dailyUsdUsed ?? 0) * 100) / 100}
              limit={limits.dailyUsdCap}
            />
          ) : null}
          {limits.rpm !== undefined ? (
            <div className="flex items-baseline justify-between gap-3 text-ui-sm text-muted-foreground">
              <span>{t("settings:iishkoProfile_rpm")}</span>
              <span className="tabular-nums text-foreground">{limits.rpm}</span>
            </div>
          ) : null}
          {limits.concurrency !== undefined ? (
            <div className="flex items-baseline justify-between gap-3 text-ui-sm text-muted-foreground">
              <span>{t("settings:iishkoProfile_concurrency")}</span>
              <span className="tabular-nums text-foreground">{limits.concurrency}</span>
            </div>
          ) : null}
          {reset ? (
            <p className="text-ui-sm text-muted-foreground">
              {t("settings:iishkoProfile_resetRelative", { when: reset })}
            </p>
          ) : null}
        </Section>
      ) : null}

      {balance && (balance.usd !== undefined || balance.weeklyCreditUsd !== undefined) ? (
        <Section title={t("settings:iishkoProfile_balance")}>
          <div className="grid grid-cols-2 gap-3">
            {balance.usd !== undefined ? (
              <StatTile
                label={t("settings:iishkoProfile_balanceTile")}
                value={formatUsd(balance.usd)}
              />
            ) : null}
            {balance.weeklyCreditUsd !== undefined ? (
              <StatTile
                label={t("settings:iishkoProfile_weeklyCreditTile")}
                value={formatUsd(balance.weeklyCreditUsd)}
              />
            ) : null}
          </div>
        </Section>
      ) : null}

      {spend ? (
        <Section title={t("settings:iishkoProfile_spend")}>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <SpendTile
              label={t("settings:iishkoProfile_spendToday")}
              usd={spend.todayUsd ?? limits?.dailyUsdUsed}
              requests={spend.todayRequests}
            />
            <SpendTile
              label={t("settings:iishkoProfile_spendWeek")}
              usd={spend.weekUsd}
              requests={spend.weekRequests}
            />
            <SpendTile
              label={t("settings:iishkoProfile_spendMonth")}
              usd={spend.monthUsd}
              requests={spend.monthRequests}
            />
            <SpendTile
              label={t("settings:iishkoProfile_spendTotal")}
              usd={spend.totalUsd}
              requests={undefined}
            />
          </div>
          {(spend.topModels ?? []).length > 0 ? (
            <div className="space-y-1.5">
              <p className="text-ui-sm text-muted-foreground">
                {t("settings:iishkoProfile_topModels")}
              </p>
              <ul className="flex flex-wrap gap-1.5">
                {(spend.topModels ?? []).map((model) => (
                  <li
                    key={model.id}
                    className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-0.5 text-ui-sm text-foreground"
                  >
                    {model.title ?? model.id}
                    {model.usd !== undefined ? ` · ${formatUsd(model.usd)}` : ""}
                    {` · ${model.requests}`}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </Section>
      ) : null}

      <Section title={t("settings:iishkoProfile_models")}>
        <div className="flex justify-end">
          <Button size="xs" variant="outline" onClick={() => setStatusDialogOpen(true)}>
            {t("settings:iishkoModelStatus_open")}
          </Button>
        </div>
        {profile.models.available.length > 0 ? (
          <ModelChips models={profile.models.available} testId="iishko-available-models" />
        ) : (
          <p className="text-ui text-muted-foreground">{t("settings:iishkoProfile_noModels")}</p>
        )}
        {[...lockedByTier.entries()].map(([tier, models]) => (
          <div key={tier} className="space-y-1.5" data-testid="iishko-locked-models">
            <p className="text-ui-sm text-muted-foreground">
              {t("settings:iishkoProfile_unlocksAtRank", { rank: tierTitle(tier) })}
            </p>
            <ModelChips models={models} locked testId="iishko-locked-list" />
          </div>
        ))}
      </Section>

      {profile.device ? (
        <p className="text-ui-sm text-muted-foreground">
          {t("settings:iishkoProfile_device")}:{" "}
          <span className="text-foreground">{profile.device.name}</span>
        </p>
      ) : null}

      <div>
        <Button size="sm" variant="ghost" disabled={props.busy} onClick={props.onSignOut}>
          {t("settings:iishkoProfile_signOut")}
        </Button>
      </div>

      <IishkoModelStatusDialog
        open={statusDialogOpen}
        onOpenChange={setStatusDialogOpen}
        profile={profile}
        refreshing={false}
        onRefresh={() =>
          void queryClient.invalidateQueries({ queryKey: iishkoAccountQueryKeys.profile() })
        }
      />
    </div>
  );
}
