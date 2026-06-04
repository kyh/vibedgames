// Endpoint-id aliasing.
//
// `vg media` is a generative-asset CLI. Most model endpoints live under a
// single default owner namespace, which is an implementation detail users
// shouldn't have to type or read. So the CLI speaks two forms:
//
//   - display form  — what we print and what authored examples use
//                     (`flux/dev`, `nano-banana-pro`)
//   - resolved form — what the upstream queue/platform APIs expect
//                     (`fal-ai/flux/dev`, `fal-ai/nano-banana-pro`)
//
// `resolveEndpointId` expands a display id to the resolved form before any
// request; `displayEndpointId` strips the default owner back off before any
// human-facing output. Ids owned by a *different* provider namespace
// (e.g. `openai/…`, `bytedance/…`) carry their owner explicitly and round-
// trip untouched in both directions.

const DEFAULT_OWNER = "fal-ai";
const DEFAULT_OWNER_PREFIX = `${DEFAULT_OWNER}/`;

// First path segments that already identify a fully-qualified endpoint, so
// `resolveEndpointId` must NOT prepend the default owner to them:
//
//   - the default owner itself (already qualified)
//   - `workflows` / `comfy` — top-level queue namespaces, user-scoped
//   - distinct provider namespaces the gateway hosts under their own name
//
// The provider list mirrors the owners actually referenced by the skills.
// It can be extended; either way the escape hatch is that a fully-qualified
// id (any of the forms below, including an explicit `fal-ai/…`) always
// passes through resolution unchanged.
const QUALIFIED_OWNERS = new Set<string>([
  DEFAULT_OWNER,
  "workflows",
  "comfy",
  "openai",
  "veed",
  "bytedance",
  "alibaba",
  "xai",
  "moonvalley",
]);

function trim(id: string): string {
  return id.replace(/^\/+|\/+$/g, "");
}

/**
 * Expand a display id to the form the upstream APIs expect. Ids that are
 * already owner-qualified (default owner, queue namespace, or a known
 * provider) are returned unchanged; everything else is assumed to belong to
 * the default owner and gets the prefix.
 */
export function resolveEndpointId(id: string): string {
  const clean = trim(id);
  if (clean.length === 0) return clean;
  const owner = clean.split("/", 1)[0] ?? "";
  return QUALIFIED_OWNERS.has(owner) ? clean : `${DEFAULT_OWNER_PREFIX}${clean}`;
}

/**
 * Strip the default owner prefix for human-facing output — but only when
 * the prefix is redundant. The default owner also hosts sub-namespaces
 * whose name collides with a standalone provider/namespace (e.g. both
 * `fal-ai/bytedance/…` and a top-level `bytedance/…` exist). Stripping the
 * prefix there would be lossy — `resolveEndpointId` couldn't tell the two
 * apart and wouldn't add it back — so those ids keep their owner. The
 * guarantee is `resolveEndpointId(displayEndpointId(id)) === id`.
 */
export function displayEndpointId(id: string): string {
  const clean = trim(id);
  if (!clean.startsWith(DEFAULT_OWNER_PREFIX)) return clean;
  const rest = clean.slice(DEFAULT_OWNER_PREFIX.length);
  const restOwner = rest.split("/", 1)[0] ?? "";
  return QUALIFIED_OWNERS.has(restOwner) ? clean : rest;
}
