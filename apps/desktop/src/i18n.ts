import { createInstance } from "i18next";
import { nativeLocalizationResources } from "@iishko/shared/nativeLocalizationResources";
import {
  DEFAULT_UI_LOCALE,
  FALLBACK_UI_LOCALE,
  UI_LOCALES,
  isUiLocale,
  isUiMessageKey,
} from "@iishko/shared/uiLocale";

// Native copy is Russian by default (IISHKO_UI_LOCALE overrides it); tests read English.
const requestedLocale = process.env.IISHKO_UI_LOCALE?.trim();
const instance = createInstance();
void instance.init({
  lng: process.env.VITEST
    ? FALLBACK_UI_LOCALE
    : isUiLocale(requestedLocale)
      ? requestedLocale
      : DEFAULT_UI_LOCALE,
  fallbackLng: FALLBACK_UI_LOCALE,
  supportedLngs: [...UI_LOCALES],
  resources: nativeLocalizationResources,
  ns: ["desktop"],
  defaultNS: "desktop",
  initAsync: false,
  keySeparator: false,
  nsSeparator: ":",
  interpolation: { escapeValue: false },
});

export function t(message: string, values?: Record<string, unknown>): string {
  if (!isUiMessageKey(message, nativeLocalizationResources.en)) return message;
  return instance.t(message, { ...values, returnObjects: false });
}
