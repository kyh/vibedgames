import assert from "node:assert/strict";
import { after, afterEach, before, describe, test } from "node:test";
import { http } from "msw";
import { setupServer } from "msw/node";

import { fetchClientMetadataResource } from "./cimd-fetch";

const network = setupServer();
const seen: { redirect: string; url: string }[] = [];

before(() => {
  network.listen({ onUnhandledRequest: "error" });
});

afterEach(() => {
  network.resetHandlers();
  seen.length = 0;
});

after(() => {
  network.close();
});

const fetchMetadata = async (url: string, init?: RequestInit) =>
  await fetchClientMetadataResource(url, init);

const answerWith = (response: Response) => {
  network.use(
    http.all("*", ({ request }) => {
      seen.push({ redirect: request.redirect, url: request.url });

      return response;
    }),
  );
};

describe("fetchClientMetadataResource", () => {
  test("reads a document over HTTPS without following redirects", async () => {
    answerWith(Response.json({ client_name: "Claude" }));
    const response = await fetchMetadata("https://claude.ai/oauth/client.json");
    assert.deepStrictEqual(await response.json(), { client_name: "Claude" });
    assert.deepStrictEqual(seen, [
      { redirect: "manual", url: "https://claude.ai/oauth/client.json" },
    ]);
  });

  test("takes the caller's init as better-auth passes it", async () => {
    answerWith(Response.json({ client_name: "Claude" }));

    const response = await fetchMetadata("https://claude.ai/oauth/client.json", {
      headers: { Accept: "application/json" },
      redirect: "error",
      signal: new AbortController().signal,
    });

    assert.strictEqual(response.status, 200);
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
    ["a public IPv6 literal", "https://[2606:4700::1111]/client.json"],
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
