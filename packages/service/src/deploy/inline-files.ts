import type { InlineFile } from "@repo/contract/deploy/deploy-schema";
import { contentTypeForPath } from "@repo/contract/deploy/content-types";
import { ORPCError } from "@orpc/server";

/** A `deploy.upload` file decoded to the bytes R2 stores. */
export interface DecodedFile {
  bytes: Uint8Array<ArrayBuffer>;
  contentType: string;
  path: string;
}

// `atob` accepts whitespace and missing padding; anything else in the
// alphabet check below is not base64 at all.
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/u;

const decodeBase64 = (path: string, content: string): Uint8Array<ArrayBuffer> => {
  const compact = content.replaceAll(/\s+/gu, "");
  if (!BASE64.test(compact)) {
    throw new ORPCError("BAD_REQUEST", { message: `"${path}" is not valid base64.` });
  }
  const binary = atob(compact);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.codePointAt(i) ?? 0;
  }
  return bytes;
};

/**
 * Decodes one call's files, refusing a path given twice: within a call there
 * is no telling which copy was meant. Across calls a path is replaced.
 */
export const decodeInlineFiles = (files: InlineFile[]): DecodedFile[] => {
  const seen = new Set<string>();
  return files.map((file) => {
    if (seen.has(file.path)) {
      throw new ORPCError("BAD_REQUEST", { message: `Duplicate path "${file.path}" in upload.` });
    }
    seen.add(file.path);
    return {
      bytes:
        file.encoding === "base64"
          ? decodeBase64(file.path, file.content)
          : new Uint8Array(new TextEncoder().encode(file.content)),
      contentType: file.contentType ?? contentTypeForPath(file.path),
      path: file.path,
    };
  });
};

export const sha256Hex = async (bytes: Uint8Array<ArrayBuffer>): Promise<string> => {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
};
