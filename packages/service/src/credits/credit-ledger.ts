import type { Db } from "@repo/db/drizzle-client";
import { and, desc, eq, gt, isNull, lt, ne, or, sql } from "@repo/db";
import { creditEntry, generation, inviteCode } from "@repo/db/drizzle-schema";
import { user } from "@repo/db/drizzle-schema-auth";

/**
 * All amounts are integer micro-USD (1_000_000 = $1.00). Money never touches
 * floats except at the provider-pricing boundary, where dollars are converted
 * once via `usdToMicro`.
 */
export const MICRO_PER_USD = 1_000_000;

/**
 * The opening balance pre-launch accounts were promised. New accounts start
 * at zero; see `ensureLegacySignupGrant`.
 */
export const SIGNUP_GRANT_MICRO = 20 * MICRO_PER_USD;

export const usdToMicro = (usd: number): number => Math.round(usd * MICRO_PER_USD);

export const formatUsd = (micro: number): string => {
  const abs = Math.abs(micro);
  // 2 decimals normally; 4 when sub-cent so small non-zero amounts (a single
  // cheap generation, a tiny negative balance) don't render as $0.00.
  const decimals = abs > 0 && abs < MICRO_PER_USD / 100 ? 4 : 2;
  return `${micro < 0 ? "-" : ""}$${(abs / MICRO_PER_USD).toFixed(decimals)}`;
};

/**
 * Ceiling on a single generation's settled charge. A usage report implying
 * more than this is treated as garbage (settle falls back to the hold) —
 * it protects the ledger from a corrupt/hostile upstream header like "1e300"
 * becoming a balance-destroying debit.
 */
const MAX_SETTLE_MICRO = 100 * MICRO_PER_USD;

/**
 * Accounts start with no credit. The exception is an account that signed up
 * with an invite code before launch: it was promised a $20 grant, materialized
 * lazily on first credit access, and may never have touched credits. The
 * INSERT…SELECT writes the grant only for such a user, and the deterministic
 * id + ON CONFLICT DO NOTHING keeps it at once — so this stays safe to run on
 * every balance read.
 */
const ensureLegacySignupGrant = async (db: Db, userId: string): Promise<void> => {
  await db
    .insert(creditEntry)
    .select(
      db
        // insert().select() requires every table column, in definition order.
        .select({
          createdAt: sql<number>`(cast(unixepoch('subsecond') * 1000 as integer))`.as("created_at"),
          createdBy: sql<string | null>`NULL`.as("created_by"),
          deltaMicro: sql<number>`${SIGNUP_GRANT_MICRO}`.as("delta_micro"),
          endpointId: sql<string | null>`NULL`.as("endpoint_id"),
          id: sql<string>`'signup:' || ${user.id}`.as("id"),
          kind: sql<"signup_grant">`'signup_grant'`.as("kind"),
          note: sql<string | null>`NULL`.as("note"),
          requestId: sql<string | null>`NULL`.as("request_id"),
          userId: user.id,
        })
        .from(user)
        .where(and(eq(user.id, userId), sql`${user.invitedByCode} IS NOT NULL`)),
    )
    .onConflictDoNothing();
};

export const getBalanceMicro = async (db: Db, userId: string): Promise<number> => {
  await ensureLegacySignupGrant(db, userId);
  const rows = await db
    .select({ balance: sql<number>`coalesce(sum(${creditEntry.deltaMicro}), 0)` })
    .from(creditEntry)
    .where(eq(creditEntry.userId, userId));
  return rows[0]?.balance ?? 0;
};

export interface HoldInput {
  userId: string;
  requestId: string;
  endpointId: string;
  unit: string | null;
  unitPriceMicro: number | null;
  holdMicro: number;
}

/**
 * Record a submitted generation and debit its estimated cost. The two writes
 * are one atomic D1 batch — a partial failure can never leave a generation
 * without its debit. Both statements are idempotent on deterministic ids, so
 * replaying the whole batch (retried submits, healing) is safe.
 */
