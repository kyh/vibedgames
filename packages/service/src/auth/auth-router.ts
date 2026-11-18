import { desc, eq } from "@repo/db";
import { inviteCode } from "@repo/db/drizzle-schema";
import { user } from "@repo/db/drizzle-schema-auth";
import { ORPCError } from "@orpc/server";

import { usdToMicro } from "../credits/credit-ledger";
import { os, rejectApiKey, requireAdmin, requireSession } from "../orpc";
import { buildInviteRows } from "./invite-create";

const authed = os.auth.use(requireSession);
const sessionOnly = authed.use(rejectApiKey);
const admin = sessionOnly.use(requireAdmin);

export const authRouter = {
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
      throw new ORPCError("BAD_REQUEST", {
        message: error instanceof Error ? error.message : "Invalid invite code",
      });
    }

    try {
      const created = await context.db.insert(inviteCode).values(rows).returning();

      return { codes: created };
    } catch (error) {
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

  me: authed.me.handler(({ context }) => {
    const { user: caller } = context.session;
    const scopes = context.oauthScopes;

    return {
      email: !scopes || scopes.includes("email") ? caller.email : null,
      id: caller.id,
      name: caller.name,
      role: scopes ? null : (caller.role ?? null),
    };
  }),

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
