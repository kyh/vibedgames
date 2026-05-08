import { openAsBlob } from "node:fs";

import type { createClient } from "./api.js";
import type { FilePathRef } from "./media-args.js";

type Client = ReturnType<typeof createClient>;

/**
 * Upload local files directly to fal's CDN. The proxy hands us a
 * presigned upload slot (uploadUrl + fileUrl) per file; bytes go
 * straight from the client to fal, never through the worker. The
 * resulting fileUrls are stable fal CDN URLs that can be reused
 * across runs without re-uploading.
 */
export async function uploadFiles(
  client: Client,
  files: FilePathRef[],
): Promise<{ urls: string[] }> {
  if (files.length === 0) return { urls: [] };

  const urls = await Promise.all(
    files.map(async (file) => {
      const slot = await client.media.upload.mutate({
        filename: file.filename,
        contentType: file.contentType,
        sizeBytes: file.sizeBytes,
      });
      const body = await openAsBlob(file.path, { type: slot.contentType });
      const res = await fetch(slot.uploadUrl, {
        method: "PUT",
        headers: { "Content-Type": slot.contentType },
        body,
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(
          `Upload failed for ${file.filename}: ${res.status} ${res.statusText} ${text}`,
        );
      }
      return slot.fileUrl;
    }),
  );

  return { urls };
}
