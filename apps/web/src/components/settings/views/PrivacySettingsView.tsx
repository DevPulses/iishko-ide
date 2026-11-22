// FILE: PrivacySettingsView.tsx
// Purpose: Settings › Privacy: what IISHKO IDE may read on this computer (Safari sign-ins for
//          the in-app browser). The app sends no product analytics.
// Layer: Settings view
// Exports: PrivacySettingsView

import { SafariAccessSetupButton } from "~/components/SafariAccessOnboarding";

export function PrivacySettingsView() {
  return (
    <div className="space-y-6">
      <SafariAccessSetupButton />
    </div>
  );
}
