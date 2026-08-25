import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { createQueryClient } from "./query-client";

/**
 * Server-rendered query data reaches the browser through these two options and
 * nothing else in the build reads them, so a wiring mistake here — one of the
 * pair missing, or blobs allowed to become FormData the hydration payload
 * cannot carry — surfaces only as a runtime hydration mismatch.
 */
describe("dehydrate/hydrate", () => {
  test("round-trips every rich type the RPC protocol supports", () => {
    const { dehydrate, hydrate } = createQueryClient().getDefaultOptions();
    assert.ok(dehydrate?.serializeData, "query client must configure dehydrate.serializeData");
    assert.ok(hydrate?.deserializeData, "query client must configure hydrate.deserializeData");

    const data = {
      at: new Date("2020-01-01T00:00:00.000Z"),
      tags: new Set(["a", "b"]),
      lookup: new Map([[1, "one"]]),
      big: 123n,
      url: new URL("https://example.com/path?q=1"),
      re: /pattern/i,
    };
    const revived: typeof data = hydrate.deserializeData(dehydrate.serializeData(data));

    // Spread both sides: the serializer hands back a null-prototype container,
    // so a whole-object deep-equal fails on the prototype alone.
    assert.deepStrictEqual({ ...revived }, { ...data });
    assert.strictEqual(revived.url.href, data.url.href);
  });
});
