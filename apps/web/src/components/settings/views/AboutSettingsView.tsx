// FILE: AboutSettingsView.tsx
// Purpose: Settings › About: the release channel (Iishko Beta), version, and release history.
// Layer: Settings view
// Exports: AboutSettingsView

import { IISHKO_BETA_CHANNEL_AVAILABLE } from "@iishko/shared/betaFeatures";
import { AboutSettingsSection } from "~/components/settings/AdvancedSettingsPanel";
import { BetaChannelSettingsPanel } from "~/components/settings/DesktopSettingsPanels";

export function AboutSettingsView({ onOpenReleaseHistory }: { onOpenReleaseHistory: () => void }) {
  return (
    <div className="space-y-6">
      {IISHKO_BETA_CHANNEL_AVAILABLE ? <BetaChannelSettingsPanel active={true} /> : null}
      <AboutSettingsSection onOpenReleaseHistory={onOpenReleaseHistory} />
    </div>
  );
}
