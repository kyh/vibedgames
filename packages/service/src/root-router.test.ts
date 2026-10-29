import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { Credential } from "@repo/contract/base";
import { getRequiredCredential, getRequiredScope } from "@repo/contract/base";
import { OAUTH_SCOPES } from "@repo/contract/auth/oauth-scopes";
import { createDb } from "@repo/db/drizzle-client";
import type { AnyProcedure } from "@orpc/server";
import { call, getRouter, ORPCError, Procedure, walkProcedureContractsSync } from "@orpc/server";

import { API_KEY_SESSION_PREFIX } from "./auth/api-key";
import { OAUTH_SESSION_PREFIX } from "./auth/oauth-token";
import { createAuth } from "./auth/auth";
import type { ORPCContext } from "./orpc";
import { appRouter } from "./root-router";

/**
 * Every router applies `requireSession`, `rejectApiKey` and `requireAdmin` on
 * the implementer, so they answer before the input schema runs: an anonymous
 * caller sending garbage hears UNAUTHORIZED rather than a BAD_REQUEST that
 * describes the schema, and an API key on a session-only procedure hears
 * FORBIDDEN. Nothing makes a router apply what its contract base calls for, so
 * this walks every procedure in `appRouter` and holds it to the credential its
 * base records: a router that forgets a middleware, or moves one onto a
 * procedure (where it runs after validation), fails here by name. Every call
 * sends input no schema accepts. A refusal comes before the handler; a caller
 * let through to a procedure that takes no input runs its handler, which finds
 * the database unreachable.
 */

const unavailable = (): never => {
  throw new Error("the database is not reachable in this test");
};

const db = createDb({
  batch: unavailable,
  dump: unavailable,
  exec: unavailable,
  prepare: unavailable,
  withSession: unavailable,
});

const auth = createAuth({ baseURL: "http://localhost:3000", db, secret: "test-secret" });

const now = new Date();

const sessionFor = (opts: {
  role: string;
  token: string;
}): NonNullable<ORPCContext["session"]> => ({
  session: {
    createdAt: now,
    expiresAt: now,
    id: "session-1",
    ipAddress: null,
    token: opts.token,
    updatedAt: now,
    userAgent: null,
    userId: "user-1",
  },
  user: {
    banned: false,
    createdAt: now,
    email: "user@vibedgames.com",
    emailVerified: true,
    id: "user-1",
    name: "User",
    role: opts.role,
    updatedAt: now,
  },
});

const contextAs = (
  session: ORPCContext["session"],
  oauthScopes: readonly string[] | null = null,
): ORPCContext => ({
  auth,
  billing: undefined,
  db,
  decision: undefined,
  headers: new Headers(),
  media: undefined,
  oauthScopes,
  productionURL: undefined,
  r2: undefined,
  session,
  signing: undefined,
});

type Caller = "anonymous" | "apiKey" | "oauth" | "oauthUnscoped" | "member" | "admin";

const oauthSession = sessionFor({ role: "admin", token: `${OAUTH_SESSION_PREFIX}token-1` });

const callers: [Caller, ORPCContext][] = [
  ["anonymous", contextAs(null)],
  // An admin's key: the role check would let it through, so only the key
  // check can refuse it.
  ["apiKey", contextAs(sessionFor({ role: "admin", token: `${API_KEY_SESSION_PREFIX}key-1` }))],
  // A connected app's access token granted every scope: held to the same
  // line as a key.
  ["oauth", contextAs(oauthSession, ["profile", ...Object.keys(OAUTH_SCOPES)])],
  // One granted none of them reaches nothing a scope guards.
  ["oauthUnscoped", contextAs(oauthSession, [])],
  ["member", contextAs(sessionFor({ role: "user", token: "session-token" }))],
  ["admin", contextAs(sessionFor({ role: "admin", token: "session-token" }))],
];

// What `rejectApiKey` says, which tells its 403 from the role check's.
const API_KEY_REFUSAL = /interactive login, not an API key/u;
// What `requireSession` says to an access token without the procedure's scope.
const SCOPE_REFUSAL = /^insufficient_scope/u;

const REFUSALS = new Set(["UNAUTHORIZED", "FORBIDDEN", "FORBIDDEN (API key)", "FORBIDDEN (scope)"]);

