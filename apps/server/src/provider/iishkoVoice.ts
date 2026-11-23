// FILE: iishkoVoice.ts
// Purpose: Transcribes voice clips through the IISHKO IDE proxy STT endpoint.
// Layer: Provider runtime support

import type {
  ServerVoiceTranscriptionInput,
  ServerVoiceTranscriptionResult,
} from "@iishko/contracts";
import {
  decodeOutboundJson,
  encodeOutboundMultipart,
  outboundHttp,
  type OutboundHttpResponse,
} from "@iishko/shared/outboundHttp";

import {
  getIishkoSessionBaseUrl,
  getIishkoSessionToken,
  readIishkoDeviceToken,
  refreshIishkoSessionOnce,
} from "../iishkoSession.ts";
import {
  IISHKO_CLIENT_HEADER,
  IISHKO_IDE_HEADER,
  iishkoClientHeaderValue,
} from "./iishkoProvider.ts";

const STT_TIMEOUT_MS = 60_000;
const STT_MAX_REQUEST_BYTES = 16 * 1024 * 1024;

interface IishkoSttOptions {
  readonly signal?: AbortSignal | undefined;
  readonly request?: typeof outboundHttp.request | undefined;
}

function sttErrorMessage(response: OutboundHttpResponse): string | undefined {
  try {
    const payload = decodeOutboundJson(response, { maxDepth: 8, maxNodes: 200 }) as {
      error?: { message?: unknown } | string;
      message?: unknown;
    } | null;
    const nested = payload?.error;
    if (nested && typeof nested === "object") {
      const message = nested.message;
      if (typeof message === "string" && message.trim()) return message.trim();
    }
    if (typeof payload?.message === "string" && payload.message.trim()) {
      return payload.message.trim();
    }
  } catch {
    // fall through to the status-based message
  }
  return undefined;
}

async function postTranscription(
  sessionToken: string,
  baseUrl: string,
  audio: Uint8Array,
  mimeType: string,
  options: IishkoSttOptions,
): Promise<OutboundHttpResponse> {
  const request = options.request ?? outboundHttp.request.bind(outboundHttp);
  const { body, contentType } = encodeOutboundMultipart(
    [
      {
        name: "file",
        filename: mimeType.includes("wav") ? "voice.wav" : "voice.audio",
        contentType: mimeType,
        body: audio,
      },
    ],
    { maxBytes: STT_MAX_REQUEST_BYTES },
  );
  return request({
    url: `${baseUrl}/audio/transcriptions`,
    method: "POST",
    headers: {
      accept: "application/json",
      authorization: `Bearer ${sessionToken}`,
      "content-type": contentType,
      [IISHKO_CLIENT_HEADER]: iishkoClientHeaderValue(),
      [IISHKO_IDE_HEADER]: "true",
    },
    body,
    ...(options.signal ? { signal: options.signal } : {}),
    policy: {
      service: "iishko-stt",
      allowedOrigins: [new URL(baseUrl).origin],
      timeoutMs: STT_TIMEOUT_MS,
      maxRequestBytes: STT_MAX_REQUEST_BYTES + 64 * 1024,
      maxResponseBytes: 64 * 1024,
      maxRedirects: 0,
      maxConcurrent: 2,
      maxQueued: 4,
      requirePublicAddress: !["127.0.0.1", "localhost"].includes(new URL(baseUrl).hostname),
      allowLoopbackHttp: new URL(baseUrl).protocol === "http:",
      allowBenchmarkAddressRange: true,
    },
  });
}

/**
 * Transcribes one captured clip through the IDE proxy. Requires the device
 * session (ids_ token); a revoked or missing session fails with a readable error.
 */
export async function transcribeIishkoVoice(
  input: ServerVoiceTranscriptionInput,
  options: IishkoSttOptions = {},
): Promise<ServerVoiceTranscriptionResult> {
  const deviceToken = (await readIishkoDeviceToken())?.trim();
  if (!deviceToken) {
    throw new Error("Подключите аккаунт ИИШКО для голосового ввода.");
  }
  const audio = Buffer.from(input.audioBase64, "base64");
  if (audio.byteLength === 0) {
    throw new Error("No audio was captured.");
  }
  const baseUrl = getIishkoSessionBaseUrl(deviceToken);
  let sessionToken = await getIishkoSessionToken(deviceToken);
  let response = await postTranscription(sessionToken, baseUrl, audio, input.mimeType, options);

  // ide_session_invalid: refresh the session once and retry, like proxy calls.
  if (response.status === 401) {
    const code = (() => {
      try {
        const payload = decodeOutboundJson(response, { maxDepth: 8, maxNodes: 200 }) as {
          error?: { code?: unknown };
        } | null;
        return typeof payload?.error?.code === "string" ? payload.error.code : "";
      } catch {
        return "";
      }
    })();
    if (code === "ide_session_invalid") {
      await refreshIishkoSessionOnce();
      sessionToken = await getIishkoSessionToken(deviceToken, { forceRefresh: true });
      response = await postTranscription(sessionToken, baseUrl, audio, input.mimeType, options);
    }
  }

  if (response.status < 200 || response.status >= 300) {
    throw new Error(
      sttErrorMessage(response) ?? `Голосовой ввод временно недоступен (HTTP ${response.status}).`,
    );
  }

  const payload = decodeOutboundJson(response, { maxDepth: 8, maxNodes: 200 }) as {
    text?: unknown;
  } | null;
  const text = typeof payload?.text === "string" ? payload.text : "";
  return { text };
}
