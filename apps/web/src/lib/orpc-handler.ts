import type { ORPCContext } from "@repo/api/orpc";
import { appRouter } from "@repo/api";
import { MAX_RPC_BODY_BYTES } from "@repo/api/generate/limits";
import { COMMON_ERROR_STATUS_MAP, onError, ORPCError } from "@orpc/server";
import { RPCHandler } from "@orpc/server/fetch";
import { BatchHandlerPlugin, RequestLimitHandlerPlugin } from "@orpc/server/plugins";

// No CORS headers, and none belong here: every client reaches this route
// same-origin (the web app is served from it) or from a non-browser runtime
// that doesn't enforce CORS (the CLI). Credentialed CORS headers would hand a
// cross-origin page authenticated access. GET, the one method a cookie-bearing
// navigation can reach, is refused by the handler's default `allowMethods`.

// An unknown code has no entry and falls back to 500, so a code this app adds
// later logs by default rather than disappearing.
const ERROR_STATUS = new Map<string, number>(Object.entries(COMMON_ERROR_STATUS_MAP));

// `pickFalKey` answers 412 because that is the honest code for the caller, but
// a missing FAL_API_KEY is the deploy's fault, not the request's.
const FAULTS_BELOW_500 = new Set(["PRECONDITION_FAILED"]);

const handler = new RPCHandler(appRouter, {
  plugins: [
    // Paired with the link's `BatchLinkPlugin`. It re-dispatches each item
    // through this same `handle()` call, so a batch costs one context build
    // and one session read for the whole page, not one per query.
    new BatchHandlerPlugin(),
    // The Worker memory ceiling is 128 MB and JSON.parse holds the raw bytes,
    // the decoded string, and the parsed object in memory at once, so reject
    // pathologically large bodies up front rather than relying on the
    // per-field caps inside the procedures.
    new RequestLimitHandlerPlugin({ maxBodySize: MAX_RPC_BODY_BYTES }),
  ],
  clientInterceptors: [
    onError((error) => {
      if (error instanceof ORPCError) {
        // Observability is billable on this Worker. A procedure answering
        // deliberately — an expired session, a zod rejection, `auth.cliPoll`
        // telling a polling CLI "not confirmed yet" — would bury the real
        // errors, so only a fault gets a line.
        const status = ERROR_STATUS.get(error.code) ?? 500;
        if (status < 500 && !FAULTS_BELOW_500.has(error.code)) return;
      }
      console.error(">>> oRPC Error", error);
    }),
  ],
});

/**
 * SameSite=Lax on the session cookie is not the whole story here, because
 * `SameSite` keys on *site*, not origin: `{slug}.vibedgames.com` — where users
 * run arbitrary uploaded code — is same-site with `vibedgames.com`, so a plain
 * `<form method=POST>` on a game page rides the session cookie into a mutation
 * with no preflight to stop it. Browsers set `Origin` on every POST and page
 * script cannot forge it, so an `Origin` that isn't ours is the signal.
 *
 * Absent `Origin` passes: that is the CLI and other non-browser callers, which
 * authenticate by bearer token rather than by an ambiently-attached cookie and
 * so have nothing to forge.
 *
 * Checked here rather than in a handler plugin so it runs once on the real
 * request, before `BatchHandlerPlugin` fans a batch out into sub-requests
 * whose headers the client authored.
 */
function isCrossOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  return origin !== null && origin !== new URL(request.url).origin;
}

export async function handleRpcRequest(request: Request, context: ORPCContext): Promise<Response> {
  if (isCrossOrigin(request)) {
    return new Response("Cross-origin request blocked.", { status: 403 });
  }

  const { response } = await handler.handle(request, {
    prefix: "/api/orpc",
    context,
  });
  return response ?? new Response("Not found", { status: 404 });
}
