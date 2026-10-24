import { openAsBlob } from "node:fs";

import type { createClient } from "./api.js";
import type { LocalFile } from "./media-args.js";

type Client = ReturnType<typeof createClient>;

/**
 * Upload one local file as a model input. `generate.upload` opens a storage
 * slot and answers with a signed URL on the API's own host, which streams the
 * bytes on to it, so this only ever talks to the API. The returned file URL is
 * stable and can be reused across runs without re-uploading.
 */
export const uploadFile = async (client: Client, file: LocalFile): Promise<string> => {
  const slot = await client.generate.upload({
    contentType: file.contentType,
    fileName: file.filename,
  });
  const body = await openAsBlob(file.path, { type: file.contentType });
  const res = await fetch(slot.uploadUrl, { body, headers: slot.headers, method: "PUT" });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Upload failed for ${file.filename}: ${res.status} ${res.statusText} ${text}`);
  }
  return slot.fileUrl;
};
