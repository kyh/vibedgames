import { setTimeout as sleep } from "node:timers/promises";
import { consola } from "consola";

import type { createClient } from "./api.js";
import { isJsonNumber, isJsonObject, isJsonString } from "./types.js";
import type { JsonValue } from "./types.js";

type Client = ReturnType<typeof createClient>;

const POLL_INTERVAL_MS = 2000;
const POLL_TIMEOUT_MS = 30 * 60 * 1000;

const pickErrorReason = (value: JsonValue) => {
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
 * Poll `generate.status` from the client side until the job reaches a
 * terminal status, then fetch the result. A Worker request cannot wait
 * minutes, so the loop lives here and each poll is one short call.
 */
export const waitForCompletion = async (
  client: Client,
  endpoint_id: string,
  request_id: string,
  opts: { quiet: boolean },
) => {
  const job = { endpoint_id, request_id };
  const deadline = Date.now() + POLL_TIMEOUT_MS;

  const poll: (lastStatus: string | undefined) => Promise<void> = async (lastStatus) => {
    if (Date.now() > deadline) {
      throw new Error(
        `Job did not complete within ${POLL_TIMEOUT_MS}ms ` +
          `(endpoint=${endpoint_id} request_id=${request_id}). ` +
          `Use \`vg generate status ${endpoint_id} ${request_id} --result\` to check later.`,
      );
    }

    const raw = await client.generate.status({ ...job, action: "status" });

    const status = isJsonObject(raw) && isJsonString(raw.status) ? raw.status : "UNKNOWN";
    const upper = status.toUpperCase();

    if (!opts.quiet && upper !== lastStatus) {
      const queuePos =
        isJsonObject(raw) && isJsonNumber(raw.queue_position) ? raw.queue_position : null;

      const tag =
        queuePos === null ? upper.toLowerCase() : `${upper.toLowerCase()} (queue ${queuePos})`;

      consola.log(`  ${tag}`);
    }

    if (upper === "COMPLETED") {
      return;
    }

    if (upper === "FAILED" || upper === "CANCELLED") {
      const reason = pickErrorReason(raw);
      throw new Error(
        reason !== null && reason !== ""
          ? `Job ${upper.toLowerCase()}: ${reason}`
          : `Job ${upper.toLowerCase()}`,
      );
    }

    await sleep(POLL_INTERVAL_MS);
    await poll(upper);
  };

  await poll(undefined);

  const result = await client.generate.status({ ...job, action: "result" });

  return { request_id, result };
};
