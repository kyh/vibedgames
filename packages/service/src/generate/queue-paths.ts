/** Strip leading/trailing slashes so an endpoint id splices into a URL path cleanly. */
export const endpointPath = (endpointId: string): string =>
  endpointId.replaceAll(/^\/+|\/+$/gu, "");

// fal's queue accepts the full endpoint id (including any model subpath,
// e.g. `fal-ai/flux/schnell`) on submit, but the status/result/cancel
// routes are keyed by the owning *application* id only (`fal-ai/flux`).
// Passing the subpath to those routes returns 405. `workflows`/`comfy`
// ids carry the namespace as a leading segment, so their app id is three
// segments deep.
const QUEUE_APP_NAMESPACES = new Set(["workflows", "comfy"]);

export const queueAppId = (endpointId: string): string => {
  const parts = endpointPath(endpointId).split("/").filter(Boolean);
  const take = QUEUE_APP_NAMESPACES.has(parts[0] ?? "") ? 3 : 2;
  return parts.slice(0, take).join("/");
};

/** Queue path for one job; `suffix` picks status, cancel or (empty) the result. */
export const requestPath = (
  endpointId: string,
  requestId: string,
  suffix: "" | "/status" | "/cancel",
): string => `/${queueAppId(endpointId)}/requests/${requestId}${suffix}`;
