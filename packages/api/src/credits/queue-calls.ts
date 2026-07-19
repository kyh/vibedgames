/**
 * Classify a `generate.forward` queue hop for credit accounting. Mirrors the
 * fal queue URL shape the CLI builds (see `apps/cli/src/lib/media-poll.ts`):
 *
 *   POST /{endpoint...}                      submit (bills the caller)
 *   GET  /{app...}/requests/{rid}/status     status poll
 *   GET  /{app...}/requests/{rid}            result fetch (carries
 *                                            x-fal-billable-units)
 *   PUT  /{app...}/requests/{rid}/cancel     cancel
 *
 * Anything that doesn't match is `other` and costs nothing. Cancel is
 * deliberately NOT a release trigger — fal only cancels queued jobs and
 * confirms asynchronously, so the refund happens when a later status poll
 * reports CANCELLED.
 */
export type QueueCall =
  | { kind: "submit"; endpointId: string }
  | { kind: "status"; requestId: string }
  | { kind: "result"; requestId: string }
  | { kind: "other" };

export const classifyQueueCall = (method: string, path: string): QueueCall => {
  const segments = path.split("/").filter((s) => s.length > 0);
  const requestsIdx = segments.indexOf("requests");

  if (requestsIdx === -1) {
    // A queue POST that isn't under /requests/ is a job submission. fal
    // endpoint ids are at least `{owner}/{model}` deep.
    if (method === "POST" && segments.length >= 2) {
      return { kind: "submit", endpointId: segments.join("/") };
    }
    return { kind: "other" };
  }

  const requestId = segments[requestsIdx + 1];
  if (requestId === undefined || requestsIdx === 0) return { kind: "other" };
  const tail = segments[requestsIdx + 2];

  if (method === "GET" && tail === "status") return { kind: "status", requestId };
  if (method === "GET" && tail === undefined) return { kind: "result", requestId };
  return { kind: "other" };
};

/** Terminal queue statuses that fal does not bill for. */
export const isUnbilledTerminalStatus = (status: unknown): boolean =>
  typeof status === "string" && ["FAILED", "CANCELLED"].includes(status.toUpperCase());

/**
 * Actual usage reported by fal on a result fetch. Units are fractional in
 * principle (priced units include "megapixels" and "1m tokens"), so parse as
 * float; absent or malformed means "no usage signal".
 */
export const parseBillableUnits = (headerValue: string | null): number | null => {
  // Blank counts as absent — Number("") is 0, which would read as an
  // authoritative "billed zero units" and refund the whole hold.
  if (headerValue === null || headerValue.trim().length === 0) return null;
  const units = Number(headerValue);
  return Number.isFinite(units) && units >= 0 ? units : null;
};
