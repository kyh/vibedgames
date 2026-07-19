import { TRPCError } from "@trpc/server";

import { MAX_FAL_PLATFORM_JSON_BYTES } from "./limits";

function parseContentLength(response: Response): number | null {
  const raw = response.headers.get("content-length");
  if (raw === null || raw.trim().length === 0) return null;
  const length = Number(raw);
  return Number.isFinite(length) && length >= 0 ? length : null;
}

function rejectOversize(label: string, maxBytes: number): never {
  throw new TRPCError({
    code: "BAD_GATEWAY",
    message: `${label} exceeded ${maxBytes} bytes.`,
  });
}

async function readBytesBounded(
  response: Response,
  maxBytes: number,
  label: string,
): Promise<Uint8Array> {
  const declared = parseContentLength(response);
  if (declared !== null && declared > maxBytes) {
    rejectOversize(label, maxBytes);
  }

  if (!response.body) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > maxBytes) rejectOversize(label, maxBytes);
    return bytes;
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  while (true) {
    const next = await reader.read();
    if (next.done) break;
    total += next.value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      rejectOversize(label, maxBytes);
    }
    chunks.push(next.value);
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

async function readTextBounded(
  response: Response,
  label: string,
  maxBytes = MAX_FAL_PLATFORM_JSON_BYTES,
): Promise<string> {
  const bytes = await readBytesBounded(response, maxBytes, label);
  return new TextDecoder().decode(bytes);
}

export async function readJsonBounded(
  response: Response,
  label: string,
  maxBytes = MAX_FAL_PLATFORM_JSON_BYTES,
): Promise<unknown> {
  const text = await readTextBounded(response, label, maxBytes);
  try {
    return JSON.parse(text);
  } catch {
    throw new TRPCError({
      code: "BAD_GATEWAY",
      message: `${label} was not valid JSON.`,
    });
  }
}

// Pull the JSON-RPC message out of an MCP streamable-HTTP (SSE) response.
// The body is a sequence of `event:` / `data:` lines grouped into events by
// blank lines; a single tool call yields one event whose `data:` payload is
// the JSON-RPC reply. We return the last parseable data payload so a trailing
// result wins over any earlier progress notifications. Falls back to plain
// JSON.parse in case a deployment routes docs through a JSON gateway.
export async function readSseJson(
  response: Response,
  label: string,
  maxBytes = MAX_FAL_PLATFORM_JSON_BYTES,
): Promise<unknown> {
  const text = await readTextBounded(response, label, maxBytes);
  const events: string[] = [];
  let dataBuf: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (line === "") {
      if (dataBuf.length > 0) {
        events.push(dataBuf.join("\n"));
        dataBuf = [];
      }
      continue;
    }
    if (line.startsWith("data:")) dataBuf.push(line.slice(5).replace(/^ /, ""));
  }
  if (dataBuf.length > 0) events.push(dataBuf.join("\n"));

  if (events.length === 0) {
    try {
      return JSON.parse(text);
    } catch {
      throw new TRPCError({
        code: "BAD_GATEWAY",
        message: `${label} had no SSE data payload.`,
      });
    }
  }

  let last: unknown;
  let parsedAny = false;
  for (const event of events) {
    try {
      last = JSON.parse(event);
      parsedAny = true;
    } catch {
      // Skip non-JSON events (comments, keep-alives).
    }
  }
  if (!parsedAny) {
    throw new TRPCError({
      code: "BAD_GATEWAY",
      message: `${label} SSE data was not valid JSON.`,
    });
  }
  return last;
}

async function readErrorSnippet(response: Response, label: string): Promise<string> {
  try {
    return (await readTextBounded(response, label, 8 * 1024)).slice(0, 800);
  } catch {
    return "";
  }
}

export async function throwProviderError(response: Response, label: string): Promise<never> {
  const text = await readErrorSnippet(response, `${label} error response`);
  throw new TRPCError({
    code: "BAD_GATEWAY",
    message: `${label} failed (${response.status}): ${text}`,
  });
}

export async function fetchProviderResponse({
  url,
  init,
  label,
  credentialed,
  tolerateHttpError = false,
}: {
  url: string | URL;
  init?: RequestInit;
  label: string;
  credentialed: boolean;
  /**
   * Return non-2xx responses instead of throwing, for callers that must
   * inspect an error response (e.g. billing headers on a failed-job result
   * fetch) before surfacing the failure. Redirects are still refused.
   */
  tolerateHttpError?: boolean;
}): Promise<Response> {
  const response = await fetch(url, { ...init, redirect: "manual" });
  if (response.status >= 300 && response.status < 400) {
    throw new TRPCError({
      code: "BAD_GATEWAY",
      message: `${label} returned a ${response.status} redirect; refusing to follow${
        credentialed ? " with credentials" : ""
      }.`,
    });
  }
  if (!response.ok && !tolerateHttpError) {
    await throwProviderError(response, label);
  }
  return response;
}
