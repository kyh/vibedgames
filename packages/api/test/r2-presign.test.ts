import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import type { R2Config } from "../src/trpc";
import {
  deletePrefix,
  presignGet,
  presignPut,
  verifyProxyDownloadUrl,
  verifyProxyUploadUrl,
} from "../src/deploy/r2-presign";

const SECRET = "test-signing-secret";

/** Production-shaped config: no proxy, so presigning goes to S3. */
const directConfig = (): R2Config => ({
  bucket: env.GAMES_BUCKET,
  bucketName: "vibedgames-games",
  accountId: "acct-123",
  accessKeyId: "ak-123",
  secretAccessKey: "sk-123",
});

/** Local-dev-shaped config: uploads route through the Worker proxy. */
const proxyConfig = (): R2Config => ({
  ...directConfig(),
  proxyUploadBaseUrl: "http://localhost:5173",
  proxyUploadSecret: SECRET,
});

const paramsOf = (url: string) => new URL(url).searchParams;

describe("presignPut", () => {
  it("signs against R2's S3 endpoint when no proxy is configured", async () => {
    const url = await presignPut({
      r2: directConfig(),
      key: "games/g1/d1/index.html",
      contentType: "text/html",
    });

    expect(url).toContain("https://acct-123.r2.cloudflarestorage.com/vibedgames-games/");
    expect(paramsOf(url).get("X-Amz-Expires")).toBe("900");
    expect(paramsOf(url).get("X-Amz-Signature")).toBeTruthy();
  });

  it("routes through the Worker proxy when one is configured", async () => {
    const url = await presignPut({
      r2: proxyConfig(),
      key: "games/g1/d1/index.html",
      contentType: "text/html",
    });

    // This is the boundary that keeps `vg deploy` against localhost out of
    // production R2 — see the host check in apps/web/src/auth/server.ts.
    expect(url.startsWith("http://localhost:5173/api/r2-upload")).toBe(true);
    expect(paramsOf(url).get("key")).toBe("games/g1/d1/index.html");
    expect(paramsOf(url).get("ct")).toBe("text/html");
    expect(url).not.toContain("r2.cloudflarestorage.com");
  });
});

describe("proxy upload signatures", () => {
  const signed = async (key = "games/g1/d1/index.html", contentType = "text/html") => {
    const url = await presignPut({ r2: proxyConfig(), key, contentType });
    const p = paramsOf(url);
    return {
      key: p.get("key") ?? "",
      contentType: p.get("ct") ?? "",
      exp: Number(p.get("exp")),
      sig: p.get("sig") ?? "",
    };
  };

  it("accepts a signature it just minted", async () => {
    const s = await signed();
    expect(await verifyProxyUploadUrl({ ...s, secret: SECRET })).toBeNull();
  });

  it("rejects a swapped key — one signature cannot authorize another object", async () => {
    const s = await signed();
    expect(
      await verifyProxyUploadUrl({ ...s, key: "games/other/d1/index.html", secret: SECRET }),
    ).toBe("bad signature");
  });

  it("rejects a swapped content type", async () => {
    const s = await signed();
    expect(
      await verifyProxyUploadUrl({ ...s, contentType: "application/javascript", secret: SECRET }),
    ).toBe("bad signature");
  });

  it("rejects an extended expiry — exp is inside the signed message", async () => {
    const s = await signed();
    expect(await verifyProxyUploadUrl({ ...s, exp: s.exp + 3600, secret: SECRET })).toBe(
      "bad signature",
    );
  });

  it("rejects a signature minted with a different secret", async () => {
    const s = await signed();
    expect(await verifyProxyUploadUrl({ ...s, secret: "not-the-secret" })).toBe("bad signature");
  });

  it("rejects an already-expired URL before checking the signature", async () => {
    const s = await signed();
    expect(await verifyProxyUploadUrl({ ...s, exp: 1, secret: SECRET })).toBe("expired");
  });

  it("rejects a non-finite expiry", async () => {
    const s = await signed();
    expect(await verifyProxyUploadUrl({ ...s, exp: Number.NaN, secret: SECRET })).toBe("expired");
  });

  it("rejects a truncated signature rather than comparing a prefix", async () => {
    const s = await signed();
    expect(await verifyProxyUploadUrl({ ...s, sig: s.sig.slice(0, 32), secret: SECRET })).toBe(
      "bad signature",
    );
  });

  it("rejects an empty signature", async () => {
    const s = await signed();
    expect(await verifyProxyUploadUrl({ ...s, sig: "", secret: SECRET })).toBe("bad signature");
  });
});

