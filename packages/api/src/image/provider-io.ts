import { TRPCError } from "@trpc/server";

import { base64ToBytes } from "./base64";
import { MAX_OUTPUT_IMAGE_BYTES, MAX_PROVIDER_JSON_BYTES } from "./limits";

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

export async function readBytesBounded(
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

export async function readTextBounded(
  response: Response,
  label: string,
  maxBytes = MAX_PROVIDER_JSON_BYTES,
): Promise<string> {
  const bytes = await readBytesBounded(response, maxBytes, label);
  return new TextDecoder().decode(bytes);
}

export async function readJsonBounded(
  response: Response,
  label: string,
  maxBytes = MAX_PROVIDER_JSON_BYTES,
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

export async function readErrorSnippet(response: Response, label: string): Promise<string> {
  try {
    return (await readTextBounded(response, label, 8 * 1024)).slice(0, 800);
  } catch {
    return "";
  }
}

function decodedBase64Length(encoded: string): number {
  const trimmed = encoded.trim();
  const padding = trimmed.endsWith("==") ? 2 : trimmed.endsWith("=") ? 1 : 0;
  return Math.floor((trimmed.length * 3) / 4) - padding;
}

export function decodeBase64Output(encoded: string, label: string): Uint8Array {
  if (decodedBase64Length(encoded) > MAX_OUTPUT_IMAGE_BYTES) {
    rejectOversize(label, MAX_OUTPUT_IMAGE_BYTES);
  }
  let bytes: Uint8Array;
  try {
    bytes = base64ToBytes(encoded);
  } catch {
    throw new TRPCError({
      code: "BAD_GATEWAY",
      message: `${label} was not valid base64.`,
    });
  }
  if (bytes.byteLength > MAX_OUTPUT_IMAGE_BYTES) {
    rejectOversize(label, MAX_OUTPUT_IMAGE_BYTES);
  }
  return bytes;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
