import { useMemo } from "react";
import { createInstance, type i18n as I18n } from "i18next";
import { initReactI18next, useTranslation as useReactTranslation } from "react-i18next";

import { uiLocalizationResources } from "@iishko/shared/uiLocalizationResources";
import {
  DEFAULT_UI_LOCALE,
  FALLBACK_UI_LOCALE,
  UI_LOCALES,
  isUiLocale,
  isUiMessageKey,
  type UiLocale,
} from "@iishko/shared/uiLocale";

const UI_LOCALE_STORAGE_KEY = "iishko:ui-locale";

/** The chosen interface language; Russian by default. Unit tests read the English reference. */
function readInitialUiLocale(): UiLocale {
  if (import.meta.env.MODE === "test") return FALLBACK_UI_LOCALE;
  try {
    const stored = globalThis.localStorage?.getItem(UI_LOCALE_STORAGE_KEY);
    return isUiLocale(stored) ? stored : DEFAULT_UI_LOCALE;
  } catch {
    return DEFAULT_UI_LOCALE;
  }
}

const initialUiLocale = readInitialUiLocale();
if (typeof document !== "undefined") document.documentElement.lang = initialUiLocale;

// Messages read the selected catalog and fall back to the English reference.
export const i18n: I18n = createInstance();
void i18n.use(initReactI18next).init({
  lng: initialUiLocale,
  fallbackLng: FALLBACK_UI_LOCALE,
  supportedLngs: [...UI_LOCALES],
  resources: uiLocalizationResources,
  ns: Object.keys(uiLocalizationResources.en),
  defaultNS: "common",
  initAsync: false,
  keySeparator: false,
  nsSeparator: ":",
  interpolation: { escapeValue: false },
  react: { useSuspense: false, transSupportBasicHtmlNodes: false },
});

/** Switches the interface language live and remembers it for the next launch. */
export function setUiLocale(locale: UiLocale): void {
  try {
    globalThis.localStorage?.setItem(UI_LOCALE_STORAGE_KEY, locale);
  } catch {
    // Storage can be unavailable; the switch still applies to this session.
  }
  if (typeof document !== "undefined") document.documentElement.lang = locale;
  void i18n.changeLanguage(locale);
}

export function t(message: string, values?: Record<string, unknown>): string {
  if (!isUiMessageKey(message, uiLocalizationResources.en)) return message;
  return i18n.t(message, { ...values, returnObjects: false });
}

// A factory call ties identity to the subscription value without closing over its old
// state. An unused useCallback dependency is removed by React Compiler.
function createTranslationSnapshot(_subscription: unknown): { t: typeof t; formatLocale: string } {
  return {
    t: (message, values) => t(message, values),
    formatLocale: getFormatLocale(),
  };
}

export function useTranslation(): { t: typeof t; locale: string; formatLocale: string } {
  const { t: reactiveTranslator, i18n: instance } = useReactTranslation(undefined, { i18n });
  const snapshot = useMemo(
    () => createTranslationSnapshot(reactiveTranslator),
    [reactiveTranslator],
  );
  return { ...snapshot, locale: instance.language };
}

// Resolved once, like the formatters that used an unspecified `Intl` locale before.
const SYSTEM_FORMAT_LOCALE = new Intl.DateTimeFormat().resolvedOptions().locale;

/** Dates and numbers follow the system locale, as an unspecified `Intl` locale does. */
export function getFormatLocale(): string {
  return SYSTEM_FORMAT_LOCALE;
}
