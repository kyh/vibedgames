import { beforeAll, describe, expect, it } from "vitest";

import { and, eq } from "@repo/db";
import { creditEntry, generation } from "@repo/db/drizzle-schema";

import {
  formatUsd,
  getBalanceMicro,
  grantCredits,
  holdGeneration,
  listEntries,
  MAX_SETTLE_MICRO,
  MICRO_PER_USD,
  releaseGeneration,
  settleGeneration,
  SIGNUP_GRANT_MICRO,
  usdToMicro,
} from "../src/credits/credit-ledger";
import { applySchema, createUser, testDb } from "./helpers";

beforeAll(applySchema);

/** Submit a generation with a known hold and unit price. */
const hold = async (
  userId: string,
  requestId: string,
  holdMicro: number,
  unitPriceMicro = 1000,
) => {
  await holdGeneration(testDb(), {
    userId,
    requestId,
    endpointId: "fal-ai/flux/dev",
    unit: "megapixels",
    unitPriceMicro,
    holdMicro,
  });
};

const entryFor = async (requestId: string, kind: "generation_settle" | "generation_release") => {
  const rows = await testDb()
    .select()
    .from(creditEntry)
    .where(and(eq(creditEntry.requestId, requestId), eq(creditEntry.kind, kind)));
  return rows[0];
};

describe("signup grant", () => {
  it("materializes $20 lazily on first balance read", async () => {
    const userId = await createUser();
    expect(await getBalanceMicro(testDb(), userId)).toBe(SIGNUP_GRANT_MICRO);
    expect(SIGNUP_GRANT_MICRO).toBe(20 * MICRO_PER_USD);
  });

  it("grants exactly once no matter how many times balance is read", async () => {
    const userId = await createUser();
    await getBalanceMicro(testDb(), userId);
    await getBalanceMicro(testDb(), userId);
    await getBalanceMicro(testDb(), userId);

    const grants = await testDb()
      .select()
      .from(creditEntry)
      .where(and(eq(creditEntry.userId, userId), eq(creditEntry.kind, "signup_grant")));
    expect(grants).toHaveLength(1);
    expect(await getBalanceMicro(testDb(), userId)).toBe(SIGNUP_GRANT_MICRO);
  });
});

describe("hold", () => {
  it("debits the estimate and records the generation", async () => {
    const userId = await createUser();
    await getBalanceMicro(testDb(), userId);
    await hold(userId, "req-hold-1", usdToMicro(2));

    expect(await getBalanceMicro(testDb(), userId)).toBe(SIGNUP_GRANT_MICRO - usdToMicro(2));

    const rows = await testDb()
      .select()
      .from(generation)
      .where(eq(generation.requestId, "req-hold-1"));
    expect(rows[0]?.status).toBe("held");
    expect(rows[0]?.holdMicro).toBe(usdToMicro(2));
  });

  it("is idempotent — a replayed submit does not double-charge", async () => {
    const userId = await createUser();
    await getBalanceMicro(testDb(), userId);
    await hold(userId, "req-hold-2", usdToMicro(3));
    await hold(userId, "req-hold-2", usdToMicro(3));
    await hold(userId, "req-hold-2", usdToMicro(3));

    expect(await getBalanceMicro(testDb(), userId)).toBe(SIGNUP_GRANT_MICRO - usdToMicro(3));
  });
});

