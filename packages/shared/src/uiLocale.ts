import {
  DEFAULT_UI_LOCALE,
  FALLBACK_UI_LOCALE,
  UI_LOCALES,
  isUiLocale,
  type UiLocale,
} from "@iishko/contracts/uiLocale";

export { DEFAULT_UI_LOCALE, FALLBACK_UI_LOCALE, UI_LOCALES, isUiLocale };
export type { UiLocale };

/** Only catalog identities may reach a namespace-aware translator; other strings are data. */
export function isUiMessageKey(
  message: string,
  namespaces: Readonly<Record<string, unknown>>,
): boolean {
  const match = /^([a-z][A-Za-z0-9_-]*):[A-Za-z0-9_][A-Za-z0-9_.-]*$/.exec(message);
  return match !== null && Object.hasOwn(namespaces, match[1]!);
}