/** Who each credential turns away, and how; everyone else gets through. */
const refused: Record<Credential, Partial<Record<Caller, string>>> = {
  admin: {
    anonymous: "UNAUTHORIZED",
    apiKey: "FORBIDDEN (API key)",
    member: "FORBIDDEN",
    oauth: "FORBIDDEN (API key)",
    oauthUnscoped: "FORBIDDEN (API key)",
  },
  any: { anonymous: "UNAUTHORIZED", oauthUnscoped: "FORBIDDEN (scope)" },
  none: {},
  session: {
    anonymous: "UNAUTHORIZED",
    apiKey: "FORBIDDEN (API key)",
    oauth: "FORBIDDEN (API key)",
    oauthUnscoped: "FORBIDDEN (API key)",
  },
};

// Every input schema is an object.
const GARBAGE = "not an input";

/** How a call ended: the oRPC code it was answered with, or how else it ended. */
const outcomeOf = async (procedure: AnyProcedure, context: ORPCContext): Promise<string> => {
  try {
    await call(procedure, GARBAGE, { context });
    return "answered";
  } catch (error) {
    if (!(error instanceof ORPCError)) {
      return "failed outside oRPC";
    }
    if (error.code === "FORBIDDEN" && API_KEY_REFUSAL.test(error.message)) {
      return "FORBIDDEN (API key)";
    }
    return error.code === "FORBIDDEN" && SCOPE_REFUSAL.test(error.message)
      ? "FORBIDDEN (scope)"
      : error.code;
  }
};

interface Entry {
  name: string;
  credential: Credential | undefined;
  scope: string | undefined;
  takesInput: boolean;
  procedure: AnyProcedure | undefined;
}

const entries: Entry[] = [];
const lazyRouters = walkProcedureContractsSync(appRouter, (declared, path) => {
  const implemented = getRouter(appRouter, path);
  entries.push({
    credential: getRequiredCredential(declared),
    name: path.join("."),
    procedure: implemented instanceof Procedure ? implemented : undefined,
    scope: getRequiredScope(declared),
    takesInput: (declared["~orpc"].inputSchemas ?? []).length > 0,
  });
});

describe("procedure authorization", () => {
  test("reaches every procedure", () => {
    assert.deepEqual(lazyRouters, [], "a lazy router's procedures would go unchecked");
    assert.ok(entries.some((entry) => entry.name === "admin.credits.grant"));
    for (const { name, credential, procedure } of entries) {
      assert.ok(credential, `${name} is not built on a base from @repo/contract/base`);
      assert.ok(procedure, `${name} has no implementation in appRouter`);
    }
  });

  // An access token reaches exactly the procedures any credential may call,
  // so each of those names what a token needs; nothing else declares one.
  test("declares a scope on every procedure an access token can reach", () => {
    for (const { name, credential, scope } of entries) {
      if (credential === "any") {
        assert.ok(scope, `${name} declares no scope; add requiresScope(...)`);
      } else {
        assert.equal(scope, undefined, `${name} declares a scope no access token can use`);
      }
    }
  });

  for (const { name, credential, takesInput, procedure } of entries) {
    test(`${name} answers each caller as its base (${credential}) declares`, async () => {
      assert.ok(credential && procedure);
      for (const [caller, context] of callers) {
        const outcome = await outcomeOf(procedure, context);
        const refusal: string | undefined = refused[credential][caller];
        if (refusal) {
          assert.equal(outcome, refusal, `${name} as ${caller}`);
        } else if (takesInput) {
          assert.equal(outcome, "BAD_REQUEST", `${name} as ${caller}`);
        } else {
          assert.ok(!REFUSALS.has(outcome), `${name} as ${caller} was refused: ${outcome}`);
        }
      }
    });
  }
});

// The consent page lists `email` apart from `profile`, and no scope grants
// the role, so an access token sees each only as far as its grant says.
describe("auth.me", () => {
  test("shows an access token the email only with the email scope, and never the role", async () => {
    const { me } = appRouter.auth;
    assert.deepEqual(await call(me, undefined, { context: contextAs(oauthSession, ["profile"]) }), {
      email: null,
      id: "user-1",
      name: "User",
      role: null,
    });
    const withEmail = await call(me, undefined, {
      context: contextAs(oauthSession, ["profile", "email"]),
    });
    assert.equal(withEmail.email, "user@vibedgames.com");
    assert.equal(withEmail.role, null);
    const admin = await call(me, undefined, {
      context: contextAs(sessionFor({ role: "admin", token: "session-token" })),
    });
    assert.equal(admin.email, "user@vibedgames.com");
    assert.equal(admin.role, "admin");
  });
});
