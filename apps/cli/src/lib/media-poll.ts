import consola from "consola";

import { forwardJson, type createClient } from "./api.js";
import { isJsonNumber, isJsonObject, isJsonString, type JsonValue } from "./types.js";

type Client = ReturnType<typeof createClient>;

// Strip leading/trailing slashes from a fal endpoint id so it can be
// spliced into a URL path without doubling separators.
export function endpointPath(endpointId: string): string {
  return endpointId.replace(/^\/+|\/+$/g, "");
}

// fal's queue accepts the full endpoint id (including any model subpath,
// e.g. `fal-ai/flux/schnell`) on submit, but the status/result/cancel
// routes are keyed by the owning *application* id only (`fal-ai/flux`).
// Passing the subpath to those routes returns 405. `workflows`/`comfy`
// ids carry the namespace as a leading segment, so their app id is three
// segments deep.
const QUEUE_APP_NAMESPACES = new Set(["workflows", "comfy"]);
export function queueAppId(endpointId: string): string {
  const parts = endpointPath(endpointId).split("/").filter(Boolean);
  const take = QUEUE_APP_NAMESPACES.has(parts[0] ?? "") ? 3 : 2;
  return parts.slice(0, take).join("/");
}

const POLL_INTERVAL_MS = 2_000;
// 30-minute ceiling on a sync run. Generous (this is the user's local
// CLI process, not a billed Worker) but bounded so a stuck IN_QUEUE
// job can't hang the CLI indefinitely. Long jobs should use --async.
const POLL_TIMEOUT_MS = 30 * 60 * 1000;

type CompletedResult = {
  request_id: string;
  result: JsonValue;
};

/**
 * Poll fal's queue from the client side until the job reaches a
 * terminal status, then fetch the result. The Worker isn't in the
 * loop — it's only along for each individual `generate.forward` hop.
 */
export async function waitForCompletion(
  client: Client,
  endpoint_id: string,
  request_id: string,
  opts: { quiet: boolean },
): Promise<CompletedResult> {
  const ep = queueAppId(endpoint_id);
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  let lastStatus: string | undefined;

  while (true) {
    if (Date.now() > deadline) {
      throw new Error(
        `Job did not complete within ${POLL_TIMEOUT_MS}ms ` +
          `(endpoint=${endpoint_id} request_id=${request_id}). ` +
          `Use \`vg generate status ${endpoint_id} ${request_id} --result\` to check later.`,
      );
    }
    const raw = await forwardJson(client, {
      target: "queue",
      method: "GET",
      path: `/${ep}/requests/${request_id}/status`,
    });
    const status = isJsonObject(raw) && isJsonString(raw.status) ? raw.status : "UNKNOWN";
    const upper = status.toUpperCase();
    if (!opts.quiet && upper !== lastStatus) {
      lastStatus = upper;
      const queuePos =
        isJsonObject(raw) && isJsonNumber(raw.queue_position) ? raw.queue_position : null;
      const tag =
        queuePos !== null ? `${upper.toLowerCase()} (queue ${queuePos})` : upper.toLowerCase();
      consola.log(`  ${tag}`);
    }
    if (upper === "COMPLETED") break;
    if (upper === "FAILED" || upper === "CANCELLED") {
      const reason = pickErrorReason(raw);
      throw new Error(
        reason ? `Job ${upper.toLowerCase()}: ${reason}` : `Job ${upper.toLowerCase()}`,
      );
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }

  const result = await forwardJson(client, {
    target: "queue",
    method: "GET",
    path: `/${ep}/requests/${request_id}`,
  });
  return { request_id, result };
}

function pickErrorReason(value: JsonValue): string | null {
  if (!isJsonObject(value)) return null;
  if (isJsonString(value.error) && value.error.length > 0) return value.error;
  if (isJsonString(value.detail) && value.detail.length > 0) return value.detail;
  if (isJsonObject(value.error) && isJsonString(value.error.message)) return value.error.message;
  if (isJsonObject(value.response)) return pickErrorReason(value.response);
  return null;
}
