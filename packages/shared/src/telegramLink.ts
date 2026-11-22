// FILE: telegramLink.ts
// Purpose: Chooses how a t.me deep link is opened: the Telegram app when installed, else the browser.
// Layer: Shared helper (desktop main and tests)

const TELEGRAM_HOSTS = new Set(["t.me", "telegram.me"]);
const BOT_NAME = /^[A-Za-z][A-Za-z0-9_]{3,31}$/u;
const START_PAYLOAD = /^[A-Za-z0-9_-]{1,128}$/u;

/** `https://t.me/<bot>?start=<token>` becomes `tg://resolve?domain=<bot>&start=<token>`; anything else is null. */
export function buildTelegramAppUrl(httpsUrl: string): string | null {
  let url: URL;
  try {
    url = new URL(httpsUrl);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || !TELEGRAM_HOSTS.has(url.hostname)) return null;
  const bot = url.pathname.replace(/^\/+|\/+$/gu, "");
  const start = url.searchParams.get("start");
  if (!BOT_NAME.test(bot) || url.username || url.password) return null;
  if (start !== null && !START_PAYLOAD.test(start)) return null;
  const query = new URLSearchParams({ domain: bot });
  if (start !== null) query.set("start", start);
  return `tg://resolve?${query.toString()}`;
}

/** The Telegram app link when a `tg` handler exists, otherwise the original https link. */
export function chooseTelegramLaunchUrl(httpsUrl: string, hasTgHandler: boolean): string {
  if (!hasTgHandler) return httpsUrl;
  return buildTelegramAppUrl(httpsUrl) ?? httpsUrl;
}
