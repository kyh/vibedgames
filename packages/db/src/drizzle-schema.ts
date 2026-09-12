/**
 * Application schema
 */
import { sql } from "drizzle-orm";
import { index, integer, primaryKey, real, sqliteTable, text } from "drizzle-orm/sqlite-core";

import { user } from "./drizzle-schema-auth";

/**
 * Invite codes gating signup during early preview.
 *
 * A code is "available" when `revokedAt IS NULL`, `expiresAt` is in the future
 * (or NULL), and `usedCount < maxUses` (or `maxUses IS NULL` for unlimited).
 * Claiming a use is a single conditional UPDATE so concurrent signups can't
 * over-redeem the same code. The `user.invitedByCode` column records which
 * code each user redeemed.
 */
export const inviteCode = sqliteTable(
  "invite_code",
  {
    code: text("code").notNull().unique(),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
      .notNull(),
    createdBy: text("created_by").references(() => user.id, { onDelete: "set null" }),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }),
    id: text("id").primaryKey().notNull(),
    maxUses: integer("max_uses").default(1),
    note: text("note"),
    revokedAt: integer("revoked_at", { mode: "timestamp_ms" }),
    usedCount: integer("used_count").notNull().default(0),
  },
  (table) => [index("invite_code_created_by_idx").on(table.createdBy)],
);

export const waitlist = sqliteTable(
  "waitlist",
  {
    email: text("email"),
    id: text("id").primaryKey().notNull(),
    source: text("source"),
    userId: text("user_id").references(() => user.id, { onDelete: "set null" }),
  },
  // SQLite doesn't auto-index FK columns; user deletions would otherwise
  // seq-scan to satisfy ON DELETE SET NULL.
  (table) => [index("waitlist_user_id_idx").on(table.userId)],
);

/**
 * A user-owned game identified globally by a unique slug.
 * The active deployment (served at `{slug}.vibedgames.com`) is pinned via
 * `currentDeploymentId`. Each deploy is immutable; a new deploy replaces the
 * previous one atomically.
 */
export const game = sqliteTable(
  "game",
  {
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
      .notNull(),
    currentDeploymentId: text("current_deployment_id"),
    id: text("id").primaryKey().notNull(),
    name: text("name"),
    slug: text("slug").notNull().unique(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
      .$onUpdate(() => new Date())
      .notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
  },
  (table) => [index("game_user_idx").on(table.userId)],
);

/**
 * A single upload of a game. Files live in R2 under
 * `games/{gameId}/{deploymentId}/{path}` and are immutable for the life of
 * the deployment.
 */
export const deployment = sqliteTable(
  "deployment",
  {
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
      .notNull(),
    fileCount: integer("file_count").notNull(),
    gameId: text("game_id")
      .notNull()
      .references(() => game.id, { onDelete: "cascade" }),
    id: text("id").primaryKey().notNull(),
    sourceBytes: integer("source_bytes"),
    // Optional source archive (tar.gz) for forking, stored OUTSIDE the served
    // bundle prefix at `sources/{gameId}/{deploymentId}/source.tgz`. Null
    // unless the deploy opted in (`vg deploy --source`), which is the norm.
    sourceKey: text("source_key"),
    status: text("status", { enum: ["pending", "ready", "failed"] }).notNull(),
    totalBytes: integer("total_bytes").notNull(),
  },
  (table) => [index("deployment_game_idx").on(table.gameId)],
);

/**
 * File metadata for a deployment. Content lives in R2; this table records
 * path, mime, size, and sha256 for lookup and integrity.
 */
export const deploymentFile = sqliteTable(
  "deployment_file",
  {
    contentType: text("content_type").notNull(),
    deploymentId: text("deployment_id")
      .notNull()
      .references(() => deployment.id, { onDelete: "cascade" }),
    path: text("path").notNull(),
    r2Key: text("r2_key").notNull(),
    sha256: text("sha256").notNull(),
    size: integer("size").notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.deploymentId, table.path],
      name: "deployment_file_deployment_id_path_pk",
    }),
  ],
);

/**
 * Append-only ledger of user credit movements, denominated in micro-USD
 * (1_000_000 = $1). A user's balance is `SUM(delta_micro)` — there is no
 * cached balance column, so the ledger can never disagree with itself.
 *
 * Idempotency lives in the `id`: entries that must exist at most once use a
 * deterministic id (`signup:{userId}`, `hold:{requestId}`,
 * `settle:{requestId}`, `release:{requestId}`) inserted with
 * ON CONFLICT DO NOTHING; admin grants use a random UUID.
 */
export const creditEntry = sqliteTable(
  "credit_entry",
  {
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
      .notNull(),
    /** Admin who issued a grant; null for system entries. */
    createdBy: text("created_by").references(() => user.id, { onDelete: "set null" }),
    /** Signed micro-USD. Positive = grant/refund, negative = charge. */
    deltaMicro: integer("delta_micro").notNull(),
    endpointId: text("endpoint_id"),
    id: text("id").primaryKey().notNull(),
    kind: text("kind", {
      enum: [
        "signup_grant",
        "admin_grant",
        "generation_hold",
        "generation_settle",
        "generation_release",
      ],
    }).notNull(),
    note: text("note"),
    /** Provider request id, set on generation_* entries. */
    requestId: text("request_id"),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
  },
  (table) => [index("credit_entry_user_idx").on(table.userId)],
);

/**
 * One row per generation submitted through `generate.forward`, keyed by the
 * provider's request id. Tracks the credit lifecycle:
 *
 *   held    — an estimated hold was debited at submit
 *   settled — the result fetch reported actual billable units and the hold
 *             was corrected to `settledMicro`
 *   released — the job failed/was cancelled and the hold was refunded
 *
 * The status transition out of `held` is a conditional UPDATE, so concurrent
 * result fetches settle exactly once. Rows that stay `held` (result never
 * fetched through the proxy) keep their estimated charge.
 */
export const generation = sqliteTable(
  "generation",
  {
    /** Actual units reported by the provider on the result fetch. */
    billedUnits: real("billed_units"),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
      .notNull(),
    endpointId: text("endpoint_id").notNull(),
    /** Estimated charge debited at submit, micro-USD. */
    holdMicro: integer("hold_micro").notNull(),
    requestId: text("request_id").primaryKey().notNull(),
    settledAt: integer("settled_at", { mode: "timestamp_ms" }),
    /** Final charge, micro-USD. Set when status leaves `held`. */
    settledMicro: integer("settled_micro"),
    status: text("status", { enum: ["held", "settled", "released"] }).notNull(),
    /** Provider pricing unit (e.g. "megapixels", "seconds"); null if unknown. */
    unit: text("unit"),
    /** Micro-USD per unit at submit time; null if pricing lookup failed. */
    unitPriceMicro: integer("unit_price_micro"),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
  },
  (table) => [index("generation_user_idx").on(table.userId)],
);
