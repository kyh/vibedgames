import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { describe, test } from "node:test";

import { createQueryClient } from "./query-client";

/**
 * The hash has to satisfy two properties at once, and a fix for either can
 * break the other: inputs that differ only in property order must collide, and
 * inputs that differ in value or in type must not.
 */
type ProcedureInput = Record<string, Date | Set<number> | Map<number, string> | number | string>;

const hash = (input: ProcedureInput) => {
  const { queryKeyHashFn } = createQueryClient().getDefaultOptions().queries ?? {};
  assert.ok(queryKeyHashFn, "query client must configure queryKeyHashFn");
  return queryKeyHashFn([["deploy", "list"], { input, type: "query" }]);
};

/** Hashes one key with non-ASCII names, printing the result, for the locale test. */
const SCRIPT = `
  const { createQueryClient } = await import("./query-client.ts");
  const fn = createQueryClient().getDefaultOptions().queries.queryKeyHashFn;
  process.stdout.write(fn([["deploy", "list"], {
    input: { "ä": new Date("2020-01-01"), z: new Date("2021-01-01") },
    type: "query",
  }]));
`;

describe("queryKeyHashFn", () => {
  test("collides on plain inputs that differ only in property order", () => {
    assert.strictEqual(hash({ a: 1, b: 2 }), hash({ b: 2, a: 1 }));
  });

  test("collides on rich inputs that differ only in property order", () => {
    // The serializer emits one meta entry per rich value in traversal order,
    // and `hashKey` sorts object keys but not arrays — so unsorted meta hashes
    // these differently.
    const from = new Date("2020-01-01");
    const to = new Date("2021-01-01");
    assert.strictEqual(hash({ from, to }), hash({ to, from }));
  });

  test("collides on reordered non-ASCII keys", () => {
    const first = new Date("2020-01-01");
    const second = new Date("2021-01-01");
    assert.strictEqual(hash({ ä: first, z: second }), hash({ z: second, ä: first }));
  });

  test("hashes identically across locales", () => {
    // Sorting meta with a locale-sensitive comparator lets a Node server and a
    // browser on different locales order it differently, so hydration misses
    // the key the server rendered under. Only observable across processes —
    // within one, any consistent comparator looks correct. `ä` vs `z` inverts
    // between en-US and sv-SE.
    const hashUnder = (locale: string) =>
      execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", SCRIPT], {
        env: { ...process.env, LC_ALL: locale, LANG: locale },
        cwd: import.meta.dirname,
        encoding: "utf8",
      }).trim();

    assert.notStrictEqual("ä".localeCompare("z", "en-US"), "ä".localeCompare("z", "sv-SE"));
    assert.strictEqual(hashUnder("en-US"), hashUnder("sv-SE"));
  });

  test("separates inputs that differ by value", () => {
    assert.notStrictEqual(
      hash({ from: new Date("2020-01-01") }),
      hash({ from: new Date("2021-01-01") }),
    );
  });

  test("separates a rich value from its plain encoding", () => {
    const at = new Date("2020-01-01");
    assert.notStrictEqual(hash({ at }), hash({ at: at.toISOString() }));
  });

  test("collides on nested rich values that differ only in property order", () => {
    const set = new Set([1, 2]);
    const map = new Map([[1, "one"]]);
    assert.strictEqual(hash({ a: set, b: map }), hash({ b: map, a: set }));
  });

  test("separates rich values whose types swap between properties", () => {
    // Both inputs encode to the same json ({ a: [], b: [] }); only the paths
    // inside the meta entries tell them apart. Pins that the sorted meta keeps
    // whole entries — sorting bare type tags would collide these.
    assert.notStrictEqual(
      hash({ a: new Map([[1, "one"]]), b: new Set([1]) }),
      hash({ a: new Set([1]), b: new Map([[1, "one"]]) }),
    );
  });
});

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

    assert.deepStrictEqual(revived, data);
    assert.strictEqual(revived.url.href, data.url.href);
  });
});
