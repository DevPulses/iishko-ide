// FILE: iishkoVoice.test.ts
// Purpose: Verifies IISHKO proxy STT behavior against a stubbed HTTP layer.
// Layer: Server test
// Exports: Vitest cases
// Depends on: iishkoVoice utility and mocked session/http responses.

import type { ServerVoiceTranscriptionInput } from "@iishko/contracts";
import type { OutboundHttpRequest, OutboundHttpResponse } from "@iishko/shared/outboundHttp";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  getIishkoSessionBaseUrl,
  getIishkoSessionToken,
  readIishkoDeviceToken,
  refreshIishkoSessionOnce,
} from "../iishkoSession.ts";
import { transcribeIishkoVoice } from "./iishkoVoice.ts";

vi.mock("../iishkoSession.ts", () => ({
  readIishkoDeviceToken: vi.fn(),
  getIishkoSessionToken: vi.fn(),
  getIishkoSessionBaseUrl: vi.fn(),
  refreshIishkoSessionOnce: vi.fn(),
}));

const WAV_BASE64 = Buffer.from("RIFF0000WAVEfmt ", "ascii").toString("base64");

const baseInput: ServerVoiceTranscriptionInput = {
  provider: "pi",
  cwd: "/tmp/project",
  mimeType: "audio/wav",
  sampleRateHz: 24_000,
  durationMs: 1_000,
  audioBase64: WAV_BASE64,
};

function jsonResponse(body: unknown, status = 200): OutboundHttpResponse {
  return {
    status,
    headers: new Headers({ "content-type": "application/json" }),
    body: new TextEncoder().encode(JSON.stringify(body)),
    url: "https://api.reformboss.com/webapp/api/ide/v1/audio/transcriptions",
  };
}

function proxyError(code: string, message: string, status: number): OutboundHttpResponse {
  return jsonResponse({ error: { code, message } }, status);
}

describe("transcribeIishkoVoice", () => {
  beforeEach(() => {
    vi.mocked(readIishkoDeviceToken).mockResolvedValue("idd_test");
    vi.mocked(getIishkoSessionToken).mockResolvedValue("ids_session");
    vi.mocked(getIishkoSessionBaseUrl).mockReturnValue(
      "https://api.reformboss.com/webapp/api/ide/v1",
    );
    vi.mocked(refreshIishkoSessionOnce).mockResolvedValue(undefined);
  });

  it("posts multipart audio and returns the transcript", async () => {
    const request = vi.fn(async (_input: OutboundHttpRequest) =>
      jsonResponse({ text: "Привет", language: "ru", duration: 1.2 }),
    );
    const result = await transcribeIishkoVoice(baseInput, { request });
    expect(result).toEqual({ text: "Привет" });
    expect(request).toHaveBeenCalledTimes(1);
    const sent = request.mock.calls[0]![0];
    expect(sent.url).toBe("https://api.reformboss.com/webapp/api/ide/v1/audio/transcriptions");
    expect(sent.method).toBe("POST");
    const sentHeaders = new Headers(sent.headers);
    expect(sentHeaders.get("authorization")).toBe("Bearer ids_session");
    expect(sentHeaders.get("content-type")).toContain("multipart/form-data");
  });

  it("returns empty text when the clip has no speech", async () => {
    const request = vi.fn(async () => jsonResponse({ text: "", language: "ru", duration: 0.4 }));
    const result = await transcribeIishkoVoice(baseInput, { request });
    expect(result).toEqual({ text: "" });
  });

  it("refreshes the session once on ide_session_invalid and retries", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce(proxyError("ide_session_invalid", "Session expired", 401))
      .mockResolvedValueOnce(jsonResponse({ text: "ок", language: "ru", duration: 0.5 }));
    vi.mocked(getIishkoSessionToken)
      .mockResolvedValueOnce("ids_stale")
      .mockResolvedValueOnce("ids_fresh");
    const result = await transcribeIishkoVoice(baseInput, { request });
    expect(result).toEqual({ text: "ок" });
    expect(refreshIishkoSessionOnce).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledTimes(2);
    expect(new Headers(request.mock.calls[1]![0].headers).get("authorization")).toBe(
      "Bearer ids_fresh",
    );
  });

  it("surfaces the server message for a persistent 401", async () => {
    const request = vi.fn(async () =>
      proxyError("ide_session_invalid", "Сессия недействительна", 401),
    );
    await expect(transcribeIishkoVoice(baseInput, { request })).rejects.toThrow(
      "Сессия недействительна",
    );
    expect(request).toHaveBeenCalledTimes(2);
  });

  it.each([
    [403, "ide_account_blocked", "Аккаунт заблокирован"],
    [403, "ide_no_key", "Нет API-ключа"],
    [413, "stt_too_large", "Файл слишком большой"],
    [415, "stt_bad_format", "Неподдерживаемый формат"],
    [429, "rate_limited", "Слишком много запросов"],
    [503, "stt_unavailable", "Распознавание недоступно"],
  ])("surfaces the server message for %i %s", async (status, code, message) => {
    const request = vi.fn(async () => proxyError(code, message, status));
    await expect(transcribeIishkoVoice(baseInput, { request })).rejects.toThrow(message);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("falls back to a readable message for non-JSON errors", async () => {
    const request = vi.fn(
      async (): Promise<OutboundHttpResponse> => ({
        status: 502,
        headers: new Headers(),
        body: new TextEncoder().encode("bad gateway"),
        url: "https://api.reformboss.com/webapp/api/ide/v1/audio/transcriptions",
      }),
    );
    await expect(transcribeIishkoVoice(baseInput, { request })).rejects.toThrow(
      "Голосовой ввод временно недоступен (HTTP 502).",
    );
  });

  it("requires a connected device session", async () => {
    vi.mocked(readIishkoDeviceToken).mockResolvedValue(undefined);
    const request = vi.fn();
    await expect(transcribeIishkoVoice(baseInput, { request })).rejects.toThrow(
      "Подключите аккаунт ИИШКО",
    );
    expect(request).not.toHaveBeenCalled();
  });
});