describe("settle", () => {
  it("corrects the hold down to actual billed cost", async () => {
    const userId = await createUser();
    await getBalanceMicro(testDb(), userId);
    // hold $5, actually bill 500 units * 1000 micro = $0.50
    await hold(userId, "req-settle-1", usdToMicro(5), 1000);
    await settleGeneration(testDb(), "req-settle-1", 500);

    expect(await getBalanceMicro(testDb(), userId)).toBe(SIGNUP_GRANT_MICRO - usdToMicro(0.5));

    const rows = await testDb()
      .select()
      .from(generation)
      .where(eq(generation.requestId, "req-settle-1"));
    expect(rows[0]?.status).toBe("settled");
    expect(rows[0]?.settledMicro).toBe(usdToMicro(0.5));
  });

  it("charges MORE when the provider billed above the estimate", async () => {
    const userId = await createUser();
    await getBalanceMicro(testDb(), userId);
    await hold(userId, "req-settle-over", usdToMicro(1), 1000);
    // 3000 units * 1000 micro = $3.00, three times the hold
    await settleGeneration(testDb(), "req-settle-over", 3000);

    expect(await getBalanceMicro(testDb(), userId)).toBe(SIGNUP_GRANT_MICRO - usdToMicro(3));
  });

  it("keeps the hold when the provider reported no usage", async () => {
    const userId = await createUser();
    await getBalanceMicro(testDb(), userId);
    await hold(userId, "req-settle-null", usdToMicro(2));
    await settleGeneration(testDb(), "req-settle-null", null);

    expect(await getBalanceMicro(testDb(), userId)).toBe(SIGNUP_GRANT_MICRO - usdToMicro(2));
    // hold === settled, so the guarded INSERT … SELECT writes no correcting row
    expect(await entryFor("req-settle-null", "generation_settle")).toBeUndefined();
  });

  it("keeps the hold when unit pricing was unknown at submit", async () => {
    const userId = await createUser();
    await getBalanceMicro(testDb(), userId);
    await holdGeneration(testDb(), {
      userId,
      requestId: "req-settle-nounit",
      endpointId: "fal-ai/flux/dev",
      unit: null,
      unitPriceMicro: null,
      holdMicro: usdToMicro(2),
    });
    await settleGeneration(testDb(), "req-settle-nounit", 999);

    expect(await getBalanceMicro(testDb(), userId)).toBe(SIGNUP_GRANT_MICRO - usdToMicro(2));
  });

  it("clamps a hostile usage report to the hold instead of draining the balance", async () => {
    const userId = await createUser();
    await getBalanceMicro(testDb(), userId);
    await hold(userId, "req-settle-huge", usdToMicro(2), 1000);
    // Implies $1e297 of charge — a corrupt or hostile upstream header.
    await settleGeneration(testDb(), "req-settle-huge", 1e300);

    expect(await getBalanceMicro(testDb(), userId)).toBe(SIGNUP_GRANT_MICRO - usdToMicro(2));
  });

  it("clamps a charge just above MAX_SETTLE_MICRO", async () => {
    const userId = await createUser();
    await grantCredits(testDb(), {
      userId,
      amountMicro: usdToMicro(500),
      note: null,
      createdBy: userId,
      key: "topup-clamp",
    });
    const before = await getBalanceMicro(testDb(), userId);
    await hold(userId, "req-settle-max", usdToMicro(2), 1);
    // 1 micro/unit * (MAX + 1) units = MAX_SETTLE_MICRO + 1
    await settleGeneration(testDb(), "req-settle-max", MAX_SETTLE_MICRO + 1);

    expect(await getBalanceMicro(testDb(), userId)).toBe(before - usdToMicro(2));
  });

  it("settles exactly at MAX_SETTLE_MICRO", async () => {
    const userId = await createUser();
    await grantCredits(testDb(), {
      userId,
      amountMicro: usdToMicro(500),
      note: null,
      createdBy: userId,
      key: "topup-max",
    });
    const before = await getBalanceMicro(testDb(), userId);
    await hold(userId, "req-settle-atmax", usdToMicro(2), 1);
    await settleGeneration(testDb(), "req-settle-atmax", MAX_SETTLE_MICRO);

    expect(await getBalanceMicro(testDb(), userId)).toBe(before - MAX_SETTLE_MICRO);
  });

  it("is idempotent — repeated result fetches settle once", async () => {
    const userId = await createUser();
    await getBalanceMicro(testDb(), userId);
    await hold(userId, "req-settle-idem", usdToMicro(5), 1000);
    await settleGeneration(testDb(), "req-settle-idem", 500);
    await settleGeneration(testDb(), "req-settle-idem", 500);
    await settleGeneration(testDb(), "req-settle-idem", 500);

    expect(await getBalanceMicro(testDb(), userId)).toBe(SIGNUP_GRANT_MICRO - usdToMicro(0.5));
  });

  it("does not resurrect a charge on an already-released generation", async () => {
    const userId = await createUser();
    await getBalanceMicro(testDb(), userId);
    await hold(userId, "req-race-1", usdToMicro(4), 1000);
    await releaseGeneration(testDb(), "req-race-1");
    // A late result fetch arrives after the failure poll already refunded.
    // The billed amount must differ from the hold, or the `ne(hold, settled)`
    // guard would suppress the entry on its own and this would pass even with
    // the status guards removed.
    await settleGeneration(testDb(), "req-race-1", 1000);

    expect(await getBalanceMicro(testDb(), userId)).toBe(SIGNUP_GRANT_MICRO);
    expect(await entryFor("req-race-1", "generation_settle")).toBeUndefined();
  });

  it("ignores an unknown request id", async () => {
    await expect(settleGeneration(testDb(), "req-does-not-exist", 100)).resolves.toBeUndefined();
  });
});

