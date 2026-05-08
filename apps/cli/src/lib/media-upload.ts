import { openAsBlob } from "node:fs";

import type { createClient } from "./api.js";
import type { FilePathRef } from "./media-args.js";
import { isRecord } from "./types.js";

type Client = ReturnType<typeof createClient>;

/**
 * Upload local files directly to fal's CDN. The proxy hands us a
 * presigned upload slot (upload_url + file_url) per file via the
 * `media.forward` storage target; bytes go straight from the client
 * to fal, never through the worker. The resulting file_urls are
 * stable fal CDN URLs that can be reused across runs without
 * re-uploading.
 */
export async function uploadFiles(
  client: Client,
  files: FilePathRef[],
): Promise<{ urls: string[] }> {
  if (files.length === 0) return { urls: [] };

  const urls = await Promise.all(
    files.map(async (file) => {
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
    }),
  );

  return { urls };
}

function pickUrl(slot: unknown, key: "upload_url" | "file_url"): string {
  if (!isRecord(slot) || typeof slot[key] !== "string" || slot[key]!.length === 0) {
    throw new Error(`fal storage initiate response missing ${key}.`);
  }
  return slot[key] as string;
}
