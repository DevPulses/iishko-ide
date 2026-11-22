import chatEn from "./locales/en/chat.json";
import onboardingEn from "./locales/en/onboarding.json";
import workspaceEn from "./locales/en/workspace.json";
import settingsEn from "./locales/en/settings.json";
import commonEn from "./locales/en/common.json";
import computerEn from "./locales/en/computer.json";
import automationEn from "./locales/en/automation.json";
import gitEn from "./locales/en/git.json";
import chatRu from "./locales/ru/chat.json";
import onboardingRu from "./locales/ru/onboarding.json";
import workspaceRu from "./locales/ru/workspace.json";
import settingsRu from "./locales/ru/settings.json";
import commonRu from "./locales/ru/common.json";
import computerRu from "./locales/ru/computer.json";
import automationRu from "./locales/ru/automation.json";
import gitRu from "./locales/ru/git.json";

export const uiLocalizationResources = {
  en: {
    chat: chatEn,
    onboarding: onboardingEn,
    workspace: workspaceEn,
    settings: settingsEn,
    common: commonEn,
    computer: computerEn,
    automation: automationEn,
    git: gitEn,
  },
  ru: {
    chat: chatRu,
    onboarding: onboardingRu,
    workspace: workspaceRu,
    settings: settingsRu,
    common: commonRu,
    computer: computerRu,
    automation: automationRu,
    git: gitRu,
  },
} as const;
