// FILE: IishkoAccountFooterControl.tsx
// Purpose: The rail's account entry point for the IISHKO gateway account. The menu shows who is
// connected and leads to the account panel in Settings, Telegram support, and Settings.
// Layer: Web IISHKO account feature (sidebar footer).

import { useNavigate } from "@tanstack/react-router";

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
  useIishkoAccountStatus,
  useIishkoProfile,
} from "~/lib/iishkoAccountReactQuery";
import { openExternalLink } from "~/lib/linkChips";
import { isMacPlatform } from "~/lib/utils";

export function IishkoAccountFooterControl() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const status = useIishkoAccountStatus().data;
  const connected = status?.state === "connected";
  const profile = useIishkoProfile(connected && status.source === "telegram").data;
  const profileName = profile ? (profile.user.firstName ?? profile.user.username ?? null) : null;
  const label = profileName ?? iishkoAccountLabel(status);
  const rankEmoji = profile?.rank.emoji ?? null;
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

  return (
    <Menu>
      <SidebarIconButton
        render={<MenuTrigger />}
        icon={UserIcon}
        iconClassName="size-5"
        label={title}
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
            <MenuItem className={SIDEBAR_CONTEXT_MENU_ITEM_CLASS_NAME} onClick={openAccount}>
              <SidebarContextMenuIcon icon={UserIcon} />
              <span>{t("settings:nav_iishkoAccount")}</span>
            </MenuItem>
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
    </Menu>
  );
}