export const holdGeneration = async (db: Db, input: HoldInput): Promise<void> => {
  await db.batch([
    db
      .insert(generation)
      .values({
        endpointId: input.endpointId,
        holdMicro: input.holdMicro,
        requestId: input.requestId,
        status: "held",
        unit: input.unit,
        unitPriceMicro: input.unitPriceMicro,
        userId: input.userId,
      })
      .onConflictDoNothing(),
    db
      .insert(creditEntry)
      .values({
        deltaMicro: -input.holdMicro,
        endpointId: input.endpointId,
        id: `hold:${input.requestId}`,
        kind: "generation_hold",
        requestId: input.requestId,
        userId: input.userId,
      })
      .onConflictDoNothing(),
  ]);
};

/**
 * The correcting ledger entry for a settle/release, derived entirely from the
 * generation row INSIDE the batch's transaction (`INSERT … SELECT`), guarded
 * by the row's post-transition status. The guard makes the pair atomic-safe
 * under races: if a concurrent transition to the OTHER terminal state won,
 * the status predicate selects nothing and no entry is written. Because it
 * reads persisted values, re-running it also heals a row whose entry was
 * lost before this code used batches.
 */
const settleEntrySelect = (db: Db, requestId: string) =>
  db
    .insert(creditEntry)
    .select(
      db
        // insert().select() requires every table column, in definition order.
        .select({
          createdAt: sql<number>`(cast(unixepoch('subsecond') * 1000 as integer))`.as("created_at"),
          createdBy: sql<string | null>`NULL`.as("created_by"),
          deltaMicro: sql<number>`${generation.holdMicro} - ${generation.settledMicro}`.as(
            "delta_micro",
          ),
          endpointId: generation.endpointId,
          id: sql<string>`'settle:' || ${generation.requestId}`.as("id"),
          kind: sql<"generation_settle">`'generation_settle'`.as("kind"),
          note: sql<string | null>`NULL`.as("note"),
          requestId: generation.requestId,
          userId: generation.userId,
        })
        .from(generation)
        .where(
          and(
            eq(generation.requestId, requestId),
            eq(generation.status, "settled"),
            ne(generation.holdMicro, generation.settledMicro),
          ),
        ),
    )
    .onConflictDoNothing();

const releaseEntrySelect = (db: Db, requestId: string) =>
  db
    .insert(creditEntry)
    .select(
      db
        .select({
          createdAt: sql<number>`(cast(unixepoch('subsecond') * 1000 as integer))`.as("created_at"),
          createdBy: sql<string | null>`NULL`.as("created_by"),
          deltaMicro: generation.holdMicro,
          endpointId: generation.endpointId,
          id: sql<string>`'release:' || ${generation.requestId}`.as("id"),
          kind: sql<"generation_release">`'generation_release'`.as("kind"),
          note: sql<string | null>`NULL`.as("note"),
          requestId: generation.requestId,
          userId: generation.userId,
        })
        .from(generation)
        .where(and(eq(generation.requestId, requestId), eq(generation.status, "released"))),
    )
    .onConflictDoNothing();

/**
 * Correct a hold to the actual billed cost reported by the provider.
 * `billedUnits: null` means the provider response carried no usage signal —
 * we settle at the hold amount so the books close. A usage signal implying
 * a charge above `MAX_SETTLE_MICRO` (or a non-integer overflow) is treated
 * the same way.
 *
 * The `held -> settled` transition is a conditional UPDATE (invite-claim
 * pattern) batched atomically with its guarded ledger entry; calling this
 * again on an already-settled row only re-runs the idempotent entry insert,
 * which converges a row that lost its entry to a pre-batch partial failure.
 */
