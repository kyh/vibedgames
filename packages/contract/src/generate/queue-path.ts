export const endpointPath = (endpointId: string) => endpointId.replaceAll(/^\/+|\/+$/gu, "");

const QUEUE_APP_NAMESPACES = new Set(["workflows", "comfy"]);

export const queueAppId = (endpointId: string) => {
  const parts = endpointPath(endpointId).split("/").filter(Boolean);
  const take = QUEUE_APP_NAMESPACES.has(parts[0] ?? "") ? 3 : 2;

  return parts.slice(0, take).join("/");
};

/** The statuses a queued job ends in; any other is still queued or running. */
export const TERMINAL_STATUSES: ReadonlySet<string> = new Set(["COMPLETED", "FAILED", "CANCELLED"]);

/** Where a queued job's status, output (`""`) or cancel lives on the queue. */
export const jobPath = (endpointId: string, requestId: string, hop: "" | "/status" | "/cancel") =>
  `/${queueAppId(endpointId)}/requests/${requestId}${hop}`;
