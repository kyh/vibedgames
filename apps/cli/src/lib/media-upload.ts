import { openAsBlob } from "node:fs";

import type { createClient } from "./api.js";
import type { LocalFile } from "./media-args.js";
import { isRecord } from "./types.js";

type Client = ReturnType<typeof createClient>;

/**
 * Upload one local file directly to fal's CDN. The proxy hands us a
 * presigned upload slot (upload_url + file_url) via the `media.forward`
 * storage target; bytes go straight from the client to fal, never
 * through the worker. The returned file_url is a stable fal CDN URL
 * that can be reused across runs without re-uploading.
 */
export async function uploadFile(client: Client, file: LocalFile): Promise<string> {
  const slot = await client.media.forward.mutate({
    target: "storage",
    method: "POST",
    path: "/storage/upload/initiate",
    body: { content_type: file.contentType, file_name: file.filename },
  });
  const uploadUrl = pickUrl(slot, "upload_url");
  const fileUrl = pickUrl(slot, "file_url");

  const body = await openAsBlob(file.path, { type: file.contentType });
  const res = await fetch(uploadUrl, {
    method: "PUT",
    headers: { "Content-Type": file.contentType },
    body,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `Upload failed for ${file.filename}: ${res.status} ${res.statusText} ${text}`,
    );
  }
  return fileUrl;
}

function pickUrl(slot: unknown, key: "upload_url" | "file_url"): string {
  if (!isRecord(slot) || typeof slot[key] !== "string" || slot[key]!.length === 0) {
    throw new Error(`fal storage initiate response missing ${key}.`);
  }
  const value = slot[key] as string;
  // Refuse any non-HTTPS URL even if it comes from a trusted server
  // response — a misconfigured response (or a downgrade attack on the
  // proxy hop) must not silently send user bytes over plain HTTP, and
  // file_url gets passed into later runs where it should stay HTTPS.
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`fal storage initiate response ${key} is not a valid URL.`);
  }
  if (parsed.protocol !== "https:") {
    throw new Error(`fal storage initiate response ${key} must be HTTPS, got ${parsed.protocol}.`);
  }
  return value;
}
