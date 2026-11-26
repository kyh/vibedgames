import { runInOrder } from "@repo/contract/run-in-order";
import assert from "node:assert/strict";
import { after, describe, test } from "node:test";
import type { Credential } from "@repo/contract/base";
import { getRequiredCredential, getRequiredScope } from "@repo/contract/base";
import { OAUTH_SCOPES } from "@repo/contract/auth/oauth-scopes";
import type { AnyProcedure } from "@orpc/server";
import { call, getRouter, ORPCError, Procedure, walkProcedureContractsSync } from "@orpc/server";

import { startD1 } from "./d1.test-utils";
import { API_KEY_SESSION_PREFIX } from "./identity/api-key";
import { OAUTH_SESSION_PREFIX } from "./identity/oauth-token";
import { createAuth } from "./identity/auth";
import type { ORPCContext } from "./orpc";
import { appRouter } from "./root-router";

const d1 = await startD1();

after(d1.close);

const { db } = d1;

const auth = createAuth({ baseURL: "http://localhost:3000", db, secret: "test-secret" });

const now = new Date();

const sessionFor: (opts: { role: string; token: string }) => NonNullable<ORPCContext["session"]> = (
  opts,
) => ({
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

const contextAs: (
  session: ORPCContext["session"],
  oauthScopes?: readonly string[] | null,
) => ORPCContext = (session, oauthScopes = null) => ({
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
  sendsEmail: false,
  signing: undefined,
});

type Caller = "anonymous" | "apiKey" | "oauth" | "oauthUnscoped" | "member" | "admin";

const oauthSession = sessionFor({ role: "admin", token: `${OAUTH_SESSION_PREFIX}token-1` });

const callers: [Caller, ORPCContext][] = [
  ["anonymous", contextAs(null)],
  ["apiKey", contextAs(sessionFor({ role: "admin", token: `${API_KEY_SESSION_PREFIX}key-1` }))],
  ["oauth", contextAs(oauthSession, ["profile", ...Object.keys(OAUTH_SCOPES)])],
  ["oauthUnscoped", contextAs(oauthSession, [])],
  ["member", contextAs(sessionFor({ role: "user", token: "session-token" }))],
  ["admin", contextAs(sessionFor({ role: "admin", token: "session-token" }))],
];

const API_KEY_REFUSAL = /interactive login, not an API key/u;

const REFUSALS = new Set(["UNAUTHORIZED", "FORBIDDEN", "FORBIDDEN (API key)", "FORBIDDEN (scope)"]);

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

const GARBAGE = "not an input";

const outcomeOf = async (procedure: AnyProcedure, context: ORPCContext) => {
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

    return error.code === "FORBIDDEN" && error.message.startsWith("insufficient_scope")
      ? "FORBIDDEN (scope)"
      : String(error.code);
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

  test("declares a scope on every procedure an access token can reach", () => {
    for (const { name, credential, scope } of entries) {
      if (credential === "any") {
        assert.ok(
          scope !== undefined && scope !== "",
          `${name} declares no scope; add requiresScope(...)`,
        );
      } else {
        assert.equal(scope, undefined, `${name} declares a scope no access token can use`);
      }
    }
  });

  for (const { name, credential, takesInput, procedure } of entries) {
    test(`${name} answers each caller as its base (${credential}) declares`, async () => {
      assert.ok(credential && procedure);

      await runInOrder(callers, async ([caller, context]) => {
        const outcome = await outcomeOf(procedure, context);
        const refusal: string | undefined = refused[credential][caller];

        if (refusal !== undefined && refusal !== "") {
          assert.equal(outcome, refusal, `${name} as ${caller}`);
        } else if (takesInput) {
          assert.equal(outcome, "BAD_REQUEST", `${name} as ${caller}`);
        } else {
          assert.ok(!REFUSALS.has(outcome), `${name} as ${caller} was refused: ${outcome}`);
        }
      });
    });
  }
});

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
