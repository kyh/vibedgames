import { openAsBlob } from "node:fs";

import type { RouterOutputs } from "@repo/api";

import { createClient } from "./api.js";
import type { FilePathRef } from "./media-args.js";

type CreateInputUploadsResult = RouterOutputs["media"]["createInputUploads"];
type InputUploadRef = CreateInputUploadsResult["uploads"][number]["ref"];

/**
 * Upload a batch of local files to R2 via presigned PUTs. Returns the
 * presigned GET URLs (passable to fal as image_url/video_url/etc) and the
 * R2 keys for cleanup.
 */
export async function uploadFiles(
  files: FilePathRef[],
): Promise<{ urls: string[]; refs: InputUploadRef[] }> {
  if (files.length === 0) return { urls: [], refs: [] };
  const client = createClient();
  const created = await client.media.createInputUploads.mutate({
    files: files.map((file) => ({
      filename: file.filename,
      contentType: file.contentType,
      sizeBytes: file.sizeBytes,
    })),
  });

  const urls: string[] = Array.from({ length: created.uploads.length });
  const refs: InputUploadRef[] = created.uploads.map((u) => u.ref);

  try {
    await Promise.all(
      created.uploads.map(async (upload, index) => {
        const file = files[index];
        if (!file) throw new Error(`Missing local file at index ${index}.`);
        const body = await openAsBlob(file.path, { type: file.contentType });
        const res = await fetch(upload.putUrl, {
          method: "PUT",
          headers: upload.headers,
          body,
        });
        if (!res.ok) {
          const text = await res.text().catch(() => "");
          throw new Error(
            `Upload failed for ${file.filename}: ${res.status} ${res.statusText} ${text}`,
          );
        }
        urls[index] = upload.getUrl;
      }),
    );
  } catch (err) {
    await cleanupUploads(refs).catch(() => undefined);
    throw err;
  }

  return { urls, refs };
}

export async function cleanupUploads(refs: InputUploadRef[]): Promise<void> {
  if (refs.length === 0) return;
  const client = createClient();
  await client.media.cleanupInputUploads.mutate({ keys: refs.map((r) => r.key) });
}
