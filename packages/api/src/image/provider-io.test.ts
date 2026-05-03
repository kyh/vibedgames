import assert from "node:assert/strict";
import test from "node:test";

import { fetchProviderResponse, readBytesBounded } from "./provider-io";

test("readBytesBounded rejects oversized content-length before buffering", async () => {
  const response = new Response(new Uint8Array([1, 2, 3]), {
    headers: { "content-length": "3" },
  });

  await assert.rejects(
    () => readBytesBounded(response, 2, "provider bytes"),
    /provider bytes exceeded 2 bytes/,
  );
});

test("readBytesBounded rejects oversized streamed bodies", async () => {
  const response = new Response(new Uint8Array([1, 2, 3]));

  await assert.rejects(
    () => readBytesBounded(response, 2, "provider stream"),
    /provider stream exceeded 2 bytes/,
  );
});

test("fetchProviderResponse refuses redirects", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(null, { status: 302, headers: { location: "https://example.test" } });
  try {
    await assert.rejects(
      () =>
        fetchProviderResponse({
          url: "https://provider.test",
          label: "Provider",
          credentialed: true,
        }),
      /Provider returned a 302 redirect; refusing to follow with credentials/,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
