import consola from "consola";

import type { createClient } from "./api.js";
import { isRecord } from "./types.js";

type Client = ReturnType<typeof createClient>;

const POLL_INTERVAL_MS = 2_000;
// 30-minute ceiling on a sync run. Generous (this is the user's local
// CLI process, not a billed Worker) but bounded so a stuck IN_QUEUE
// job can't hang the CLI indefinitely. Long jobs should use --async.
const POLL_TIMEOUT_MS = 30 * 60 * 1000;

export type CompletedResult = {
  request_id: string;
  result: unknown;
};

/**
 * Poll fal's queue from the client side until the job reaches a
 * terminal status, then fetch the result. The Worker isn't in the
 * loop — it's only along for each individual `media.forward` hop.
 */
export async function waitForCompletion(
  client: Client,
  endpoint_id: string,
  request_id: string,
  opts: { quiet: boolean },
): Promise<CompletedResult> {
  const ep = endpoint_id.replace(/^\/+|\/+$/g, "");
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  let lastStatus: string | undefined;

  while (true) {
    if (Date.now() > deadline) {
      throw new Error(
        `fal job did not complete within ${POLL_TIMEOUT_MS}ms ` +
          `(endpoint=${endpoint_id} request_id=${request_id}). ` +
          `Use \`vg media status ${endpoint_id} ${request_id} --result\` to check later.`,
      );
    }
    const raw = await client.media.forward.mutate({
      target: "queue",
      method: "GET",
      path: `/${ep}/requests/${request_id}/status`,
    });
    const status = isRecord(raw) && typeof raw.status === "string" ? raw.status : "UNKNOWN";
    const upper = status.toUpperCase();
    if (!opts.quiet && upper !== lastStatus) {
      lastStatus = upper;
      const queuePos =
        isRecord(raw) && typeof raw.queue_position === "number" ? raw.queue_position : null;
      const tag = queuePos !== null ? `${upper.toLowerCase()} (queue ${queuePos})` : upper.toLowerCase();
      consola.log(`  ${tag}`);
    }
    if (upper === "COMPLETED") break;
    if (upper === "FAILED" || upper === "CANCELLED") {
      const reason = pickErrorReason(raw);
      throw new Error(
        reason ? `fal job ${upper.toLowerCase()}: ${reason}` : `fal job ${upper.toLowerCase()}`,
      );
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }

  const result = await client.media.forward.mutate({
    target: "queue",
    method: "GET",
    path: `/${ep}/requests/${request_id}`,
  });
  return { request_id, result };
}

function pickErrorReason(value: unknown): string | null {
  if (!isRecord(value)) return null;
  if (typeof value.error === "string" && value.error.length > 0) return value.error;
  if (typeof value.detail === "string" && value.detail.length > 0) return value.detail;
  if (isRecord(value.error) && typeof value.error.message === "string") return value.error.message;
  if (isRecord(value.response)) return pickErrorReason(value.response);
  return null;
}
