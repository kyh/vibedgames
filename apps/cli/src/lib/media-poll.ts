import { setTimeout as sleep } from "node:timers/promises";
import { consola } from "consola";

import type { createClient } from "./api.js";
import { isJsonNumber, isJsonObject, isJsonString } from "./types.js";
import type { JsonValue } from "./types.js";

type Client = ReturnType<typeof createClient>;

const POLL_INTERVAL_MS = 2000;
// 30-minute ceiling on a sync run. Generous (this is the user's local
// CLI process, not a billed Worker) but bounded so a stuck IN_QUEUE
// job can't hang the CLI indefinitely. Long jobs should use --async.
const POLL_TIMEOUT_MS = 30 * 60 * 1000;

interface CompletedResult {
  request_id: string;
  result: JsonValue;
}

const pickErrorReason = (value: JsonValue): string | null => {
  if (!isJsonObject(value)) {
    return null;
  }
  if (isJsonString(value.error) && value.error.length > 0) {
    return value.error;
  }
  if (isJsonString(value.detail) && value.detail.length > 0) {
    return value.detail;
  }
  if (isJsonObject(value.error) && isJsonString(value.error.message)) {
    return value.error.message;
  }
  if (isJsonObject(value.response)) {
    return pickErrorReason(value.response);
  }
  return null;
};
/**
 * Poll the job from the client side until it reaches a terminal status,
 * then fetch the result. The Worker isn't in the loop — each poll is one
 * `generate.status` call.
 */
export const waitForCompletion = async (
  client: Client,
  endpoint_id: string,
  request_id: string,
  opts: { quiet: boolean },
): Promise<CompletedResult> => {
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
    const raw = await client.generate.status({ endpointId: endpoint_id, requestId: request_id });
    const status = isJsonObject(raw) && isJsonString(raw.status) ? raw.status : "UNKNOWN";
    const upper = status.toUpperCase();
    if (!opts.quiet && upper !== lastStatus) {
      lastStatus = upper;
      const queuePos =
        isJsonObject(raw) && isJsonNumber(raw.queue_position) ? raw.queue_position : null;
      const tag =
        queuePos === null ? upper.toLowerCase() : `${upper.toLowerCase()} (queue ${queuePos})`;
      consola.log(`  ${tag}`);
    }
    if (upper === "COMPLETED") {
      break;
    }
    if (upper === "FAILED" || upper === "CANCELLED") {
      const reason = pickErrorReason(raw);
      throw new Error(
        reason ? `Job ${upper.toLowerCase()}: ${reason}` : `Job ${upper.toLowerCase()}`,
      );
    }
    await sleep(POLL_INTERVAL_MS);
  }

  const result = await client.generate.result({ endpointId: endpoint_id, requestId: request_id });
  return { request_id, result };
};
