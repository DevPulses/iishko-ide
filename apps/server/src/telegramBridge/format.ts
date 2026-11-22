// FILE: format.ts
// Purpose: Turns assistant markdown into Telegram-safe chunks (HTML with <pre> code blocks).
// Layer: Server Telegram bridge

export const TELEGRAM_MESSAGE_LIMIT = 4096;
const SAFE_CHUNK = 3500;

export function escapeTelegramHtml(text: string): string {
  return text.replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;");
}

const FENCE = "```";

/** Splits raw text into chunks that stay under the limit once rendered, closing open fences. */
export function splitTelegramText(text: string, size = SAFE_CHUNK): string[] {
  if (text.length <= size) return [text];
  const chunks: string[] = [];
  let rest = text;
  let reopen = false;
  while (rest.length > 0) {
    const prefix: string = reopen ? `${FENCE}\n` : "";
    const budget = size - prefix.length - FENCE.length - 1;
    let cut = rest.length <= budget ? rest.length : rest.lastIndexOf("\n", budget);
    if (cut <= 0) cut = Math.min(rest.length, budget);
    let piece = rest.slice(0, cut);
    rest = rest.slice(cut).replace(/^\n/u, "");
    const open: boolean = ((prefix + piece).match(/```/gu) ?? []).length % 2 === 1;
    if (open && rest.length > 0) piece += `\n${FENCE}`;
    chunks.push(prefix + piece);
    reopen = open && rest.length > 0;
  }
  return chunks;
}

/** Renders fenced code as <pre> and inline code as <code>; everything else is escaped. */
export function renderTelegramHtml(text: string): string {
  const out: string[] = [];
  const lines = text.split("\n");
  let inFence = false;
  let buffer: string[] = [];
  for (const line of lines) {
    if (line.trimStart().startsWith(FENCE)) {
      if (inFence) {
        out.push(`<pre><code>${escapeTelegramHtml(buffer.join("\n"))}</code></pre>`);
        buffer = [];
      }
      inFence = !inFence;
      continue;
    }
    if (inFence) buffer.push(line);
    else {
      out.push(
        escapeTelegramHtml(line).replace(
          /`([^`\n]+)`/gu,
          (_match, code: string) => `<code>${code}</code>`,
        ),
      );
    }
  }
  if (inFence) out.push(`<pre><code>${escapeTelegramHtml(buffer.join("\n"))}</code></pre>`);
  return out.join("\n");
}