export const settleGeneration = async (
  db: Db,
  requestId: string,
  billedUnits: number | null,
): Promise<void> => {
  const rows = await db
    .select()
    .from(generation)
    .where(eq(generation.requestId, requestId))
    .limit(1);
  const [row] = rows;
  if (!row || row.status === "released") {
    return;
  }

  const raw =
    billedUnits !== null && row.unitPriceMicro !== null
      ? Math.ceil(billedUnits * row.unitPriceMicro)
      : row.holdMicro;
  const settledMicro =
    Number.isSafeInteger(raw) && raw >= 0 && raw <= MAX_SETTLE_MICRO ? raw : row.holdMicro;

  await db.batch([
    db
      .update(generation)
      .set({
        billedUnits,
        settledAt: new Date(),
        settledMicro,
        status: "settled",
      })
      .where(and(eq(generation.requestId, requestId), eq(generation.status, "held"))),
    settleEntrySelect(db, requestId),
  ]);
};

/**
 * Refund the hold for a generation that failed or was cancelled (the
 * provider does not bill those). Same atomic transition-plus-entry shape as
 * settle.
 */
export const releaseGeneration = async (db: Db, requestId: string): Promise<void> => {
  const rows = await db
    .select()
    .from(generation)
    .where(eq(generation.requestId, requestId))
    .limit(1);
  const [row] = rows;
  if (!row || row.status === "settled") {
    return;
  }

  await db.batch([
    db
      .update(generation)
      .set({ settledAt: new Date(), settledMicro: 0, status: "released" })
      .where(and(eq(generation.requestId, requestId), eq(generation.status, "held"))),
    releaseEntrySelect(db, requestId),
  ]);
};

export interface GrantInput {
  userId: string;
  amountMicro: number;
  note: string | null;
  createdBy: string;
  /**
   * Client-minted idempotency key (one per intended grant). A replayed
   * request — retry after a dropped response, double-click — lands on the
   * same entry id and no-ops instead of granting twice.
   */
  key: string;
}

/** Admin top-up. Returns the user's balance after the grant. */
export const grantCredits = async (db: Db, input: GrantInput): Promise<number> => {
  await db
    .insert(creditEntry)
    .values({
      createdBy: input.createdBy,
      deltaMicro: input.amountMicro,
      id: `grant:${input.key}`,
      kind: "admin_grant",
      note: input.note,
      userId: input.userId,
    })
    .onConflictDoNothing();
  return getBalanceMicro(db, input.userId);
};

export const creditCodeAvailable = (now: Date) =>
  and(
    isNull(inviteCode.revokedAt),
    or(isNull(inviteCode.expiresAt), gt(inviteCode.expiresAt, now)),
    or(isNull(inviteCode.maxUses), lt(inviteCode.usedCount, inviteCode.maxUses)),
  );

export type RedeemResult =
  | { status: "redeemed"; creditedMicro: number; balanceMicro: number }
  | { status: "already_redeemed" }
  | { status: "invalid" };

/**
 * Redeem a credit code for `userId`: one `code_redeem` entry worth the code's
 * `creditMicro`, at most once per user per code, within the code's use limit.
 *
 * One D1 batch, so one transaction. The entry is an INSERT…SELECT guarded by
 * the code's availability, its id `code:{codeId}:{userId}` makes a repeat a
 * conflict, and the use counter then moves only when that INSERT wrote a row:
 * SQLite's `changes()` reports the previous statement's row count. So a
 * double-submit, a lost race for a code's last use, or a dead code writes
 * nothing at all. A pre-launch account can't redeem the code it signed up
 * with — that signup already used the code and carried its grant.
 */
