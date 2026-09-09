import { readFileSync } from "node:fs";

import type { ManifestFile } from "./manifest.js";

export interface UploadTarget {
  path: string;
  url: string;
  headers: Record<string, string>;
}

/**
 * Upload all files to their presigned PUT URLs with bounded concurrency.
 * Throws on the first non-2xx response.
 */
export const uploadAll = async ({
  files,
  uploads,
  concurrency = 6,
  onProgress,
}: {
  files: ManifestFile[];
  uploads: UploadTarget[];
  concurrency?: number;
  onProgress?: (done: number, total: number) => void;
}): Promise<void> => {
  const byPath = new Map(files.map((f) => [f.path, f]));
  let done = 0;
  let cursor = 0;

  const worker = async (): Promise<void> => {
    while (true) {
      const idx = cursor;
      cursor += 1;
      if (idx >= uploads.length) {
        return;
      }
      const upload = uploads[idx];
      if (!upload) {
        return;
      }
      const file = byPath.get(upload.path);
      if (!file) {
        throw new Error(`Missing file for upload target: ${upload.path}`);
      }
      const body = readFileSync(file.absolutePath);
      const res = await fetch(upload.url, {
        body,
        headers: upload.headers,
        method: "PUT",
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(
          `Upload failed for ${upload.path}: ${res.status} ${res.statusText} ${text}`,
        );
      }
      done += 1;
      onProgress?.(done, uploads.length);
    }
  };

  const workers = Array.from({ length: Math.min(concurrency, uploads.length) }, () => worker());
  await Promise.all(workers);
};
