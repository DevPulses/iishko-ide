// FILE: feedbackDialogStore.ts
// Purpose: Owns the global feedback entry point. IISHKO IDE uploads no feedback: every
//          "Send feedback" action opens IISHKO support in Telegram instead.
// Layer: Web UI state
// Depends on: The feedback feature context contract and Zustand.

import { create } from "zustand";

import type { FeedbackThreadContext } from "./feedback";
import { openExternalLink } from "./lib/linkChips";

export const IISHKO_SUPPORT_URL = "https://t.me/iishkogatewaybot";

interface FeedbackDialogStore {
  isOpen: boolean;
  context: FeedbackThreadContext | null;
  openDialog: (context?: FeedbackThreadContext) => void;
  setOpen: (open: boolean) => void;
}

export const useFeedbackDialogStore = create<FeedbackDialogStore>(() => ({
  isOpen: false,
  context: null,
  openDialog: () => openExternalLink(IISHKO_SUPPORT_URL),
  setOpen: () => undefined,
}));
