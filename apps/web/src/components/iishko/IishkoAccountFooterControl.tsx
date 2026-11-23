// FILE: IishkoAccountFooterControl.tsx
// Purpose: The rail's account entry point for the IISHKO gateway account. The menu shows who is
// connected and leads to the account panel in Settings, Telegram support, and Settings.
// Layer: Web IISHKO account feature (sidebar footer).

import { useNavigate } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { appRailButtonClassName } from "~/components/AppRail";
import { ComposerPickerMenuPopup } from "~/components/chat/ComposerPickerMenuPopup";
import {
  SIDEBAR_CONTEXT_MENU_ITEM_CLASS_NAME,
  SidebarContextMenuIcon,
} from "~/components/sidebarContextMenuStyles";
import { SidebarIconButton } from "~/components/SidebarIconButton";
import {
  Menu,
  MenuGroup,
  MenuItem,
  MenuSeparator,
  MenuShortcut,
  MenuTrigger,
} from "~/components/ui/menu";
import { useTranslation } from "~/i18n";
import { ExternalLinkIcon, SettingsIcon, UserIcon } from "~/lib/icons";
import {
  IISHKO_BOT_URL,
  iishkoAccountLabel,
  iishkoAccountQueryKeys,
  useIishkoAccountStatus,
  useIishkoProfile,
} from "~/lib/iishkoAccountReactQuery";
import { openExternalLink } from "~/lib/linkChips";
import { isMacPlatform } from "~/lib/utils";
import { IishkoModelStatusDialog } from "./IishkoModelStatusDialog";

function formatUsdCompact(value: number): string {
  return `$${value.toFixed(value >= 100 ? 0 : 2)}`;
}

