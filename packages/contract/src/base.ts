import { oc } from "@orpc/contract";

import { protectedProcedureSpec, publicProcedureSpec, sessionOnlyProcedureSpec } from "./openapi";

/**
 * Each base declares what its procedures promise in the OpenAPI document; the
 * middleware that keeps the promise is @repo/service's, applied on the
 * implementer so it runs before input validation. Nothing ties the two
 * together at compile time — a procedure on `sessionOnlyBase` whose router
 * skips `rejectApiKey` documents a 403 it never sends — so the service's
 * `root-router.test.ts` exercises each pairing.
 */

/** No credentials. Implementations use `os.<feature>.<proc>` directly. */
export const publicBase = oc.meta(publicProcedureSpec);

/** Any of the three credentials. Implementers apply `os.<feature>.use(requireSession)`. */
export const protectedBase = publicBase.meta(protectedProcedureSpec);

/** A real session; an API key is refused. Implementers add `.use(rejectApiKey)` after `requireSession`. */
export const sessionOnlyBase = protectedBase.meta(sessionOnlyProcedureSpec);

/**
 * The admin role on a real session. It adds no metadata: the role check
 * answers with the 403 `sessionOnlyBase` already declares. Implementers add
 * `.use(requireAdmin)` after `rejectApiKey`.
 */
export const adminBase = sessionOnlyBase.meta();
