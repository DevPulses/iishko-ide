// FILE: IishkoAccountPanel.tsx
// Purpose: Connects the built-in IISHKO provider: Telegram bot sign-in, a pasted API key, or disconnect.
// Layer: Web IISHKO account feature (settings section and onboarding step).

import {
  IISHKO_ACCOUNT_ERROR_CODES,
  type IishkoAccountStatus,
  type IishkoTelegramPairingStart,
} from "@iishko/contracts";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";

import { IishkoLogo } from "@iishko/profile-ui/logo";

import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { useTranslation } from "~/i18n";
import {
  IISHKO_BOT_HANDLE,
  IISHKO_BOT_URL,
  applyIishkoAccountStatus,
  iishkoAccountQueryKeys,
  iishkoAccountLabel,
  useIishkoAccountStatus,
  useIishkoProfile,
} from "~/lib/iishkoAccountReactQuery";
import { IishkoProfileCard } from "./IishkoProfileCard";
import { useIishkoLoginRequestStore } from "~/lib/iishkoLoginRequest";
import { openExternalLink } from "~/lib/linkChips";
import { cn } from "~/lib/utils";
import { ensureNativeApi } from "~/nativeApi";

type StartedPairing = Extract<IishkoTelegramPairingStart, { state: "started" }> & {
  readonly startedAt: number;
};
type Notice = "expired" | "denied" | "unavailable" | "invalidKey" | "network" | "revoked";
type View = { kind: "idle" } | { kind: "pairing"; pairing: StartedPairing } | { kind: "manual" };

const NOTICE_KEYS: Record<Notice, string> = {
  expired: "settings:iishkoAccount_codeExpired",
  denied: "settings:iishkoAccount_denied",
  unavailable: "settings:iishkoAccount_unavailable",
  invalidKey: "settings:iishkoAccount_invalidKey",
  network: "settings:iishkoAccount_network",
  revoked: "settings:iishkoAccount_revoked",
};

function noticeFromError(error: unknown): Notice {
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? (error as { code: unknown }).code
      : null;
  if (code === IISHKO_ACCOUNT_ERROR_CODES.revoked) return "revoked";
  return code === IISHKO_ACCOUNT_ERROR_CODES.invalidKey ? "invalidKey" : "network";
}

function formatRemaining(ms: number): string {
  const seconds = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

/** Polls a started pairing until it settles; stops when the view unmounts or changes. */
function usePairingPoll(
  pairing: StartedPairing | null,
  onSettled: (result: { connected: IishkoAccountStatus } | { notice: Notice }) => void,
) {
  const settledRef = useRef(onSettled);
  settledRef.current = onSettled;
  useEffect(() => {
    if (!pairing) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      try {
        const result = await ensureNativeApi().iishko.pollTelegramPairing({
          pairingId: pairing.pairingId,
        });
        if (!active) return;
        if (result.state === "pending") {
          timer = setTimeout(() => void poll(), pairing.pollIntervalMs);
          return;
        }
        settledRef.current(
          result.state === "connected"
            ? { connected: result.status }
            : { notice: result.state === "denied" ? "denied" : "expired" },
        );
      } catch (error) {
        if (active) settledRef.current({ notice: noticeFromError(error) });
      }
    };
    timer = setTimeout(() => void poll(), pairing.pollIntervalMs);
    return () => {
      active = false;
      if (timer) clearTimeout(timer);
    };
  }, [pairing]);
}

function useNow(enabled: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!enabled) return;
    const interval = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(interval);
  }, [enabled]);
  return now;
}

