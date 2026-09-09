import { AwsClient } from "aws4fetch";

import type { R2Config } from "../orpc";

/** Compare two equal-length strings without short-circuiting on the first differing byte. */
const constantTimeEqual = (a: string, b: string): boolean => {
  let mismatch = 0;
  for (let i = 0; i < a.length; i += 1) {
    // oxlint-disable-next-line no-bitwise -- accumulating XOR diffs is the point of a constant-time compare
    mismatch |= (a.codePointAt(i) ?? 0) ^ (b.codePointAt(i) ?? 0);
  }
  return mismatch === 0;
};

const hmacSha256Hex = async (secret: string, message: string): Promise<string> => {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { hash: "SHA-256", name: "HMAC" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
};

/** Build the message that gets HMAC-signed for a proxy upload URL. */
const proxyUploadMessage = (key: string, contentType: string, exp: number): string =>
  `PUT\n${key}\n${contentType}\n${exp}`;

const signProxyUploadUrl = async ({
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
}): Promise<string> => {
  const exp = Math.floor(Date.now() / 1000) + expiresInSeconds;
  const sig = await hmacSha256Hex(secret, proxyUploadMessage(key, contentType, exp));
  const url = new URL("/api/r2-upload", baseUrl);
  url.searchParams.set("key", key);
  url.searchParams.set("ct", contentType);
  url.searchParams.set("exp", String(exp));
  url.searchParams.set("sig", sig);
  return url.toString();
};

/**
 * Mint a 15-minute S3 presigned PUT URL for a single R2 object. The returned
 * URL can be used directly by the CLI — no auth header required, the
 * signature is baked into the query string.
 *
 * When `r2.proxyUploadBaseUrl` is set, returns a worker-proxy URL instead so
 * uploads stream through the worker and land via the bucket binding (used in
 * local dev so the upload doesn't hit prod R2).
 */
export const presignPut = async ({
  r2,
  key,
  contentType,
  expiresInSeconds = 900,
}: {
  r2: R2Config;
  key: string;
  contentType: string;
  expiresInSeconds?: number;
}): Promise<string> => {
  if (r2.proxyUploadBaseUrl && r2.proxyUploadSecret) {
    return signProxyUploadUrl({
      baseUrl: r2.proxyUploadBaseUrl,
      contentType,
      expiresInSeconds,
      key,
      secret: r2.proxyUploadSecret,
    });
  }

  const client = new AwsClient({
    accessKeyId: r2.accessKeyId,
    region: "auto",
    secretAccessKey: r2.secretAccessKey,
    service: "s3",
  });

  const endpoint = new URL(
    `https://${r2.accountId}.r2.cloudflarestorage.com/${r2.bucketName}/${key}`,
  );
  endpoint.searchParams.set("X-Amz-Expires", String(expiresInSeconds));

  const signed = await client.sign(
    new Request(endpoint, {
      headers: { "content-type": contentType },
      method: "PUT",
    }),
    {
      aws: { signQuery: true },
    },
  );

  return signed.url;
};

/**
 * Validate a proxy upload URL's signature against the configured secret.
 * Returns null on valid signature, an error message string otherwise.
 */
export const verifyProxyUploadUrl = async ({
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
}): Promise<string | null> => {
  const now = Math.floor(Date.now() / 1000);
  if (!Number.isFinite(exp) || exp <= now) {
    return "expired";
  }
  const expected = await hmacSha256Hex(secret, proxyUploadMessage(key, contentType, exp));
  // Constant-time compare on equal-length strings.
  if (expected.length !== sig.length) {
    return "bad signature";
  }
  if (!constantTimeEqual(expected, sig)) {
    return "bad signature";
  }
  return null;
};

/** Build the message that gets HMAC-signed for a proxy download URL. */
const proxyDownloadMessage = (key: string, exp: number): string => `GET\n${key}\n${exp}`;

const signProxyDownloadUrl = async ({
  baseUrl,
  key,
  secret,
  expiresInSeconds,
}: {
  baseUrl: string;
  key: string;
  secret: string;
  expiresInSeconds: number;
}): Promise<string> => {
  const exp = Math.floor(Date.now() / 1000) + expiresInSeconds;
  const sig = await hmacSha256Hex(secret, proxyDownloadMessage(key, exp));
  const url = new URL("/api/r2-download", baseUrl);
  url.searchParams.set("key", key);
  url.searchParams.set("exp", String(exp));
  url.searchParams.set("sig", sig);
  return url.toString();
};

/**
 * Validate a proxy download URL's signature. Returns null when valid, an
 * error message otherwise. Mirrors `verifyProxyUploadUrl` for GETs.
 */
export const verifyProxyDownloadUrl = async ({
  key,
  exp,
  sig,
  secret,
}: {
  key: string;
  exp: number;
  sig: string;
  secret: string;
}): Promise<string | null> => {
  const now = Math.floor(Date.now() / 1000);
  if (!Number.isFinite(exp) || exp <= now) {
    return "expired";
  }
  const expected = await hmacSha256Hex(secret, proxyDownloadMessage(key, exp));
  if (expected.length !== sig.length) {
    return "bad signature";
  }
  if (!constantTimeEqual(expected, sig)) {
    return "bad signature";
  }
  return null;
};

/**
 * Mint a presigned GET URL for a single R2 object. Used to hand the CLI a
 * short-lived link to download a generated image or a source archive without
 * round-tripping bytes through the RPC response.
 *
 * When `r2.proxyUploadBaseUrl` is set (local dev), returns a worker-proxy URL
 * so the download reads from the Miniflare-simulated bucket binding rather
 * than direct S3 against prod R2.
 */
export const presignGet = async ({
  r2,
  key,
  expiresInSeconds = 3600,
}: {
  r2: R2Config;
  key: string;
  expiresInSeconds?: number;
}): Promise<string> => {
  if (r2.proxyUploadBaseUrl && r2.proxyUploadSecret) {
    return signProxyDownloadUrl({
      baseUrl: r2.proxyUploadBaseUrl,
      expiresInSeconds,
      key,
      secret: r2.proxyUploadSecret,
    });
  }

  const client = new AwsClient({
    accessKeyId: r2.accessKeyId,
    region: "auto",
    secretAccessKey: r2.secretAccessKey,
    service: "s3",
  });

  const endpoint = new URL(
    `https://${r2.accountId}.r2.cloudflarestorage.com/${r2.bucketName}/${key}`,
  );
  endpoint.searchParams.set("X-Amz-Expires", String(expiresInSeconds));

  const signed = await client.sign(new Request(endpoint, { method: "GET" }), {
    aws: { signQuery: true },
  });

  return signed.url;
};

/**
 * Delete every object under a given R2 prefix. Used to clear the previous
 * deployment when single-deploy mode overwrites an old release.
 */
export const deletePrefix = async ({
  r2,
  prefix,
}: {
  r2: R2Config;
  prefix: string;
}): Promise<void> => {
  let cursor: string | undefined = undefined;
  while (true) {
    const listed = await r2.bucket.list({ cursor, limit: 1000, prefix });
    if (listed.objects.length === 0) {
      return;
    }
    await Promise.all(listed.objects.map((o) => r2.bucket.delete(o.key)));
    if (!listed.truncated) {
      return;
    }
    ({ cursor } = listed);
  }
};
