import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { signDownloadUrl, signUploadUrl, verifyDownloadUrl, verifyUploadUrl } from "./signed-urls";

const signing = { baseUrl: "https://vibedgames.com", secret: "test-secret" };

const paramsOf = (url: string) => new URL(url).searchParams;

describe("signed upload URLs", () => {
  test("point at /api/upload on the signing host and allow their R2 key", async () => {
    const url = await signUploadUrl({
      contentType: "image/png",
      signing,
      target: { key: "games/a.png" },
    });
    assert.ok(url.startsWith("https://vibedgames.com/api/upload?"));
    assert.deepStrictEqual(await verifyUploadUrl(paramsOf(url), signing.secret), {
      contentType: "image/png",
      target: { key: "games/a.png" },
    });
  });

  test("allow the external URL they were minted for", async () => {
    const to = "https://storage.example/slot?token=1";
    const url = await signUploadUrl({ contentType: "audio/wav", signing, target: { url: to } });
    assert.deepStrictEqual(await verifyUploadUrl(paramsOf(url), signing.secret), {
      contentType: "audio/wav",
      target: { url: to },
    });
  });

  test("refuse a changed target, type or secret", async () => {
    const url = await signUploadUrl({ contentType: "image/png", signing, target: { key: "a" } });
    const moved = paramsOf(url);
    moved.set("key", "b");
    assert.deepStrictEqual(await verifyUploadUrl(moved, signing.secret), {
      error: "bad signature",
    });
    const retyped = paramsOf(url);
    retyped.set("ct", "text/html");
    assert.deepStrictEqual(await verifyUploadUrl(retyped, signing.secret), {
      error: "bad signature",
    });
    assert.deepStrictEqual(await verifyUploadUrl(paramsOf(url), "other"), {
      error: "bad signature",
    });
  });

  test("never lets a key signature stand for a URL, or allow both", async () => {
    const url = await signUploadUrl({ contentType: "image/png", signing, target: { key: "a" } });
    const swapped = paramsOf(url);
    swapped.delete("key");
    swapped.set("to", "a");
    assert.deepStrictEqual(await verifyUploadUrl(swapped, signing.secret), {
      error: "bad signature",
    });
    const both = paramsOf(url);
    both.set("to", "https://elsewhere.example");
    assert.ok("error" in (await verifyUploadUrl(both, signing.secret)));
  });

  test("expire", async () => {
    const url = await signUploadUrl({
      contentType: "image/png",
      expiresInSeconds: -1,
      signing,
      target: { key: "a" },
    });
    assert.deepStrictEqual(await verifyUploadUrl(paramsOf(url), signing.secret), {
      error: "expired",
    });
  });
});

describe("signed download URLs", () => {
  test("allow their key and nothing else", async () => {
    const url = await signDownloadUrl({ key: "sources/a.tgz", signing });
    assert.ok(url.startsWith("https://vibedgames.com/api/download?"));
    assert.deepStrictEqual(await verifyDownloadUrl(paramsOf(url), signing.secret), {
      key: "sources/a.tgz",
    });
    const moved = paramsOf(url);
    moved.set("key", "sources/b.tgz");
    assert.deepStrictEqual(await verifyDownloadUrl(moved, signing.secret), {
      error: "bad signature",
    });
  });
});
