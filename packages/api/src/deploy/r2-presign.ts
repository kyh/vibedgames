import { AwsClient } from "aws4fetch";

import type { R2Config } from "../trpc";

/**
 * Mint a 15-minute S3 presigned PUT URL for a single R2 object. The returned
 * URL can be used directly by the CLI — no auth header required, the
 * signature is baked into the query string.
 */
export async function presignPut({
  r2,
  key,
  contentType,
  expiresInSeconds = 900,
}: {
  r2: R2Config;
  key: string;
  contentType: string;
  expiresInSeconds?: number;
}): Promise<string> {
  const client = new AwsClient({
    accessKeyId: r2.accessKeyId,
    secretAccessKey: r2.secretAccessKey,
    service: "s3",
    region: "auto",
  });

  const endpoint = new URL(
    `https://${r2.accountId}.r2.cloudflarestorage.com/${r2.bucketName}/${key}`,
  );
  endpoint.searchParams.set("X-Amz-Expires", String(expiresInSeconds));

  const signed = await client.sign(
    new Request(endpoint, {
      method: "PUT",
      headers: { "content-type": contentType },
    }),
    {
      aws: { signQuery: true },
    },
  );

  return signed.url;
}

/**
 * Delete every object under a given R2 prefix. Used to clear the previous
 * deployment when single-deploy mode overwrites an old release.
 */
export async function deletePrefix({
  r2,
  prefix,
}: {
  r2: R2Config;
  prefix: string;
}): Promise<void> {
  let cursor: string | undefined = undefined;
  while (true) {
    const listed = await r2.bucket.list({ prefix, cursor, limit: 1000 });
    if (listed.objects.length === 0) return;
    await Promise.all(listed.objects.map((o) => r2.bucket.delete(o.key)));
    if (!listed.truncated) return;
    cursor = listed.cursor;
  }
}
