import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";

import { fetchClientMetadataResource } from "./cimd-fetch";

/**
 * The transport is the only network boundary a client's `client_id` URL
 * reaches: it must refuse what the edge does not, and never follow a redirect.
 */

const realFetch = globalThis.fetch;
const seen: { redirect: string | undefined; url: string }[] = [];

/** The transport's answer as a promise, whatever it returns. */
const fetchMetadata = async (url: string, init?: RequestInit) =>
  await fetchClientMetadataResource(url, init);

const answerWith = (response: Response) => {
  globalThis.fetch = (input, init) => {
    seen.push({ redirect: init?.redirect, url: String(input) });
    return Promise.resolve(response);
  };
};

afterEach(() => {
  globalThis.fetch = realFetch;
  seen.length = 0;
});

describe("fetchClientMetadataResource", () => {
  test("reads a document over HTTPS without following redirects", async () => {
    answerWith(Response.json({ client_name: "Claude" }));
    const response = await fetchMetadata("https://claude.ai/oauth/client.json");
    assert.deepStrictEqual(await response.json(), { client_name: "Claude" });
    assert.deepStrictEqual(seen, [
      { redirect: "manual", url: "https://claude.ai/oauth/client.json" },
    ]);
  });

  test("refuses a redirect", async () => {
    answerWith(new Response(null, { headers: { location: "http://10.0.0.1/" }, status: 302 }));
    await assert.rejects(fetchMetadata("https://claude.ai/oauth/client.json"), {
      message: /must not redirect/u,
    });
  });

  for (const [why, url] of [
    ["plain HTTP", "http://claude.ai/oauth/client.json"],
    ["an IPv4 literal", "https://169.254.169.254/latest/meta-data"],
    ["an IPv6 literal", "https://[::1]/client.json"],
    ["a loopback name", "https://localhost/client.json"],
  ]) {
    test(`refuses ${why} before fetching`, async () => {
      answerWith(Response.json({}));
      await assert.rejects(fetchMetadata(url ?? ""), TypeError);
      assert.deepStrictEqual(seen, []);
    });
  }

  test("refuses anything but a read", async () => {
    answerWith(Response.json({}));
    await assert.rejects(fetchMetadata("https://claude.ai/oauth/client.json", { method: "POST" }), {
      message: /only ever read/u,
    });
    assert.deepStrictEqual(seen, []);
  });
});
