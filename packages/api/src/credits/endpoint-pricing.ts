import { z } from "zod";

import type { JsonValue } from "../json";
import { MICRO_PER_USD, usdToMicro } from "./credit-ledger";

/**
 * Pricing intel for one endpoint, resolved at submit time:
 *
 *   unitPriceMicro/unit — from `GET /v1/models/pricing`, used to convert the
 *     provider's billable-units report into a settled charge.
 *   holdMicro — the estimated debit taken at submit. Preference order:
 *     the provider's historical per-call average (`POST
 *     /v1/models/pricing/estimate`, which reflects what runs of this
 *     endpoint actually cost this account), then one priced unit, then a
 *     flat default. Clamped so a weird estimate can't hold $0 or $500.
 *
 * Lookups are best-effort: pricing being down must never block a
 * generation, so failures degrade to the flat default hold.
 */
export interface EndpointPricing {
  unitPriceMicro: number | null;
  unit: string | null;
  holdMicro: number;
}

// $0.10
export const DEFAULT_HOLD_MICRO = 100_000;
// $0.01
const MIN_HOLD_MICRO = 10_000;
// $5.00
const MAX_HOLD_MICRO = 5 * MICRO_PER_USD;

const clampHold = (micro: number): number =>
  Math.min(MAX_HOLD_MICRO, Math.max(MIN_HOLD_MICRO, micro));

// Per-isolate cache. Endpoint prices move rarely; an hour of staleness only
// shifts when a price change starts applying to settles.
const CACHE_TTL_MS = 60 * 60 * 1000;
const cache = new Map<string, { value: EndpointPricing; expiresAt: number }>();

type FetchJson = (input: {
  method: "GET" | "POST";
  path: string;
  query?: Record<string, string>;
  body?: JsonValue;
}) => Promise<JsonValue>;

// Entries that don't fit (wrong types, non-finite price) collapse to null and
// are skipped, matching a per-entry "ignore what we can't read" posture —
// pricing responses must never make a submit throw.
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

const readUnitPrice = (
  payload: JsonValue,
  endpointId: string,
): { unitPriceMicro: number; unit: string | null } | null => {
  const parsed = pricingPayload.safeParse(payload);
  if (!parsed.success) {
    return null;
  }
  for (const price of parsed.data.prices) {
    if (price === null || price.endpoint_id !== endpointId) {
      continue;
    }
    return {
      unit: price.unit,
      unitPriceMicro: usdToMicro(price.unit_price),
    };
  }
  return null;
};

const estimatePayload = z.looseObject({ total_cost: z.number().finite() });

const readEstimate = (payload: JsonValue): number | null => {
  const parsed = estimatePayload.safeParse(payload);
  if (!parsed.success) {
    return null;
  }
  return parsed.data.total_cost > 0 ? usdToMicro(parsed.data.total_cost) : null;
};

/**
 * Resolve pricing for `endpointId` via the platform API. `fetchJson` is the
 * caller's credentialed platform-API transport (the generate router already
 * has one); this module owns only the shapes and the cache.
 */
export const getEndpointPricing = async (
  endpointId: string,
  fetchJson: FetchJson,
): Promise<EndpointPricing> => {
  const cached = cache.get(endpointId);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.value;
  }

  const [priceResult, estimateResult] = await Promise.allSettled([
    fetchJson({
      method: "GET",
      path: "/v1/models/pricing",
      query: { endpoint_id: endpointId },
    }),
    fetchJson({
      body: {
        endpoints: { [endpointId]: { call_quantity: 1 } },
        estimate_type: "historical_api_price",
      },
      method: "POST",
      path: "/v1/models/pricing/estimate",
    }),
  ]);

  const price =
    priceResult.status === "fulfilled" ? readUnitPrice(priceResult.value, endpointId) : null;
  const estimateMicro =
    estimateResult.status === "fulfilled" ? readEstimate(estimateResult.value) : null;

  const holdBasis = estimateMicro ?? price?.unitPriceMicro ?? null;
  const value: EndpointPricing = {
    holdMicro: holdBasis === null ? DEFAULT_HOLD_MICRO : clampHold(holdBasis),
    unit: price?.unit ?? null,
    unitPriceMicro: price?.unitPriceMicro ?? null,
  };

  // Don't cache total failures — the next submit should retry the lookup.
  if (price !== null || estimateMicro !== null) {
    cache.set(endpointId, { expiresAt: Date.now() + CACHE_TTL_MS, value });
  }
  return value;
};
