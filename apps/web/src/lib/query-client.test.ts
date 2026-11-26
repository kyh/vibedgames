import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { z } from "zod";

import { createQueryClient } from "./query-client";

describe("dehydrate/hydrate", () => {
  test("round-trips every rich type the RPC protocol supports", () => {
    const { dehydrate, hydrate } = createQueryClient().getDefaultOptions();
    assert.ok(dehydrate?.serializeData, "query client must configure dehydrate.serializeData");
    assert.ok(hydrate?.deserializeData, "query client must configure hydrate.deserializeData");

    const data = {
      at: new Date("2020-01-01T00:00:00.000Z"),
      big: 123n,
      lookup: new Map([[1, "one"]]),
      tags: new Set(["a", "b"]),
      url: new URL("https://example.com/path?q=1"),
    };

    const revived = z
      .object({
        at: z.date(),
        big: z.bigint(),
        lookup: z.map(z.number(), z.string()),
        tags: z.set(z.string()),
        url: z.instanceof(URL),
      })
      .parse(hydrate.deserializeData(dehydrate.serializeData(data)));

    assert.deepStrictEqual({ ...revived, url: revived.url.href }, { ...data, url: data.url.href });
  });
});