export function IishkoAccountPanel({ className }: { className?: string }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const statusQuery = useIishkoAccountStatus();
  const status = statusQuery.data;
  const telegramConnected = status?.state === "connected" && status.source === "telegram";
  const profileQuery = useIishkoProfile(telegramConnected);
  const [view, setView] = useState<View>({ kind: "idle" });
  const [notice, setNotice] = useState<Notice | null>(null);
  const [busy, setBusy] = useState(false);
  const [apiKey, setApiKey] = useState("");
  const [copied, setCopied] = useState(false);
  const pairing = view.kind === "pairing" ? view.pairing : null;
  const now = useNow(pairing !== null);

  usePairingPoll(pairing, (result) => {
    setView({ kind: "idle" });
    if ("connected" in result) {
      setNotice(null);
      applyIishkoAccountStatus(queryClient, result.connected);
    } else {
      setNotice(result.notice);
    }
  });

  useEffect(() => {
    if (pairing && Date.parse(pairing.expiresAt) <= now) {
      setView({ kind: "idle" });
      setNotice("expired");
    }
  }, [now, pairing]);

  const run = async (task: () => Promise<void>) => {
    setBusy(true);
    try {
      await task();
    } catch (error) {
      setNotice(noticeFromError(error));
    } finally {
      setBusy(false);
    }
  };

  const startTelegram = () =>
    run(async () => {
      setNotice(null);
      const result = await ensureNativeApi().iishko.beginTelegramPairing();
      if (result.state === "unavailable") {
        setNotice("unavailable");
        setView({ kind: "manual" });
        return;
      }
      setCopied(false);
      setView({ kind: "pairing", pairing: { ...result, startedAt: Date.now() } });
      openExternalLink(result.botUrl);
    });

  const loginRequested = useIishkoLoginRequestStore((store) => store.pending);
  const consumeLoginRequest = useIishkoLoginRequestStore((store) => store.consume);
  useEffect(() => {
    if (!loginRequested || !status) return;
    consumeLoginRequest();
    if (status.state !== "connected" && view.kind === "idle") void startTelegram();
    // The request is consumed once; starting is a reaction to it, not to later renders.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loginRequested, status]);

  const cancelPairing = () => {
    if (pairing)
      void ensureNativeApi().iishko.cancelTelegramPairing({ pairingId: pairing.pairingId });
    setView({ kind: "idle" });
  };

  const connectKey = () =>
    run(async () => {
      setNotice(null);
      const next = await ensureNativeApi().iishko.connectApiKey({ apiKey: apiKey.trim() });
      void queryClient.removeQueries({ queryKey: iishkoAccountQueryKeys.profile() });
      setApiKey("");
      setView({ kind: "idle" });
      applyIishkoAccountStatus(queryClient, next);
    });

  const signOut = () =>
    run(async () => {
      await ensureNativeApi().iishko.signOut();
      setNotice(null);
      applyIishkoAccountStatus(queryClient, { state: "disconnected" });
    });

  const copyCode = (code: string) => {
    void navigator.clipboard?.writeText(code).then(() => setCopied(true));
  };

  const noticeRow = notice ? (
    <div
      role="status"
      className="flex flex-wrap items-center gap-2 rounded-md border border-border bg-muted/40 px-3 py-2 text-ui-sm text-foreground"
    >
      <span className="min-w-0 flex-1">{t(NOTICE_KEYS[notice])}</span>
      {notice === "expired" || notice === "denied" || notice === "revoked" ? (
        <Button size="xs" variant="outline" disabled={busy} onClick={() => void startTelegram()}>
          {notice === "revoked"
            ? t("settings:iishkoAccount_signInWithTelegram")
            : t("settings:iishkoAccount_getNewCode")}
        </Button>
      ) : notice === "network" ? (
        <Button size="xs" variant="outline" onClick={() => void statusQuery.refetch()}>
          {t("settings:iishkoAccount_retry")}
        </Button>
      ) : null}
    </div>
  ) : null;

  useEffect(() => {
    if (profileQuery.error && noticeFromError(profileQuery.error) === "revoked") {
      void statusQuery.refetch();
    }
  }, [profileQuery.error, statusQuery]);
  useEffect(() => {
    if (status?.state === "revoked") setNotice("revoked");
  }, [status?.state]);

  const card = cn(
    "flex flex-col gap-4 rounded-lg border border-border bg-card p-5 text-card-foreground",
    className,
  );

  if (telegramConnected && view.kind === "idle" && profileQuery.data) {
    return (
      <div className={className} data-testid="iishko-account-panel">
        <IishkoProfileCard
          profile={profileQuery.data}
          busy={busy}
          onSignOut={() => void signOut()}
        />
        {notice ? <div className="mt-3">{noticeRow}</div> : null}
      </div>
    );
  }

  if (status?.state === "connected" && view.kind === "idle") {
    const label = iishkoAccountLabel(status);
    return (
      <div className={card} data-testid="iishko-account-panel">
        <div className="flex items-start gap-3">
          <span
            aria-hidden
            className="mt-1.5 size-2 shrink-0 rounded-full bg-[var(--iishko-accent)]"
          />
          <div className="min-w-0 flex-1 space-y-1">
            <p className="truncate text-ui-lg font-medium">
              {label
                ? t("settings:iishkoAccount_connectedAs", { name: label })
                : t("settings:iishkoAccount_connectedManual")}
            </p>
            <p className="font-mono text-ui-sm text-muted-foreground">
              {t("settings:iishkoAccount_keyHint", { hint: status.keyHint })}
            </p>
          </div>
          <Button
            size="sm"
            variant="destructive-outline"
            disabled={busy}
            onClick={() => void signOut()}
          >
            {t("settings:iishkoAccount_disconnect")}
          </Button>
        </div>
        {noticeRow}
      </div>
    );
  }

  if (pairing) {
    const total = Math.max(1, Date.parse(pairing.expiresAt) - pairing.startedAt);
    const remaining = Date.parse(pairing.expiresAt) - now;
    const fraction = Math.min(1, Math.max(0, remaining / total));
    return (
      <div
        className={cn(card, "items-center gap-5 text-center")}
        data-testid="iishko-account-panel"
      >
        <button
          type="button"
          title={
            copied ? t("settings:iishkoAccount_codeCopied") : t("settings:iishkoAccount_copyCode")
          }
          onClick={() => copyCode(pairing.code)}
          className="rounded-md px-3 py-1 font-mono text-4xl tracking-[0.16em] text-foreground transition-colors hover:bg-muted"
          data-testid="iishko-pairing-code"
        >
          {pairing.code}
        </button>
        <ol className="space-y-1 text-left text-ui text-foreground">
          <li>{t("settings:iishkoAccount_stepOpenBot", { bot: IISHKO_BOT_HANDLE })}</li>
          <li>{t("settings:iishkoAccount_stepConfirm", { code: pairing.code })}</li>
        </ol>
        <div className="flex flex-wrap justify-center gap-2">
          <Button size="sm" variant="accent" onClick={() => openExternalLink(pairing.botUrl)}>
            {t("settings:iishkoAccount_openTelegram")}
          </Button>
          <Button size="sm" variant="outline" onClick={() => copyCode(pairing.code)}>
            {copied ? t("settings:iishkoAccount_codeCopied") : t("settings:iishkoAccount_copyCode")}
          </Button>
          <Button size="sm" variant="ghost" onClick={cancelPairing}>
            {t("settings:iishkoAccount_cancel")}
          </Button>
        </div>
        <div className="w-full space-y-2" aria-live="polite">
          <div className="h-1 w-full overflow-hidden rounded-full bg-muted" aria-hidden>
            <div
              className="h-full rounded-full bg-[var(--iishko-accent)]"
              style={{ width: `${Math.round(fraction * 100)}%` }}
            />
          </div>
          <p className="flex items-center justify-center gap-2 text-ui-sm text-muted-foreground">
            <span
              aria-hidden
              className="size-2 animate-pulse rounded-full bg-[var(--iishko-accent)]"
            />
            {t("settings:iishkoAccount_waiting")} ·{" "}
            {t("settings:iishkoAccount_expiresIn", { time: formatRemaining(remaining) })}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className={card} data-testid="iishko-account-panel">
      <div className="flex flex-col items-center gap-3 text-center">
        <IishkoLogo aria-hidden className="size-10" />
        <p className="text-ui-lg font-medium">{t("settings:iishkoAccount_disconnectedTitle")}</p>
        <ul className="space-y-1 text-left text-ui text-muted-foreground">
          <li>{t("settings:iishkoAccount_benefitModels")}</li>
          <li>{t("settings:iishkoAccount_benefitLimits")}</li>
          <li>{t("settings:iishkoAccount_benefitFast")}</li>
        </ul>
      </div>
      {noticeRow}
      {view.kind === "manual" ? (
        <form
          className="flex flex-col gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (apiKey.trim()) void connectKey();
          }}
        >
          <label className="text-ui-sm text-muted-foreground" htmlFor="iishko-api-key">
            {t("settings:iishkoAccount_apiKeyLabel")}
          </label>
          <div className="flex flex-col gap-2 sm:flex-row">
            <Input
              id="iishko-api-key"
              type="password"
              autoComplete="off"
              spellCheck={false}
              className="font-mono"
              placeholder={t("settings:iishkoAccount_apiKeyPlaceholder")}
              value={apiKey}
              onChange={(event) => setApiKey(event.currentTarget.value)}
            />
            <Button type="submit" size="sm" disabled={busy || !apiKey.trim()}>
              {t("settings:iishkoAccount_verifyAndSave")}
            </Button>
          </div>
          <p className="text-ui-sm text-muted-foreground">
            {t("settings:iishkoAccount_apiKeyHint")}{" "}
            <button
              type="button"
              className="text-primary underline-offset-4 hover:underline"
              onClick={() => openExternalLink(IISHKO_BOT_URL)}
            >
              {IISHKO_BOT_HANDLE}
            </button>
          </p>
          <div>
            <Button size="sm" variant="ghost" onClick={() => setView({ kind: "idle" })}>
              {t("settings:iishkoAccount_back")}
            </Button>
          </div>
        </form>
      ) : (
        <div className="flex flex-wrap items-center justify-center gap-3">
          <Button size="sm" variant="accent" disabled={busy} onClick={() => void startTelegram()}>
            {t("settings:iishkoAccount_signInWithTelegram")}
          </Button>
          <Button size="sm" variant="link" onClick={() => setView({ kind: "manual" })}>
            {t("settings:iishkoAccount_haveApiKey")}
          </Button>
        </div>
      )}
    </div>
  );
}
