import { afterEach, describe, expect, it, vi } from "vitest";

import type { FeedbackThreadContext } from "./feedback";
import { IISHKO_SUPPORT_URL, useFeedbackDialogStore } from "./feedbackDialogStore";
import * as linkChips from "./lib/linkChips";

describe("feedbackDialogStore", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    useFeedbackDialogStore.setState(useFeedbackDialogStore.getInitialState(), true);
  });

  it("opens IISHKO support in Telegram instead of an upload dialog", () => {
    const open = vi.spyOn(linkChips, "openExternalLink").mockImplementation(() => undefined);
    useFeedbackDialogStore.getState().openDialog({ messageCount: 1 } as FeedbackThreadContext);
    useFeedbackDialogStore.getState().openDialog();

    expect(open).toHaveBeenCalledTimes(2);
    expect(open).toHaveBeenCalledWith(IISHKO_SUPPORT_URL);
    expect(IISHKO_SUPPORT_URL).toBe("https://t.me/iishkogatewaybot");
    expect(useFeedbackDialogStore.getState()).toMatchObject({ isOpen: false, context: null });
  });

  it("never opens the legacy dialog state", () => {
    useFeedbackDialogStore.getState().setOpen(true);
    expect(useFeedbackDialogStore.getState().isOpen).toBe(false);
  });
});
