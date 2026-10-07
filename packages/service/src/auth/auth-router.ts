import { desc, eq } from "@repo/db";
import { inviteCode } from "@repo/db/drizzle-schema";
import { user, verification } from "@repo/db/drizzle-schema-auth";
import { ORPCError } from "@orpc/server";

import { usdToMicro } from "../credits/credit-ledger";
import { os, rejectApiKey, requireAdmin, requireSession } from "../orpc";
import { buildInviteRows } from "./invite-create";
import { generateShortCode } from "./utils";

// 5 minutes
const CLI_CODE_TTL_MS = 5 * 60 * 1000;
const CLI_IDENTIFIER_PREFIX = "cli-auth:";

const authed = os.auth.use(requireSession);
const sessionOnly = authed.use(rejectApiKey);
const admin = sessionOnly.use(requireAdmin);

export const authRouter = {
  // sessionOnly (not just authed): this persists
  // `context.session.session.token` as the CLI's login credential, so the caller
  // must hold a real better-auth session. An API-key session's synthetic
  // `apikey:` token would be handed to the CLI and rejected by getSession.
  cliConfirm: sessionOnly.cliConfirm.handler(async ({ context, input }) => {
    const identifier = `${CLI_IDENTIFIER_PREFIX}${input.code}`;
    const rows = await context.db
      .select()
      .from(verification)
      .where(eq(verification.identifier, identifier))
      .limit(1);

    const [row] = rows;
    if (!row || row.expiresAt < new Date()) {
      throw new ORPCError("NOT_FOUND", { message: "Code expired or invalid" });
    }
    if (row.value !== "") {
      throw new ORPCError("BAD_REQUEST", { message: "Code already confirmed" });
    }

    // Store the raw session token — the CLI uses it as a Bearer token
    await context.db
      .update(verification)
      .set({ updatedAt: new Date(), value: context.session.session.token })
      .where(eq(verification.id, row.id));

    return { ok: true as const };
  }),

  // ---------------------------------------------------------------------------
  // CLI device-code flow
  // ---------------------------------------------------------------------------
  cliInit: os.auth.cliInit.handler(async ({ context }) => {
    const code = generateShortCode();
    const id = crypto.randomUUID();
    const now = new Date();

    await context.db.insert(verification).values({
      createdAt: now,
      expiresAt: new Date(now.getTime() + CLI_CODE_TTL_MS),
      id,
      identifier: `${CLI_IDENTIFIER_PREFIX}${code}`,
      updatedAt: now,
      value: "",
    });

    return { code };
  }),

  cliPoll: os.auth.cliPoll.handler(async ({ context, input }) => {
    const identifier = `${CLI_IDENTIFIER_PREFIX}${input.code}`;
    const rows = await context.db
      .select()
      .from(verification)
      .where(eq(verification.identifier, identifier))
      .limit(1);

    const [row] = rows;
    if (!row || row.expiresAt < new Date()) {
      return { status: "expired" as const };
    }

    if (row.value === "") {
      return { status: "pending" as const };
    }

    // Consume the code and hand out its token in one statement: only the poll
    // whose delete removed the row gets it, so two polls racing past the read
    // above can't both leave with the same login. The loser finds it consumed.
    const [consumed] = await context.db
      .delete(verification)
      .where(eq(verification.id, row.id))
      .returning({ token: verification.value });
    if (!consumed) {
      return { status: "expired" as const };
    }

    return { status: "confirmed" as const, token: consumed.token };
  }),

  createInvites: admin.createInvites.handler(async ({ context, input }) => {
    let rows;
    try {
      rows = buildInviteRows({
        code: input.code,
        count: input.count,
        createdBy: context.session.user.id,
        creditMicro: usdToMicro(input.creditUsd),
        expiresAt: input.expiresAt,
        maxUses: input.maxUses,
        note: input.note,
      });
    } catch (error) {
      // buildInviteRows throws on a malformed custom code — a caller
      // mistake, not a server fault.
      throw new ORPCError("BAD_REQUEST", {
        message: error instanceof Error ? error.message : "Invalid invite code",
      });
    }

    try {
      const created = await context.db.insert(inviteCode).values(rows).returning();
      return { codes: created };
    } catch (error) {
      // Drizzle wraps the D1 constraint failure; the "UNIQUE" detail sits
      // somewhere down the `cause` chain, not on the top-level message.
      for (let e: unknown = error; e instanceof Error; e = e.cause) {
        if (input.code !== null && e.message.includes("UNIQUE")) {
          throw new ORPCError("CONFLICT", { message: "That credit code already exists." });
        }
      }
      throw error;
    }
  }),

  listInvites: admin.listInvites.handler(async ({ context }) => {
    const rows = await context.db
      .select({
        code: inviteCode.code,
        createdAt: inviteCode.createdAt,
        createdBy: inviteCode.createdBy,
        creatorEmail: user.email,
        creditMicro: inviteCode.creditMicro,
        expiresAt: inviteCode.expiresAt,
        id: inviteCode.id,
        maxUses: inviteCode.maxUses,
        note: inviteCode.note,
        revokedAt: inviteCode.revokedAt,
        usedCount: inviteCode.usedCount,
      })
      .from(inviteCode)
      .leftJoin(user, eq(inviteCode.createdBy, user.id))
      .orderBy(desc(inviteCode.createdAt));

    return { codes: rows };
  }),

  // Current authenticated identity. Works for both better-auth sessions and
  // API keys (both resolve to `context.session` in the oRPC context), so the CLI
  // can use it for `vg whoami` regardless of how it authenticated.
  me: authed.me.handler(({ context }) => ({
    email: context.session.user.email,
    id: context.session.user.id,
    name: context.session.user.name,
    role: context.session.user.role ?? null,
  })),

  // Revoke, unrevoke, or change the use limit or value of an existing code. Omitted
  // fields are left untouched. Lowering `maxUses` below `usedCount` is allowed
  // and simply exhausts the code; raising it re-opens an exhausted code.
  updateInvite: admin.updateInvite.handler(async ({ context, input }) => {
    const patch: Partial<typeof inviteCode.$inferInsert> = {};
    if (input.creditUsd !== undefined) {
      patch.creditMicro = usdToMicro(input.creditUsd);
    }
    if (input.maxUses !== undefined) {
      patch.maxUses = input.maxUses;
    }
    if (input.revoked !== undefined) {
      patch.revokedAt = input.revoked ? new Date() : null;
    }

    if (Object.keys(patch).length === 0) {
      throw new ORPCError("BAD_REQUEST", { message: "Nothing to update" });
    }

    const [updated] = await context.db
      .update(inviteCode)
      .set(patch)
      .where(eq(inviteCode.id, input.id))
      .returning();

    if (!updated) {
      throw new ORPCError("NOT_FOUND", { message: "Code not found" });
    }

    return { code: updated };
  }),
};