export const redeemCreditCode = async (
  db: Db,
  userId: string,
  code: string,
): Promise<RedeemResult> => {
  const now = new Date();
  const [inserted] = await db.batch([
    db
      .insert(creditEntry)
      .select(
        db
          .select({
            createdAt: sql<number>`(cast(unixepoch('subsecond') * 1000 as integer))`.as(
              "created_at",
            ),
            createdBy: sql<string | null>`NULL`.as("created_by"),
            deltaMicro: inviteCode.creditMicro,
            endpointId: sql<string | null>`NULL`.as("endpoint_id"),
            id: sql<string>`'code:' || ${inviteCode.id} || ':' || ${userId}`.as("id"),
            kind: sql<"code_redeem">`'code_redeem'`.as("kind"),
            note: inviteCode.code,
            requestId: sql<string | null>`NULL`.as("request_id"),
            userId: sql<string>`${userId}`.as("user_id"),
          })
          .from(inviteCode)
          .where(
            and(
              eq(inviteCode.code, code),
              gt(inviteCode.creditMicro, 0),
              creditCodeAvailable(now),
              sql`NOT EXISTS (SELECT 1 FROM ${user} WHERE ${user.id} = ${userId} AND ${user.invitedByCode} = ${inviteCode.code})`,
            ),
          ),
      )
      .onConflictDoNothing()
      .returning({ deltaMicro: creditEntry.deltaMicro }),
    db
      .update(inviteCode)
      .set({ usedCount: sql`${inviteCode.usedCount} + 1` })
      .where(and(eq(inviteCode.code, code), sql`changes() = 1`)),
  ]);

  const [entry] = inserted;
  if (entry) {
    return {
      balanceMicro: await getBalanceMicro(db, userId),
      creditedMicro: entry.deltaMicro,
      status: "redeemed",
    };
  }

  const [known] = await db
    .select({ id: inviteCode.id })
    .from(inviteCode)
    .where(eq(inviteCode.code, code))
    .limit(1);
  if (!known) {
    return { status: "invalid" };
  }
  const prior = await db
    .select({ id: creditEntry.id })
    .from(creditEntry)
    .where(eq(creditEntry.id, `code:${known.id}:${userId}`))
    .limit(1);
  return prior.length > 0 ? { status: "already_redeemed" } : { status: "invalid" };
};

export interface PurchaseInput {
  /** The Stripe Checkout Session id — one purchase entry per paid session. */
  checkoutSessionId: string;
  userId: string;
  creditMicro: number;
}

/**
 * Credit a paid checkout. Stripe redelivers webhooks, and both
 * `checkout.session.completed` and `…async_payment_succeeded` can report the
 * same session, so the entry id is the session id. The INSERT…SELECT from
 * `user` makes a purchase by a since-deleted account a no-op instead of a
 * foreign-key failure Stripe would retry for days. Returns whether this call
 * wrote the entry.
 */
export const creditPurchase = async (db: Db, input: PurchaseInput): Promise<boolean> => {
  const rows = await db
    .insert(creditEntry)
    .select(
      db
        .select({
          createdAt: sql<number>`(cast(unixepoch('subsecond') * 1000 as integer))`.as("created_at"),
          createdBy: sql<string | null>`NULL`.as("created_by"),
          deltaMicro: sql<number>`${input.creditMicro}`.as("delta_micro"),
          endpointId: sql<string | null>`NULL`.as("endpoint_id"),
          id: sql<string>`${`purchase:${input.checkoutSessionId}`}`.as("id"),
          kind: sql<"purchase">`'purchase'`.as("kind"),
          note: sql<string | null>`NULL`.as("note"),
          requestId: sql<string | null>`NULL`.as("request_id"),
          userId: user.id,
        })
        .from(user)
        .where(eq(user.id, input.userId)),
    )
    .onConflictDoNothing()
    .returning({ id: creditEntry.id });
  return rows.length > 0;
};

export const listEntries = (db: Db, userId: string, limit: number) =>
  db
    .select({
      createdAt: creditEntry.createdAt,
      deltaMicro: creditEntry.deltaMicro,
      endpointId: creditEntry.endpointId,
      id: creditEntry.id,
      kind: creditEntry.kind,
      note: creditEntry.note,
      requestId: creditEntry.requestId,
    })
    .from(creditEntry)
    .where(eq(creditEntry.userId, userId))
    .orderBy(desc(creditEntry.createdAt), desc(creditEntry.id))
    .limit(limit);

/** Per-user balances for the admin roster. */
export const listBalances = (db: Db) =>
  db
    .select({
      balanceMicro: sql<number>`sum(${creditEntry.deltaMicro})`,
      userId: creditEntry.userId,
    })
    .from(creditEntry)
    .groupBy(creditEntry.userId);
