import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createDb } from "@repo/db/drizzle-client";
import { createRouterClient } from "@orpc/server";

import { API_KEY_SESSION_PREFIX } from "./auth/api-key";
import { createAuth } from "./auth/auth";
import type { ORPCContext } from "./orpc";
import { appRouter } from "./root-router";

/**
 * Every router applies `requireSession`, `rejectApiKey` and `requireAdmin` on
 * the implementer, so they answer before the input schema runs: an anonymous
 * caller sending garbage hears UNAUTHORIZED rather than a BAD_REQUEST that
 * describes the schema, and an API key on a session-only procedure hears
 * FORBIDDEN. Moved onto a procedure, a middleware would run after validation
 * and nothing else in the gate would notice. Each call below is refused
 * before its handler runs, so the database is never reached.
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

const callerAs = (session: ORPCContext["session"]) =>
  createRouterClient(appRouter, {
    context: {
      auth,
      db,
      decision: undefined,
      headers: new Headers(),
      media: undefined,
      productionURL: undefined,
      r2: undefined,
      session,
    },
  });

const anonymous = callerAs(null);
const member = callerAs(sessionFor({ role: "user", token: "session-token" }));
const administrator = callerAs(sessionFor({ role: "admin", token: "session-token" }));
const adminApiKey = callerAs(
  sessionFor({ role: "admin", token: `${API_KEY_SESSION_PREFIX}key-1` }),
);

const emptyDeploy = { files: [], slug: "" };
const badGrant = { amountUsd: 0, key: "not-a-uuid", userId: "" };
const grant = { amountUsd: 5, key: crypto.randomUUID(), userId: "user-2" };
const apiKeyRefusal = { code: "FORBIDDEN", message: /interactive login, not an API key/u };

describe("procedure authorization", () => {
  test("validates a public procedure's input for anyone", async () => {
    await assert.rejects(anonymous.waitlist.join({ email: "not-an-email" }), {
      code: "BAD_REQUEST",
    });
  });

  test("rejects unauthenticated callers before validating input", async () => {
    await assert.rejects(anonymous.deploy.create(emptyDeploy), { code: "UNAUTHORIZED" });
    await assert.rejects(anonymous.apiKeys.create({ name: "" }), { code: "UNAUTHORIZED" });
    await assert.rejects(anonymous.admin.credits.grant(badGrant), { code: "UNAUTHORIZED" });
  });

  test("validates input once the caller is signed in", async () => {
    await assert.rejects(member.deploy.create(emptyDeploy), { code: "BAD_REQUEST" });
    await assert.rejects(member.apiKeys.create({ name: "" }), { code: "BAD_REQUEST" });
  });

  test("lets an API key through protected procedures only", async () => {
    const me = await adminApiKey.auth.me();
    assert.equal(me.id, "user-1");
    await assert.rejects(adminApiKey.deploy.create(emptyDeploy), { code: "BAD_REQUEST" });
    await assert.rejects(adminApiKey.apiKeys.create({ name: "" }), apiKeyRefusal);
    await assert.rejects(adminApiKey.auth.cliConfirm({ code: "" }), apiKeyRefusal);
    // An admin's key passes the role check, so the key check has to come first.
    await assert.rejects(adminApiKey.admin.credits.grant(grant), apiKeyRefusal);
  });

  test("rejects a non-admin before validating input", async () => {
    await assert.rejects(member.admin.credits.grant(badGrant), { code: "FORBIDDEN" });
    await assert.rejects(member.auth.updateInvite({ id: "" }), { code: "FORBIDDEN" });
    await assert.rejects(administrator.admin.credits.grant(badGrant), { code: "BAD_REQUEST" });
  });
});
