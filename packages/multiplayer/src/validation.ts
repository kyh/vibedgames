/**
 * Two validation layers, split by where they can actually run:
 *
 * 1. STRUCTURAL (server + client): the party server is one shared deployment
 *    serving every game's rooms, so it can never run per-game schemas — it
 *    enforces game-agnostic shape limits instead (`findStructuralIssue`,
 *    `MAX_MESSAGE_BYTES`). These constants live here so the server and SDK
 *    agree on the same limits.
 *
 * 2. GAME SCHEMAS (client only): game authors know their state's shape, so
 *    they register schemas on `MultiplayerClient` via `schemas` — validated
 *    before send (fail fast on your own bugs) and on receive (drop other
 *    clients' malformed data). Schemas use the Standard Schema interface
 *    (https://standardschema.dev), so zod v3.24+, valibot, arktype, or any
 *    compliant validator plugs in without this package depending on one.
 */

/**
 * Minimal vendored Standard Schema v1 interface (the spec is designed to be
 * copied, not depended on). Any library exposing `~standard` satisfies it.
 */
export type StandardSchemaV1<Input = unknown, Output = Input> = {
  readonly "~standard": {
    readonly version: 1;
    readonly vendor: string;
    readonly validate: (
      value: unknown,
    ) => StandardSchemaResult<Output> | Promise<StandardSchemaResult<Output>>;
  };
};

export type StandardSchemaIssue = {
  readonly message: string;
  readonly path?: ReadonlyArray<PropertyKey | { readonly key: PropertyKey }> | undefined;
};

export type StandardSchemaResult<Output> =
  | { readonly value: Output; readonly issues?: undefined }
  | { readonly issues: ReadonlyArray<StandardSchemaIssue> };

/**
 * Ceiling on a single websocket message, in UTF-16 code units (≈ bytes for
 * ASCII-heavy JSON). Matches Cloudflare's 1 MiB websocket frame limit — a
 * message this large would be dropped by the platform anyway, so the server
 * refuses it explicitly instead of half-processing it.
 */
export const MAX_MESSAGE_BYTES = 1_048_576;

/**
 * Maximum nesting depth for shared/player state patches. Real game state is
 * a few levels deep; hundreds signal either a cycle escaping into JSON or a
 * deliberately pathological payload built to stack-overflow naive walkers.
 */
export const MAX_STATE_DEPTH = 32;

/** Keys that could poison prototypes when patches are merged downstream. */
const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

// This runs on every state/player patch (the server's per-tick hot path), so
// it iterates keys without the tuple-array allocations of Object.entries and
// never recurses into primitives — a big array of numbers costs one typeof
// per element, keeping the walk proportional to container count, not payload
// size. The 1 MiB message cap bounds total work.
const walk = (value: unknown, depth: number): string | null => {
  if (depth > MAX_STATE_DEPTH) return `nesting exceeds ${MAX_STATE_DEPTH} levels`;
  if (Array.isArray(value)) {
    for (const item of value) {
      if (typeof item !== "object" || item === null) continue;
      const issue = walk(item, depth + 1);
      if (issue) return issue;
    }
    return null;
  }
  if (isRecord(value)) {
    for (const key in value) {
      if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
      if (FORBIDDEN_KEYS.has(key)) return `forbidden key "${key}"`;
      const child = value[key];
      if (typeof child !== "object" || child === null) continue;
      const issue = walk(child, depth + 1);
      if (issue) return issue;
    }
  }
  return null;
};

/**
 * Game-agnostic structural check for a state patch: must be a plain object
 * (a string/array root would spread index keys into room state), bounded in
 * depth, and free of prototype-polluting keys. Returns a human-readable issue
 * or null when the patch is acceptable. The party server runs this on every
 * `state_patch` / `player_state_patch` before merging.
 */
export const findStructuralIssue = (data: unknown): string | null => {
  if (!isRecord(data)) return "patch must be a plain object";
  return walk(data, 1);
};

export type SchemaViolation = {
  /** Which registered schema flagged the data. */
  channel: "sharedState" | "playerState";
  /** `outgoing` = blocked before send (local bug); `incoming` = dropped on receive. */
  direction: "outgoing" | "incoming";
  /** Player id the data came from, when known (incoming player state). */
  from?: string;
  issues: ReadonlyArray<StandardSchemaIssue>;
  /** The full candidate state that failed (post-merge, not the raw patch). */
  data: Record<string, unknown>;
};

export type MultiplayerSchemas = {
  /**
   * Validated against the FULL shared state after a patch merges (never a
   * partial patch), so write it to describe the whole object. States start
   * empty, so empty objects bypass validation — model required fields
   * accordingly or seed them via `initialState`.
   */
  sharedState?: StandardSchemaV1<unknown, Record<string, unknown>>;
  /** Validated against a single player's full state. Same empty-object bypass. */
  playerState?: StandardSchemaV1<unknown, Record<string, unknown>>;
  /** Observe violations (metrics, dev overlays). Default logs a console.warn. */
  onViolation?: (violation: SchemaViolation) => void;
};
