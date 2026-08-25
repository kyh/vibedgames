import type { ORPCContext } from "@repo/api/orpc";
import { appRouter } from "@repo/api";
import { MAX_RPC_BODY_BYTES } from "@repo/api/generate/limits";
import { onError, ORPCError } from "@orpc/server";
import { BodyLimitPlugin, RPCHandler } from "@orpc/server/fetch";
import { BatchHandlerPlugin, SimpleCsrfProtectionHandlerPlugin } from "@orpc/server/plugins";

// No CORS headers: every client reaches this route same-origin (the web app is
// served from it) or from a non-browser runtime that doesn't enforce CORS (the
// CLI). SimpleCsrfProtection requires an `x-csrf-token` header, which the
// paired link plugin sends and an HTML form cannot set — and a cross-origin
// fetch that tries to set it needs a preflight this route never answers. That
// keeps a cross-origin multipart form POST from riding the session cookie into
// a mutation. Adding permissive CORS headers here would let the preflight
// succeed and undo it.

// Codes that are ordinary control flow rather than incidents: an expired
// session hitting `protectedProcedure`, a non-admin hitting `adminProcedure`,
// a zod rejection, `auth.cliPoll` reporting "not confirmed yet" to a CLI that
// polls it in a loop, an admin re-using an existing invite code, better-auth's
// rate limiter (10 req/60s), and requests the transport plugins turn away
// (header-less CSRF probes, GETs on POST-only procedures, oversized bodies).
// Observability is enabled on this Worker, so logging these is billable noise
// that buries the real errors.
//
// PRECONDITION_FAILED and BAD_GATEWAY stay out deliberately: the first means
// FAL_API_KEY is missing from the deploy, the second that fal answered with
// something unusable. Both are the operator's problem, and the log line is how
// they find out.
const EXPECTED_ERROR_CODES = new Set([
  "UNAUTHORIZED",
  "FORBIDDEN",
  "NOT_FOUND",
  "BAD_REQUEST",
  "CONFLICT",
  "TOO_MANY_REQUESTS",
  "CSRF_TOKEN_MISMATCH",
  "METHOD_NOT_SUPPORTED",
  "PAYLOAD_TOO_LARGE",
]);

const handler = new RPCHandler(appRouter, {
  plugins: [
    new SimpleCsrfProtectionHandlerPlugin(),
    // Paired with the link's `BatchLinkPlugin`. It re-dispatches each item
    // through this same `handle()` call, so a batch costs one context build
    // and one session read for the whole page, not one per query.
    new BatchHandlerPlugin(),
    // The Worker memory ceiling is 128 MB and JSON.parse holds the raw bytes,
    // the decoded string, and the parsed object in memory at once, so reject
    // pathologically large bodies up front rather than relying on the
    // per-field caps inside the procedures.
    new BodyLimitPlugin({ maxBodySize: MAX_RPC_BODY_BYTES }),
  ],
  interceptors: [
    onError((error) => {
      if (error instanceof ORPCError && EXPECTED_ERROR_CODES.has(error.code)) return;
      console.error(">>> oRPC Error", error);
    }),
  ],
});

export async function handleRpcRequest(request: Request, context: ORPCContext): Promise<Response> {
  const { response } = await handler.handle(request, {
    prefix: "/api/orpc",
    context,
  });
  return response ?? new Response("Not found", { status: 404 });
}
