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
export type EndpointPricing = {
  unitPriceMicro: number | null;
  unit: string | null;
  holdMicro: number;
};

export const DEFAULT_HOLD_MICRO = 100_000; // $0.10
const MIN_HOLD_MICRO = 10_000; // $0.01
const MAX_HOLD_MICRO = 5 * MICRO_PER_USD; // $5.00

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
  body?: unknown;
}) => Promise<unknown>;

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const readUnitPrice = (
  payload: unknown,
  endpointId: string,
): { unitPriceMicro: number; unit: string | null } | null => {
  if (!isRecord(payload) || !Array.isArray(payload.prices)) return null;
  for (const price of payload.prices) {
    if (!isRecord(price)) continue;
    if (price.endpoint_id !== endpointId) continue;
    if (typeof price.unit_price !== "number" || !Number.isFinite(price.unit_price)) continue;
    return {
      unitPriceMicro: usdToMicro(price.unit_price),
      unit: typeof price.unit === "string" ? price.unit : null,
    };
  }
  return null;
};

const readEstimate = (payload: unknown): number | null => {
  if (!isRecord(payload)) return null;
  if (typeof payload.total_cost !== "number" || !Number.isFinite(payload.total_cost)) return null;
  return payload.total_cost > 0 ? usdToMicro(payload.total_cost) : null;
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
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  const [priceResult, estimateResult] = await Promise.allSettled([
    fetchJson({
      method: "GET",
      path: "/v1/models/pricing",
      query: { endpoint_id: endpointId },
    }),
    fetchJson({
      method: "POST",
      path: "/v1/models/pricing/estimate",
      body: {
        estimate_type: "historical_api_price",
        endpoints: { [endpointId]: { call_quantity: 1 } },
      },
    }),
  ]);

  const price =
    priceResult.status === "fulfilled" ? readUnitPrice(priceResult.value, endpointId) : null;
  const estimateMicro =
    estimateResult.status === "fulfilled" ? readEstimate(estimateResult.value) : null;

  const holdBasis = estimateMicro ?? price?.unitPriceMicro ?? null;
  const value: EndpointPricing = {
    unitPriceMicro: price?.unitPriceMicro ?? null,
    unit: price?.unit ?? null,
    holdMicro: holdBasis === null ? DEFAULT_HOLD_MICRO : clampHold(holdBasis),
  };

  // Don't cache total failures — the next submit should retry the lookup.
  if (price !== null || estimateMicro !== null) {
    cache.set(endpointId, { value, expiresAt: Date.now() + CACHE_TTL_MS });
  }
  return value;
};
