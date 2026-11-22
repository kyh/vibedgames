import { defineMeta, oc } from "@orpc/contract";

import type { RequiredScope } from "./auth/oauth-scopes";
import { protectedProcedureSpec, publicProcedureSpec, sessionOnlyProcedureSpec } from "./openapi";

/**
 * Who may call a procedure: anyone, any credential (session cookie, session
 * token or API key), a real session, or an admin's real session. The OpenAPI
 * security says the first three; it has no way to say the last.
 */
export type Credential = "none" | "any" | "session" | "admin";

const [requires, getRequiredCredential] = defineMeta(
  "credential",
  (incoming: Credential) => incoming,
);

/** The credential a procedure's base declares; read by nothing at runtime. */
export { getRequiredCredential };

const [requiresScope, getRequiredScope] = defineMeta(
  "scope",
  (incoming: RequiredScope) => incoming,
);

/**
 * The scope an OAuth access token needs to call a procedure
 * (`auth/oauth-scopes.ts`). Every procedure an access token can reach, those
 * on `protectedBase`, declares one; @repo/service's `requireSession` refuses a
 * token without it.
 */
export { getRequiredScope, requiresScope };

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