describe("release", () => {
  it("refunds the whole hold", async () => {
    const userId = await createUser();
    await getBalanceMicro(testDb(), userId);
    await hold(userId, "req-release-1", usdToMicro(7));
    await releaseGeneration(testDb(), "req-release-1");

    expect(await getBalanceMicro(testDb(), userId)).toBe(SIGNUP_GRANT_MICRO);

    const rows = await testDb()
      .select()
      .from(generation)
      .where(eq(generation.requestId, "req-release-1"));
    expect(rows[0]?.status).toBe("released");
    expect(rows[0]?.settledMicro).toBe(0);
  });

  it("is idempotent — repeated failure polls refund once", async () => {
    const userId = await createUser();
    await getBalanceMicro(testDb(), userId);
    await hold(userId, "req-release-idem", usdToMicro(7));
    await releaseGeneration(testDb(), "req-release-idem");
    await releaseGeneration(testDb(), "req-release-idem");
    await releaseGeneration(testDb(), "req-release-idem");

    expect(await getBalanceMicro(testDb(), userId)).toBe(SIGNUP_GRANT_MICRO);
  });

  it("does not refund a generation that already settled", async () => {
    const userId = await createUser();
    await getBalanceMicro(testDb(), userId);
    await hold(userId, "req-race-2", usdToMicro(4), 1000);
    await settleGeneration(testDb(), "req-race-2", 1000);
    // A late CANCELLED poll arrives after the result already billed.
    await releaseGeneration(testDb(), "req-race-2");

    expect(await getBalanceMicro(testDb(), userId)).toBe(SIGNUP_GRANT_MICRO - usdToMicro(1));
    expect(await entryFor("req-race-2", "generation_release")).toBeUndefined();
  });

  it("ignores an unknown request id", async () => {
    await expect(releaseGeneration(testDb(), "req-nope")).resolves.toBeUndefined();
  });
});

describe("admin grant", () => {
  it("tops up and returns the new balance", async () => {
    const userId = await createUser();
    const balance = await grantCredits(testDb(), {
      userId,
      amountMicro: usdToMicro(10),
      note: "thanks",
      createdBy: userId,
      key: "grant-key-1",
    });
    expect(balance).toBe(SIGNUP_GRANT_MICRO + usdToMicro(10));
  });

  it("is idempotent on the client-minted key", async () => {
    const userId = await createUser();
    await grantCredits(testDb(), {
      userId,
      amountMicro: usdToMicro(10),
      note: null,
      createdBy: userId,
      key: "grant-key-2",
    });
    const balance = await grantCredits(testDb(), {
      userId,
      amountMicro: usdToMicro(10),
      note: null,
      createdBy: userId,
      key: "grant-key-2",
    });
    expect(balance).toBe(SIGNUP_GRANT_MICRO + usdToMicro(10));
  });

  it("supports a negative correction", async () => {
    const userId = await createUser();
    const balance = await grantCredits(testDb(), {
      userId,
      amountMicro: -usdToMicro(5),
      note: "clawback",
      createdBy: userId,
      key: "grant-key-3",
    });
    expect(balance).toBe(SIGNUP_GRANT_MICRO - usdToMicro(5));
  });
});

describe("balance can go negative", () => {
  // `generate.forward` gates on balance <= 0 at SUBMIT time, so a single
  // expensive settle can legitimately push a user under zero. The ledger must
  // represent that rather than clamping and silently losing the debt.
  it("settles below zero when the provider billed more than was left", async () => {
    const userId = await createUser();
    await getBalanceMicro(testDb(), userId);
    await hold(userId, "req-neg", usdToMicro(1), MICRO_PER_USD);
    await settleGeneration(testDb(), "req-neg", 25);

    expect(await getBalanceMicro(testDb(), userId)).toBe(SIGNUP_GRANT_MICRO - usdToMicro(25));
    expect(await getBalanceMicro(testDb(), userId)).toBeLessThan(0);
  });
});

describe("entries", () => {
  it("lists the lifecycle of a generation", async () => {
    const userId = await createUser();
    await getBalanceMicro(testDb(), userId);
    await hold(userId, "req-list", usdToMicro(5), 1000);
    await settleGeneration(testDb(), "req-list", 500);

    const entries = await listEntries(testDb(), userId, 50);
    const kinds = entries.map((e) => e.kind).sort();
    expect(kinds).toEqual(["generation_hold", "generation_settle", "signup_grant"]);
    // Ledger is append-only: the entries must sum to the balance, always.
    expect(entries.reduce((sum, e) => sum + e.deltaMicro, 0)).toBe(
      await getBalanceMicro(testDb(), userId),
    );
  });

  it("honours the limit", async () => {
    const userId = await createUser();
    await getBalanceMicro(testDb(), userId);
    await hold(userId, "req-limit-a", usdToMicro(1));
    await hold(userId, "req-limit-b", usdToMicro(1));
    expect(await listEntries(testDb(), userId, 2)).toHaveLength(2);
  });
});

describe("formatUsd", () => {
  it("uses 2 decimals normally and 4 when sub-cent", () => {
    expect(formatUsd(20 * MICRO_PER_USD)).toBe("$20.00");
    expect(formatUsd(0)).toBe("$0.00");
    expect(formatUsd(-1_500_000)).toBe("-$1.50");
    // Below a cent: 2 decimals would render these as $0.00.
    expect(formatUsd(1234)).toBe("$0.0012");
    expect(formatUsd(-1234)).toBe("-$0.0012");
  });
});

describe("usdToMicro", () => {
  it("rounds rather than truncating at the float boundary", () => {
    expect(usdToMicro(0.1)).toBe(100_000);
    expect(usdToMicro(1.005)).toBe(1_005_000);
    expect(usdToMicro(0.0000001)).toBe(0);
  });
});
