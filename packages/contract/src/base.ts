import { defineMeta, oc } from "@orpc/contract";

import { protectedProcedureSpec, publicProcedureSpec, sessionOnlyProcedureSpec } from "./openapi";

/**
 * Each base declares what its procedures promise in the OpenAPI document; the
 * middleware that keeps the promise is @repo/service's, applied on the
 * implementer so it runs before input validation. Nothing ties the two
 * together at compile time — a procedure on `sessionOnlyBase` whose router
 * skips `rejectApiKey` documents a 403 it never sends — so each base also
 * records its credential on every procedure built from it, and the service's
 * `root-router.test.ts` holds every procedure's router to it.
 */

/**
 * Who may call a procedure: anyone, any credential (session cookie, session
 * token or API key), a real session, or an admin's real session. The OpenAPI
 * security says the first three; it has no way to say the last.
 */
export type Credential = "none" | "any" | "session" | "admin";

const [requires, getRequiredCredential] = defineMeta(
  "credential",
  (incoming: Credential): Credential => incoming,
);

/** The credential a procedure's base declares; read by nothing at runtime. */
export { getRequiredCredential };

/** No credentials. Implementations use `os.<feature>.<proc>` directly. */
export const publicBase = oc.meta(publicProcedureSpec, requires("none"));

/** Any of the three credentials. Implementers apply `os.<feature>.use(requireSession)`. */
export const protectedBase = publicBase.meta(protectedProcedureSpec, requires("any"));

/** A real session; an API key is refused. Implementers add `.use(rejectApiKey)` after `requireSession`. */
export const sessionOnlyBase = protectedBase.meta(sessionOnlyProcedureSpec, requires("session"));

/**
 * The admin role on a real session. It adds no OpenAPI metadata: the role
 * check answers with the 403 `sessionOnlyBase` already declares. Implementers
 * add `.use(requireAdmin)` after `rejectApiKey`.
 */
export const adminBase = sessionOnlyBase.meta(requires("admin"));
