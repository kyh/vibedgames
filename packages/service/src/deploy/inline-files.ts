import type { InlineFile } from "@repo/contract/deploy/deploy-schema";
import { contentTypeForPath } from "@repo/contract/deploy/content-types";
import { MAX_FILE_SIZE } from "@repo/contract/deploy/deploy-schema";
import { isMediaUrl } from "@repo/contract/generate/media-hosts";
import { ORPCError } from "@orpc/server";

import { readBytesBounded } from "../generate/provider-io";

/** A `deploy.upload` file decoded to the bytes R2 stores. */
export interface DecodedFile {
  bytes: Uint8Array<ArrayBuffer>;
  contentType: string;
  path: string;
}

// What one call may fetch by URL: the Worker holds it all before writing.
export const MAX_FETCHED_BYTES = 32 * 1024 * 1024;

/** A generated asset, fetched only from the media provider's own hosts. */
const fetchMediaFile = async (path: string, url: string, budget: number) => {
  if (!isMediaUrl(url)) {
    throw new ORPCError("BAD_REQUEST", {
      message: `"${path}": only a URL generate returned can be fetched; send other files as content.`,
    });
  }
  let response: Response;
  try {
    response = await fetch(url);
  } catch (error) {
    throw new ORPCError("BAD_GATEWAY", {
      cause: error,
      message: `"${path}": ${url} could not be reached.`,
    });
  }
  // A redirect may only land on another of the same hosts.
  if (!isMediaUrl(response.url || url)) {
    throw new ORPCError("BAD_REQUEST", {
      message: `"${path}": ${url} redirected off the media hosts.`,
    });
  }
  if (!response.ok) {
    throw new ORPCError("BAD_GATEWAY", {
      message: `"${path}": fetching ${url} failed (${response.status}).`,
    });
  }
  const limit = Math.min(MAX_FILE_SIZE, budget);
  try {
    return new Uint8Array(await readBytesBounded(response, limit, `"${path}"`));
  } catch (error) {
    throw new ORPCError("BAD_REQUEST", {
      cause: error,
      message: `"${path}" is over the ${limit} bytes left to fetch: a file may be ${MAX_FILE_SIZE} bytes and one call may fetch ${MAX_FETCHED_BYTES}, so split URL files across calls.`,
    });
  }
};

/**
 * Decodes one call's files, refusing a path given twice: within a call there
 * is no telling which copy was meant. Across calls a path is replaced. URL
 * files are fetched one after another, within MAX_FETCHED_BYTES for the call.
 */
export const decodeInlineFiles = async (files: InlineFile[]): Promise<DecodedFile[]> => {
  const seen = new Set<string>();
  const decoded: DecodedFile[] = [];
  let budget = MAX_FETCHED_BYTES;
  for (const file of files) {
    if (seen.has(file.path)) {
      throw new ORPCError("BAD_REQUEST", { message: `Duplicate path "${file.path}" in upload.` });
    }
    seen.add(file.path);
    let bytes: Uint8Array<ArrayBuffer>;
    if (file.encoding === "url") {
      bytes = await fetchMediaFile(file.path, file.content, budget);
      budget -= bytes.byteLength;
    } else {
      bytes = new Uint8Array(new TextEncoder().encode(file.content));
    }
    decoded.push({
      bytes,
      contentType: file.contentType ?? contentTypeForPath(file.path),
      path: file.path,
    });
  }
  return decoded;
};

export const sha256Hex = async (bytes: Uint8Array<ArrayBuffer>): Promise<string> => {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
};
