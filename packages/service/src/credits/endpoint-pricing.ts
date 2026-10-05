import type { JsonValue } from "@repo/contract/json";
import { z } from "zod";

import { MICRO_PER_USD, usdToMicro } from "./credit-ledger";

/**
 * What the provider's pricing says about one endpoint at submit time, and the
 * hold to debit for it:
 *
 *   priced — `GET /v1/models/pricing` lists a unit price for exactly this
 *     endpoint id, which settle uses to turn the provider's billable-units
 *     report into a charge.
 *   unknown — the lookup answered (a 2xx, or a 4xx refusing the id) and lists
 *     no price for it. The provider may still run it, but nothing could settle
 *     what it costs, so the router refuses it to everyone but an admin.
 *   unavailable — the lookup could not answer: a network error or timeout, a
 *     5xx, a rate limit, a refusal of our key, or a body that is no price list.
 *     Pricing being down must never block a generation, so the submit goes
 *     ahead on the hold.
 *
 * holdMicro is the estimated debit taken at submit. Preference order: the
 * provider's historical per-call average (`POST /v1/models/pricing/estimate`,
 * which reflects what runs of this endpoint actually cost this account), then
 * one priced unit, then a flat default. Clamped so a weird estimate can't hold
 * $0 or $500. Without a unit price, settle charges the hold.
 */
export type EndpointPricing =
  | { kind: "priced"; holdMicro: number; unit: string | null; unitPriceMicro: number }
  | { kind: "unknown" | "unavailable"; holdMicro: number; unit: null; unitPriceMicro: null };

type Priced = Extract<EndpointPricing, { kind: "priced" }>;

/**
 * A platform-API answer: the parsed body of a 2xx, or the status of any other.
 * The transport throws when there is no answer to report (a network error, a
 * refused redirect, a body it could not read).
 */
export type PlatformAnswer = { ok: true; body: JsonValue } | { ok: false; status: number };

type PlatformCall = (input: {
  method: "GET" | "POST";
  path: string;
  query?: Record<string, string>;
  body?: JsonValue;
}) => Promise<PlatformAnswer>;

// $0.10
const DEFAULT_HOLD_MICRO = 100_000;
// $0.01
const MIN_HOLD_MICRO = 10_000;
// $5.00
const MAX_HOLD_MICRO = 5 * MICRO_PER_USD;

const holdFor = (basisMicro: number | null): number =>
  basisMicro === null
    ? DEFAULT_HOLD_MICRO
    : Math.min(MAX_HOLD_MICRO, Math.max(MIN_HOLD_MICRO, basisMicro));

// Per-isolate cache of priced endpoints. Endpoint prices move rarely; an hour
// of staleness only shifts when a price change starts applying to settles.
// Nothing else is kept: the next submit asks again, so a price published since
// an `unknown`, or pricing back since an `unavailable`, applies at once.
const CACHE_TTL_MS = 60 * 60 * 1000;
const cache = new Map<string, { value: Priced; expiresAt: number }>();

// Entries that don't fit (wrong types, non-finite price) collapse to null and
// are skipped, matching a per-entry "ignore what we can't read" posture.
const priceEntry = z
  .looseObject({
    endpoint_id: z.string(),
    // oxlint-disable-next-line promise/prefer-await-to-then -- zod's .catch() is a schema fallback, not a promise
    unit: z.string().nullable().catch(null),
    unit_price: z.number().finite(),
  })
  .nullable()
  // oxlint-disable-next-line promise/prefer-await-to-then -- zod's .catch() is a schema fallback, not a promise
  .catch(null);

const pricingPayload = z.looseObject({ prices: z.array(priceEntry) });

// A 4xx is the pricing API's verdict on the id asked about, except the ones
// about our key (401, 403) or its load (408, 429): those, like a 5xx, say
// nothing about the endpoint.
const SAYS_NOTHING_OF_THE_ID = new Set([401, 403, 408, 429]);

type PriceVerdict =
  | { kind: "priced"; unit: string | null; unitPriceMicro: number }
  | { kind: "unknown" | "unavailable" };

const readPrice = (
  answer: PromiseSettledResult<PlatformAnswer>,
  endpointId: string,
): PriceVerdict => {
  if (answer.status === "rejected") {
    return { kind: "unavailable" };
  }
  if (!answer.value.ok) {
    const { status } = answer.value;
    const refusesTheId = status >= 400 && status < 500 && !SAYS_NOTHING_OF_THE_ID.has(status);
    return { kind: refusesTheId ? "unknown" : "unavailable" };
  }
  const parsed = pricingPayload.safeParse(answer.value.body);
  if (!parsed.success) {
    return { kind: "unavailable" };
  }
  // Exactly this id. The API reads `endpoint_id` as a comma-separated list, so
  // `a,b` is answered with the prices of `a` and `b`, and neither is the
  // endpoint a submit to `/a,b` names.
  const price = parsed.data.prices.find((entry) => entry?.endpoint_id === endpointId);
  if (!price) {
    return { kind: "unknown" };
  }
  return { kind: "priced", unit: price.unit, unitPriceMicro: usdToMicro(price.unit_price) };
};

const estimatePayload = z.looseObject({ total_cost: z.number().finite() });

const readEstimate = (answer: PromiseSettledResult<PlatformAnswer>): number | null => {
  if (answer.status === "rejected" || !answer.value.ok) {
    return null;
  }
  const parsed = estimatePayload.safeParse(answer.value.body);
  if (!parsed.success) {
    return null;
  }
  return parsed.data.total_cost > 0 ? usdToMicro(parsed.data.total_cost) : null;
};

/**
 * Resolve pricing for `endpointId` via the platform API. `call` is the
 * caller's credentialed platform-API transport (the generate router already
 * has one); this module owns only the shapes, the verdict and the cache.
 */
export const getEndpointPricing = async (
  endpointId: string,
  call: PlatformCall,
): Promise<EndpointPricing> => {
  const cached = cache.get(endpointId);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.value;
  }

  const [priceAnswer, estimateAnswer] = await Promise.allSettled([
    call({
      method: "GET",
      path: "/v1/models/pricing",
      query: { endpoint_id: endpointId },
    }),
    call({
      body: {
        endpoints: { [endpointId]: { call_quantity: 1 } },
        estimate_type: "historical_api_price",
      },
      method: "POST",
      path: "/v1/models/pricing/estimate",
    }),
  ]);

  const price = readPrice(priceAnswer, endpointId);
  const estimateMicro = readEstimate(estimateAnswer);

  if (price.kind !== "priced") {
    return {
      holdMicro: holdFor(estimateMicro),
      kind: price.kind,
      unit: null,
      unitPriceMicro: null,
    };
  }
  const value: Priced = { ...price, holdMicro: holdFor(estimateMicro ?? price.unitPriceMicro) };
  cache.set(endpointId, { expiresAt: Date.now() + CACHE_TTL_MS, value });
  return value;
};
