import { AwsClient } from "aws4fetch";

import type { R2Config } from "../trpc";

/**
 * Mint a 15-minute S3 presigned PUT URL for a single R2 object. The returned
 * URL can be used directly by the CLI — no auth header required, the
 * signature is baked into the query string.
 *
 * When `r2.proxyUploadBaseUrl` is set, returns a worker-proxy URL instead so
 * uploads stream through the worker and land via the bucket binding (used in
 * local dev so the upload doesn't hit prod R2).
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
  if (r2.proxyUploadBaseUrl && r2.proxyUploadSecret) {
    return signProxyUploadUrl({
      baseUrl: r2.proxyUploadBaseUrl,
      key,
      contentType,
      secret: r2.proxyUploadSecret,
      expiresInSeconds,
    });
  }

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

async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(message),
  );
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Build the message that gets HMAC-signed for a proxy upload URL. */
function proxyUploadMessage(key: string, contentType: string, exp: number): string {
  return `PUT\n${key}\n${contentType}\n${exp}`;
}

async function signProxyUploadUrl({
  baseUrl,
  key,
  contentType,
  secret,
  expiresInSeconds,
}: {
  baseUrl: string;
  key: string;
  contentType: string;
  secret: string;
  expiresInSeconds: number;
}): Promise<string> {
  const exp = Math.floor(Date.now() / 1000) + expiresInSeconds;
  const sig = await hmacSha256Hex(secret, proxyUploadMessage(key, contentType, exp));
  const url = new URL("/api/r2-upload", baseUrl);
  url.searchParams.set("key", key);
  url.searchParams.set("ct", contentType);
  url.searchParams.set("exp", String(exp));
  url.searchParams.set("sig", sig);
  return url.toString();
}

/**
 * Validate a proxy upload URL's signature against the configured secret.
 * Returns null on valid signature, an error message string otherwise.
 */
export async function verifyProxyUploadUrl({
  key,
  contentType,
  exp,
  sig,
  secret,
}: {
  key: string;
  contentType: string;
  exp: number;
  sig: string;
  secret: string;
}): Promise<string | null> {
  const now = Math.floor(Date.now() / 1000);
  if (!Number.isFinite(exp) || exp <= now) return "expired";
  const expected = await hmacSha256Hex(
    secret,
    proxyUploadMessage(key, contentType, exp),
  );
  // Constant-time compare on equal-length strings.
  if (expected.length !== sig.length) return "bad signature";
  let mismatch = 0;
  for (let i = 0; i < expected.length; i++) {
    mismatch |= expected.charCodeAt(i) ^ sig.charCodeAt(i);
  }
  if (mismatch !== 0) return "bad signature";
  return null;
}

/**
 * Mint a presigned GET URL for a single R2 object. Used to hand the CLI a
 * short-lived link to download a generated image without round-tripping bytes
 * through the tRPC response.
 */
export async function presignGet({
  r2,
  key,
  expiresInSeconds = 3600,
}: {
  r2: R2Config;
  key: string;
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
    new Request(endpoint, { method: "GET" }),
    { aws: { signQuery: true } },
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
