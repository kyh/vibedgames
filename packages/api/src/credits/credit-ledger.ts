import type { Db } from "@repo/db/drizzle-client";
import { and, desc, eq, ne, sql } from "@repo/db";
import { creditEntry, generation } from "@repo/db/drizzle-schema";

/**
 * All amounts are integer micro-USD (1_000_000 = $1.00). Money never touches
 * floats except at the provider-pricing boundary, where dollars are converted
 * once via `usdToMicro`.
 */
export const MICRO_PER_USD = 1_000_000;

/** Every user's opening balance, granted lazily on first credit access. */
export const SIGNUP_GRANT_MICRO = 20 * MICRO_PER_USD;

export const usdToMicro = (usd: number): number => Math.round(usd * MICRO_PER_USD);

export const microToUsd = (micro: number): number => micro / MICRO_PER_USD;

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
export const MAX_SETTLE_MICRO = 100 * MICRO_PER_USD;

/**
 * Grant the signup credit exactly once per user. Deterministic entry id +
 * ON CONFLICT DO NOTHING makes this safe to call on every balance read, which
 * doubles as the backfill for accounts that predate the credit system.
 */
export const ensureSignupGrant = async (db: Db, userId: string): Promise<void> => {
  await db
    .insert(creditEntry)
    .values({
      deltaMicro: SIGNUP_GRANT_MICRO,
      id: `signup:${userId}`,
      kind: "signup_grant",
      userId,
    })
    .onConflictDoNothing();
};

export const getBalanceMicro = async (db: Db, userId: string): Promise<number> => {
  await ensureSignupGrant(db, userId);
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
  await ensureSignupGrant(db, input.userId);
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
