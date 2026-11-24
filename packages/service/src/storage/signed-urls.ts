/**
 * Minimal structural view of the R2 binding methods this package (and, through
 * `R2Config`, the web app's R2 proxy routes) uses. Declared here rather than
 * imported from `@cloudflare/workers-types` so the context names only what the
 * code calls: any object with these methods stands in for the binding, and
 * nothing that reads `ORPCContext` needs the Workers globals.
 */
export interface R2BucketLike {
  get: (key: string) => Promise<{
    size: number;
    httpMetadata?: { contentType?: string };
    arrayBuffer: () => Promise<ArrayBuffer>;
    body: ReadableStream<Uint8Array<ArrayBuffer>>;
  } | null>;
  head: (key: string) => Promise<{
    size: number;
    httpMetadata?: { contentType?: string };
  } | null>;
  list: (options: { prefix?: string; cursor?: string; limit?: number }) => Promise<{
    objects: { key: string; size: number }[];
    truncated: boolean;
    cursor?: string;
  }>;
  delete: (key: string) => Promise<void>;
  put: (
    key: string,
    value: ArrayBuffer | ArrayBufferView | ReadableStream | string,
    options?: { httpMetadata?: { contentType?: string } },
  ) => Promise<{ key: string } | null>;
}

/** The bucket that games and source archives live in, as the Worker binds it. */
export interface R2Config {
  bucket: R2BucketLike;
}

/**
 * Mints the short-lived `/api/upload` and `/api/download` URLs that carry
 * bytes through the web Worker: the host they point at, and the secret they
 * are signed with.
 */
export interface UrlSigning {
  baseUrl: string;
  secret: string;
}

const constantTimeEqual = (a: string, b: string) => {
  let mismatch = 0;

  for (let i = 0; i < a.length; i += 1) {
    // oxlint-disable-next-line no-bitwise -- accumulating XOR diffs is the point of a constant-time compare
    mismatch |= (a.codePointAt(i) ?? 0) ^ (b.codePointAt(i) ?? 0);
  }

  return mismatch === 0;
};

const hmacSha256Hex = async (secret: string, message: string) => {
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

const verify = async (secret: string, message: string, exp: number, sig: string) => {
  if (!Number.isFinite(exp) || exp <= Math.floor(Date.now() / 1000)) {
    return "expired";
  }

  const expected = await hmacSha256Hex(secret, message);

  return expected.length === sig.length && constantTimeEqual(expected, sig)
    ? null
    : "bad signature";
};

/** Where an upload lands: an R2 key, or one external URL the server minted. */
export type UploadTarget = { key: string } | { url: string };

const targetOf = (target: UploadTarget) =>
  "key" in target ? `r2:${target.key}` : `url:${target.url}`;

const uploadMessage = (target: UploadTarget, contentType: string, exp: number) =>
  `PUT\n${targetOf(target)}\n${contentType}\n${exp}`;

const downloadMessage = (key: string, exp: number) => `GET\n${key}\n${exp}`;

const expiry = (seconds: number) => Math.floor(Date.now() / 1000) + seconds;

/** A signed `/api/upload` URL for one PUT of `contentType` to `target`. */
export const signUploadUrl = async ({
  contentType,
  expiresInSeconds = 900,
  signing,
  target,
}: {
  contentType: string;
  expiresInSeconds?: number;
  signing: UrlSigning;
  target: UploadTarget;
}) => {
  const exp = expiry(expiresInSeconds);
  const url = new URL("/api/upload", signing.baseUrl);

  if ("key" in target) {
    url.searchParams.set("key", target.key);
  } else {
    url.searchParams.set("to", target.url);
  }

  url.searchParams.set("ct", contentType);
  url.searchParams.set("exp", String(exp));
  url.searchParams.set(
    "sig",
    await hmacSha256Hex(signing.secret, uploadMessage(target, contentType, exp)),
  );

  return url.toString();
};

/** What a signed `/api/upload` URL allows, or why it allows nothing. */
export const verifyUploadUrl: (
  params: URLSearchParams,
  secret: string,
) => Promise<{ contentType: string; target: UploadTarget } | { error: string }> = async (
  params,
  secret,
) => {
  const key = params.get("key");
  const to = params.get("to");
  const contentType = params.get("ct");
  const exp = params.get("exp");
  const sig = params.get("sig");

  if ((key === null) === (to === null) || !contentType || !exp || !sig) {
    return { error: "missing query params (key or to, ct, exp, sig)" };
  }

  const target: UploadTarget = key === null ? { url: to ?? "" } : { key };

  const error = await verify(
    secret,
    uploadMessage(target, contentType, Number(exp)),
    Number(exp),
    sig,
  );

  return error === null ? { contentType, target } : { error };
};

/** A signed `/api/download` URL for one R2 object. */
export const signDownloadUrl = async ({
  expiresInSeconds = 3600,
  key,
  signing,
}: {
  expiresInSeconds?: number;
  key: string;
  signing: UrlSigning;
}) => {
  const exp = expiry(expiresInSeconds);
  const url = new URL("/api/download", signing.baseUrl);
  url.searchParams.set("key", key);
  url.searchParams.set("exp", String(exp));
  url.searchParams.set("sig", await hmacSha256Hex(signing.secret, downloadMessage(key, exp)));

  return url.toString();
};

/** The R2 key a signed `/api/download` URL allows, or why it allows nothing. */
export const verifyDownloadUrl: (
  params: URLSearchParams,
  secret: string,
) => Promise<{ key: string } | { error: string }> = async (params, secret) => {
  const key = params.get("key");
  const exp = params.get("exp");
  const sig = params.get("sig");

  if (!key || !exp || !sig) {
    return { error: "missing query params (key, exp, sig)" };
  }

  const error = await verify(secret, downloadMessage(key, Number(exp)), Number(exp), sig);

  return error === null ? { key } : { error };
};

/**
 * Delete every object under a given R2 prefix. Used to clear the previous
 * deployment when single-deploy mode overwrites an old release.
 */
export const deletePrefix = async ({ r2, prefix }: { r2: R2Config; prefix: string }) => {
  let cursor: string | undefined;

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