export function IishkoAccountFooterControl() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [statusDialogOpen, setStatusDialogOpen] = useState(false);
  const status = useIishkoAccountStatus().data;
  const connected = status?.state === "connected";
  const profile = useIishkoProfile(connected && status.source === "telegram").data;
  const profileName = profile ? (profile.user.firstName ?? profile.user.username ?? null) : null;
  const label = profileName ?? iishkoAccountLabel(status);
  const rankEmoji = profile?.rank.emoji ?? null;
  const balanceUsd = profile?.balance?.usd;
  const limits = profile?.limits;
  const todayUsd = profile?.spend?.todayUsd ?? limits?.dailyUsdUsed;
  const requestsUsed = limits?.requestsToday;
  const requestsLimit = limits?.requestsLimit;
  const usdCap = limits?.dailyUsdCap;
  const limitRatio =
    requestsLimit !== undefined && requestsLimit > 0 && requestsUsed !== undefined
      ? Math.min(1, Math.max(0, requestsUsed / requestsLimit))
      : usdCap !== undefined && usdCap > 0 && todayUsd !== undefined
        ? Math.min(1, Math.max(0, todayUsd / usdCap))
        : null;
  const limitText =
    requestsLimit !== undefined && requestsUsed !== undefined
      ? `${requestsUsed} / ${requestsLimit}`
      : usdCap !== undefined && todayUsd !== undefined
        ? `${formatUsdCompact(todayUsd)} / ${formatUsdCompact(usdCap)}`
        : null;
  const tooltipExtra = [
    profile?.user.daysInProject !== undefined
      ? t("settings:iishkoProfile_daysInProject", { count: profile.user.daysInProject })
      : null,
    todayUsd !== undefined
      ? t("settings:iishkoFooter_spentToday", { value: formatUsdCompact(todayUsd) })
      : null,
  ]
    .filter(Boolean)
    .join(" · ");
  const title = connected
    ? profile && label
      ? `${label} · ${profile.rank.title}`
      : label
        ? t("settings:iishkoAccount_connectedAs", {
            name: rankEmoji ? `${rankEmoji} ${label}` : label,
          })
        : t("settings:iishkoAccount_connectedManual")
    : t("settings:iishkoAccount_notConnected");
  const openAccount = () => void navigate({ to: "/settings", search: { section: "profile" } });
  const buttonTitle = tooltipExtra ? `${title} — ${tooltipExtra}` : title;

  return (
    <Menu>
      <SidebarIconButton
        render={<MenuTrigger />}
        icon={UserIcon}
        iconClassName="size-5"
        label={buttonTitle}
        className={appRailButtonClassName(false)}
      >
        {connected ? (
          <span className="relative inline-flex size-7 shrink-0 items-center justify-center rounded-full bg-muted text-ui-xs font-semibold text-foreground">
            {(label ?? "И").replace(/^@/u, "").slice(0, 1).toUpperCase()}
            {rankEmoji ? (
              <span
                aria-hidden
                className="absolute -right-1 -bottom-1 inline-flex size-3.5 items-center justify-center rounded-full bg-[var(--iishko-accent)] text-[9px] leading-none"
              >
                {rankEmoji}
              </span>
            ) : null}
          </span>
        ) : undefined}
      </SidebarIconButton>
      <ComposerPickerMenuPopup side="right" align="end" className="w-64 min-w-64">
        <MenuGroup>
          <div className="flex flex-col gap-0.5 px-2 py-1.5">
            <span className="truncate text-ui font-medium text-foreground">{title}</span>
            {connected ? (
              <span className="truncate font-mono text-ui-sm text-muted-foreground">
                {t("settings:iishkoAccount_keyHint", { hint: status.keyHint })}
              </span>
            ) : (
              <span className="text-ui-sm leading-snug text-muted-foreground">
                {t("settings:iishkoAccount_disconnectedBody")}
              </span>
            )}
            {connected && (balanceUsd !== undefined || limitText !== null) ? (
              <span className="flex flex-col gap-1 pt-0.5">
                {balanceUsd !== undefined ? (
                  <span className="text-ui-sm font-medium tabular-nums text-foreground">
                    {formatUsdCompact(balanceUsd)}
                  </span>
                ) : null}
                {limitRatio !== null && limitText !== null ? (
                  <span className="flex items-center gap-2">
                    <span className="h-1 w-16 overflow-hidden rounded-full bg-muted">
                      <span
                        className="block h-full rounded-full bg-[var(--iishko-accent)]"
                        style={{ width: `${Math.round(limitRatio * 100)}%` }}
                      />
                    </span>
                    <span className="text-ui-sm tabular-nums text-muted-foreground">
                      {limitText}
                    </span>
                  </span>
                ) : null}
              </span>
            ) : null}
          </div>
          {connected ? null : (
            <div className="px-2 pt-1 pb-1.5">
              <MenuItem
                className="w-full justify-center rounded-lg border border-transparent bg-primary text-primary-foreground data-highlighted:bg-primary/90 data-highlighted:text-primary-foreground"
                onClick={openAccount}
              >
                {t("settings:iishkoAccount_signIn")}
              </MenuItem>
            </div>
          )}
        </MenuGroup>
        <MenuSeparator />
        <MenuGroup>
          {connected ? (
            <>
              <MenuItem
                className={SIDEBAR_CONTEXT_MENU_ITEM_CLASS_NAME}
                onClick={() => setStatusDialogOpen(true)}
              >
                <SidebarContextMenuIcon icon={SettingsIcon} />
                <span>{t("settings:iishkoModelStatus_open")}</span>
              </MenuItem>
              <MenuItem className={SIDEBAR_CONTEXT_MENU_ITEM_CLASS_NAME} onClick={openAccount}>
                <SidebarContextMenuIcon icon={UserIcon} />
                <span>{t("settings:nav_iishkoAccount")}</span>
              </MenuItem>
            </>
          ) : null}
          <MenuItem
            className={SIDEBAR_CONTEXT_MENU_ITEM_CLASS_NAME}
            onClick={() => openExternalLink(IISHKO_BOT_URL)}
          >
            <SidebarContextMenuIcon icon={ExternalLinkIcon} />
            <span>{t("settings:iishkoAccount_support")}</span>
          </MenuItem>
          <MenuItem
            className={SIDEBAR_CONTEXT_MENU_ITEM_CLASS_NAME}
            onClick={() => void navigate({ to: "/settings" })}
          >
            <SidebarContextMenuIcon icon={SettingsIcon} />
            <span>{t("settings:iishkoAccount_settings")}</span>
            <MenuShortcut>{isMacPlatform(navigator.platform) ? "⌘," : "Ctrl+,"}</MenuShortcut>
          </MenuItem>
        </MenuGroup>
      </ComposerPickerMenuPopup>
      <IishkoModelStatusDialog
        open={statusDialogOpen}
        onOpenChange={setStatusDialogOpen}
        profile={profile}
        refreshing={false}
        onRefresh={() =>
          void queryClient.invalidateQueries({ queryKey: iishkoAccountQueryKeys.profile() })
        }
      />
    </Menu>
  );
}
