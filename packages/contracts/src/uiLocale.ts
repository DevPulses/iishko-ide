/** Russian is the default interface language; English is the reference catalog and fallback. */
export const UI_LOCALES = ["ru", "en"] as const;
export type UiLocale = (typeof UI_LOCALES)[number];
export const DEFAULT_UI_LOCALE: UiLocale = "ru";
export const FALLBACK_UI_LOCALE: UiLocale = "en";

export function isUiLocale(value: unknown): value is UiLocale {
  return typeof value === "string" && (UI_LOCALES as readonly string[]).includes(value);
}
