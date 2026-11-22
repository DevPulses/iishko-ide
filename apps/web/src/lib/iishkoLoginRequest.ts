// FILE: iishkoLoginRequest.ts
// Purpose: Routes every "sign in to IISHKO" entry point to the Telegram account login.
// Layer: Web IISHKO account feature
//
// The built-in IISHKO provider runs on the bundled Pi SDK and has no CLI sign-in. Entry points
// (model picker, provider settings, onboarding, health banner) request the account login here;
// the account panel consumes the request and starts the Telegram pairing.

import { create } from "zustand";

interface IishkoLoginRequestStore {
  readonly pending: boolean;
  readonly request: () => void;
  readonly consume: () => void;
}

export const useIishkoLoginRequestStore = create<IishkoLoginRequestStore>((set) => ({
  pending: false,
  request: () => set({ pending: true }),
  consume: () => set({ pending: false }),
}));

/** The built-in provider is the default Pi instance without an explicit binary path. */
export function isBuiltInIishkoAccount(
  account: { readonly provider: string; readonly instanceId: string },
  piBinaryPath: string,
): boolean {
  return (
    account.provider === "pi" && String(account.instanceId) === "pi" && piBinaryPath.trim() === ""
  );
}
