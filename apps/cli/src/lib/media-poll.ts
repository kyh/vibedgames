import type { RouterOutputs } from "@repo/api";
import consola from "consola";

import type { createClient } from "./api.js";

type Client = ReturnType<typeof createClient>;
type StatusOutput = RouterOutputs["media"]["status"];
type StatusPayload = Extract<StatusOutput, { action: "status" }>;
type ResultPayload = Extract<StatusOutput, { action: "result" }>;

const POLL_INTERVAL_MS = 2_000;
// 30-minute ceiling on a sync run. Generous (this is the user's local
// CLI process, not a billed Worker) but bounded so a stuck IN_QUEUE
// job can't hang the CLI indefinitely. Long jobs should use --async.
const POLL_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * Poll `media.status` from the client side until the queued job
 * reaches a terminal status, then fetch the result. Lives in the CLI
 * (not the Worker) so a long-running video/3D job doesn't pin a
 * Worker request — we ack the submit, return immediately, and the
 * client owns the wait.
 */
export async function waitForCompletion(
  client: Client,
  endpoint_id: string,
  request_id: string,
  opts: { quiet: boolean },
): Promise<ResultPayload> {
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
    const status = (await client.media.status.mutate({
      endpoint_id,
      request_id,
      action: "status",
    })) as StatusPayload;
    const upper = status.status.toUpperCase();
    if (!opts.quiet && upper !== lastStatus) {
      lastStatus = upper;
      const queue =
        "queue_position" in status && typeof status.queue_position === "number"
          ? ` (queue position ${status.queue_position})`
          : "";
      consola.log(`  ${upper.toLowerCase()}${queue}`);
    }
    if (upper === "COMPLETED") break;
    if (upper === "FAILED" || upper === "CANCELLED") {
      const reason =
        "error" in status && typeof status.error === "string" ? status.error : null;
      throw new Error(
        reason ? `fal job ${upper.toLowerCase()}: ${reason}` : `fal job ${upper.toLowerCase()}`,
      );
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  const result = await client.media.status.mutate({
    endpoint_id,
    request_id,
    action: "result",
  });
  if (result.action !== "result") {
    throw new Error("expected result payload from media.status with action=result");
  }
  return result;
}
