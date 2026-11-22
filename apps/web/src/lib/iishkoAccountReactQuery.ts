// FILE: iishkoAccountReactQuery.ts
// Purpose: React Query state for the IISHKO gateway account behind the built-in provider.
// Layer: Web data-fetching (see serverReactQuery.ts for the conventions).

import type { IishkoAccountStatus, IishkoProfile } from "@iishko/contracts";
import { queryOptions, useQuery, type QueryClient } from "@tanstack/react-query";

import { providerDiscoveryQueryKeys } from "~/lib/providerDiscoveryReactQuery";
import { ensureNativeApi } from "~/nativeApi";

export const IISHKO_BOT_URL = "https://t.me/iishkogatewaybot";
export const IISHKO_BOT_HANDLE = "@iishkogatewaybot";

export const iishkoAccountQueryKeys = {
  status: () => ["iishko", "account", "status"] as const,
  profile: () => ["iishko", "account", "profile"] as const,
};

export function iishkoProfileQueryOptions(enabled: boolean) {
  return queryOptions({
    queryKey: iishkoAccountQueryKeys.profile(),
    queryFn: (): Promise<IishkoProfile> => ensureNativeApi().iishko.profile(),
    enabled,
    staleTime: 60_000,
    refetchOnMount: "always",
    retry: 1,
  });
}

export function useIishkoProfile(enabled: boolean) {
  return useQuery(iishkoProfileQueryOptions(enabled));
}

export function iishkoAccountStatusQueryOptions() {
  return queryOptions({
    queryKey: iishkoAccountQueryKeys.status(),
    queryFn: (): Promise<IishkoAccountStatus> => ensureNativeApi().iishko.status(),
    staleTime: 30_000,
    refetchOnWindowFocus: true,
    retry: 1,
  });
}

export function useIishkoAccountStatus() {
  return useQuery(iishkoAccountStatusQueryOptions());
}

/** A connect or sign-out changes which IISHKO models the provider lists. */
export function applyIishkoAccountStatus(queryClient: QueryClient, status: IishkoAccountStatus) {
  queryClient.setQueryData(iishkoAccountQueryKeys.status(), status);
  void queryClient.invalidateQueries({ queryKey: providerDiscoveryQueryKeys.modelsAll });
}

/** Account name for compact surfaces: `@username`, the Telegram name, or null for a pasted key. */
export function iishkoAccountLabel(status: IishkoAccountStatus | undefined): string | null {
  if (status?.state !== "connected") return null;
  if (status.account.username) return `@${status.account.username}`;
  return status.account.displayName;
}