describe("presignGet", () => {
  it("signs against R2's S3 endpoint when no proxy is configured", async () => {
    const url = await presignGet({ r2: directConfig(), key: "games/g1/d1/sprite.png" });
    expect(url).toContain("https://acct-123.r2.cloudflarestorage.com/vibedgames-games/");
    expect(paramsOf(url).get("X-Amz-Expires")).toBe("3600");
  });

  it("routes through the Worker proxy when one is configured", async () => {
    const url = await presignGet({ r2: proxyConfig(), key: "games/g1/d1/sprite.png" });
    expect(url.startsWith("http://localhost:5173/api/r2-download")).toBe(true);
    expect(paramsOf(url).get("key")).toBe("games/g1/d1/sprite.png");
  });

  it("accepts a signature it just minted", async () => {
    const url = await presignGet({ r2: proxyConfig(), key: "games/g1/d1/sprite.png" });
    const p = paramsOf(url);
    expect(
      await verifyProxyDownloadUrl({
        key: p.get("key") ?? "",
        exp: Number(p.get("exp")),
        sig: p.get("sig") ?? "",
        secret: SECRET,
      }),
    ).toBeNull();
  });
});

describe("upload and download signatures are not interchangeable", () => {
  // The signed message is prefixed with the method (`PUT\n…` vs `GET\n…`), so a
  // read token must never be replayable as a write token.
  it("a download signature does not authorize an upload", async () => {
    const key = "games/g1/d1/index.html";
    const url = await presignGet({ r2: proxyConfig(), key });
    const p = paramsOf(url);

    expect(
      await verifyProxyUploadUrl({
        key,
        contentType: "text/html",
        exp: Number(p.get("exp")),
        sig: p.get("sig") ?? "",
        secret: SECRET,
      }),
    ).toBe("bad signature");
  });

  it("an upload signature does not authorize a download", async () => {
    const key = "games/g1/d1/index.html";
    const url = await presignPut({ r2: proxyConfig(), key, contentType: "text/html" });
    const p = paramsOf(url);

    expect(
      await verifyProxyDownloadUrl({
        key,
        exp: Number(p.get("exp")),
        sig: p.get("sig") ?? "",
        secret: SECRET,
      }),
    ).toBe("bad signature");
  });
});

describe("deletePrefix", () => {
  const put = (key: string) => env.GAMES_BUCKET.put(key, "x");

  it("deletes every object under the prefix", async () => {
    await put("games/g1/d1/index.html");
    await put("games/g1/d1/assets/a.png");
    await put("games/g1/d1/assets/b.png");

    await deletePrefix({ r2: directConfig(), prefix: "games/g1/d1/" });

    const left = await env.GAMES_BUCKET.list({ prefix: "games/g1/d1/" });
    expect(left.objects).toHaveLength(0);
  });

  it("leaves other deployments of the same game untouched", async () => {
    // Single-active-deployment mode clears the previous deployment's prefix on
    // every deploy; clearing a sibling prefix too would delete a live release.
    await put("games/g1/old/index.html");
    await put("games/g1/new/index.html");

    await deletePrefix({ r2: directConfig(), prefix: "games/g1/old/" });

    expect((await env.GAMES_BUCKET.list({ prefix: "games/g1/old/" })).objects).toHaveLength(0);
    expect((await env.GAMES_BUCKET.list({ prefix: "games/g1/new/" })).objects).toHaveLength(1);
  });

  it("does not treat a prefix as a substring match across games", async () => {
    // `games/g1` must not sweep away `games/g10`.
    await put("games/g1/d1/index.html");
    await put("games/g10/d1/index.html");

    await deletePrefix({ r2: directConfig(), prefix: "games/g1/" });

    expect((await env.GAMES_BUCKET.list({ prefix: "games/g10/" })).objects).toHaveLength(1);
  });

  it("is a no-op on an empty prefix", async () => {
    await expect(
      deletePrefix({ r2: directConfig(), prefix: "games/nothing-here/" }),
    ).resolves.toBeUndefined();
  });

  it("pages past the 1000-object list limit", async () => {
    // `list` caps at 1000 per call, so a deployment with more files than that
    // relies on the cursor loop to be fully cleared.
    const keys = Array.from({ length: 1005 }, (_, i) => `games/big/d1/f${i}.txt`);
    for (const batch of chunk(keys, 50)) {
      await Promise.all(batch.map((k) => put(k)));
    }
    expect((await env.GAMES_BUCKET.list({ prefix: "games/big/d1/" })).objects.length).toBe(1000);

    await deletePrefix({ r2: directConfig(), prefix: "games/big/d1/" });

    expect((await env.GAMES_BUCKET.list({ prefix: "games/big/d1/" })).objects).toHaveLength(0);
  });
});

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}
