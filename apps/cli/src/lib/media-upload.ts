import { openAsBlob } from "node:fs";

import type { createClient } from "./api.js";
import type { LocalFile } from "./media-args.js";

type Client = ReturnType<typeof createClient>;

/**
 * Upload one local file directly to fal's CDN. `generate.uploadSlot` hands
 * us a presigned slot; bytes go straight from the client to fal, never
 * through the worker. The returned fileUrl is a stable CDN URL that can be
 * reused across runs without re-uploading.
 */
export const uploadFile = async (client: Client, file: LocalFile): Promise<string> => {
  const { uploadUrl, fileUrl } = await client.generate.uploadSlot({
    contentType: file.contentType,
    fileName: file.filename,
  });

  const body = await openAsBlob(file.path, { type: file.contentType });
  const res = await fetch(uploadUrl, {
    body,
    headers: { "Content-Type": file.contentType },
    method: "PUT",
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Upload failed for ${file.filename}: ${res.status} ${res.statusText} ${text}`);
  }
  return fileUrl;
};
