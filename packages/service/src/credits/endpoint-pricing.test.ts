import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { JsonValue } from "@repo/contract/json";

import type { PlatformAnswer } from "./endpoint-pricing";
import { getEndpointPricing } from "./endpoint-pricing";

/**
 * Pricing is a verdict on one endpoint id, resolved from two platform calls:
 * the price list (`GET /v1/models/pricing`) decides priced, unknown or
 * unavailable, and the historical estimate only sizes the hold. Priced
 * endpoints are cached for the life of the process, so every test names
 * endpoints of its own.
 */

type Answer = () => Promise<PlatformAnswer>;

const ok =
  (body: JsonValue): Answer =>
  () =>
    Promise.resolve({ body, ok: true });

const status =
  (code: number): Answer =>
  () =>
    Promise.resolve({ ok: false, status: code });

const unreachable: Answer = () => Promise.reject(new TypeError("fetch failed"));

const listing = (endpointId: string, usd: number) =>
  ok({ prices: [{ currency: "USD", endpoint_id: endpointId, unit: "image", unit_price: usd }] });

const estimate = (usd: number) => ok({ total_cost: usd });

/** The platform API as `getEndpointPricing` calls it, counting the calls. */
const platform = (answers: { price: Answer; estimate?: Answer }) => {
  const asked: string[] = [];
  const call = (input: { method: "GET" | "POST"; path: string }) => {
    asked.push(`${input.method} ${input.path}`);
    if (input.method === "GET") {
      return answers.price();
    }
    return (answers.estimate ?? status(404))();
  };
  return { asked, call };
};

const DEFAULT_HOLD = { holdMicro: 100_000, unit: null, unitPriceMicro: null };

describe("getEndpointPricing", () => {
  test("prices an endpoint the price list names, holding the estimate before one unit", async () => {
    const withHistory = platform({
      estimate: estimate(0.05),
      price: listing("test/priced-with-history", 0.025),
    });
    assert.deepEqual(await getEndpointPricing("test/priced-with-history", withHistory.call), {
      holdMicro: 50_000,
      kind: "priced",
      unit: "image",
      unitPriceMicro: 25_000,
    });

    const firstRun = platform({ price: listing("test/priced-first-run", 0.025) });
    assert.deepEqual(await getEndpointPricing("test/priced-first-run", firstRun.call), {
      holdMicro: 25_000,
      kind: "priced",
      unit: "image",
      unitPriceMicro: 25_000,
    });

    const pricey = platform({ estimate: estimate(80), price: listing("test/priced-dear", 4) });
    const dear = await getEndpointPricing("test/priced-dear", pricey.call);
    assert.equal(dear.holdMicro, 5_000_000);
  });

  test("calls an endpoint unknown when the price list answers without it", async () => {
    const id = "test/unpriced";
    const answers = {
      "400": status(400),
      "404": status(404),
      "422": status(422),
      "a price with no number": ok({
        prices: [{ endpoint_id: id, unit: "image", unit_price: null }],
      }),
      "an empty list": ok({ has_more: false, next_cursor: null, prices: [] }),
      "only another endpoint's price": listing("test/unpriced/v2", 0.025),
    };
    for (const [label, price] of Object.entries(answers)) {
      const lookup = platform({ price });
      assert.deepEqual(
        await getEndpointPricing(id, lookup.call),
        { ...DEFAULT_HOLD, kind: "unknown" },
        label,
      );
    }
    // A comma-separated id is answered with the prices of its parts.
    const joined = platform({
      price: ok({
        prices: [
          { endpoint_id: "test/a", unit: "image", unit_price: 0.025 },
          { endpoint_id: "test/b", unit: "image", unit_price: 0.025 },
        ],
      }),
    });
    const parts = await getEndpointPricing("test/a,test/b", joined.call);
    assert.equal(parts.kind, "unknown");
  });

  test("calls pricing unavailable when it cannot answer, and still holds the estimate", async () => {
    const id = "test/pricing-down";
    const answers = {
      "401": status(401),
      "403": status(403),
      "408": status(408),
      "429": status(429),
      "500": status(500),
      "503": status(503),
      "a body that is no price list": ok({ detail: "upstream hiccup" }),
      "no answer": unreachable,
    };
    for (const [label, price] of Object.entries(answers)) {
      const lookup = platform({ estimate: unreachable, price });
      assert.deepEqual(
        await getEndpointPricing(id, lookup.call),
        { ...DEFAULT_HOLD, kind: "unavailable" },
        label,
      );
    }
    const withHistory = platform({ estimate: estimate(0.3), price: status(503) });
    assert.deepEqual(await getEndpointPricing(id, withHistory.call), {
      holdMicro: 300_000,
      kind: "unavailable",
      unit: null,
      unitPriceMicro: null,
    });
  });

  test("caches a price, and nothing else", async () => {
    const id = "test/cached";
    // Neither an unknown nor an unavailable answer is kept, even when the
    // estimate answered: the next submit asks again, so a price published
    // since, or pricing back up, applies at once rather than an hour later.
    const misses = [
      { kind: "unknown", price: status(404) },
      { kind: "unavailable", price: status(503) },
    ];
    for (const { kind, price } of misses) {
      const missed = platform({ estimate: estimate(0.05), price });
      const verdict = await getEndpointPricing(id, missed.call);
      assert.equal(verdict.kind, kind);
    }
    const answered = platform({ price: listing(id, 0.025) });
    const found = await getEndpointPricing(id, answered.call);
    assert.equal(found.kind, "priced");
    assert.equal(answered.asked.length, 2);

    const again = platform({ price: unreachable });
    assert.deepEqual(await getEndpointPricing(id, again.call), {
      holdMicro: 25_000,
      kind: "priced",
      unit: "image",
      unitPriceMicro: 25_000,
    });
    assert.deepEqual(again.asked, []);
  });
});
