/**
 * Application schema
 */
import { relations, sql } from "drizzle-orm";
import { index, integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

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
    id: text("id").primaryKey().notNull(),
    code: text("code").notNull().unique(),
    createdBy: text("created_by").references(() => user.id, { onDelete: "set null" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
      .notNull(),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }),
    maxUses: integer("max_uses").default(1),
    usedCount: integer("used_count").notNull().default(0),
    revokedAt: integer("revoked_at", { mode: "timestamp_ms" }),
    note: text("note"),
  },
  (table) => ({
    createdByIdx: index("invite_code_created_by_idx").on(table.createdBy),
  }),
);

export const inviteCodeRelations = relations(inviteCode, ({ one }) => ({
  createdBy: one(user, {
    fields: [inviteCode.createdBy],
    references: [user.id],
  }),
}));

export const waitlist = sqliteTable("waitlist", {
  id: text("id").primaryKey().notNull(),
  userId: text("user_id").references(() => user.id),
  source: text("source"),
  email: text("email"),
});

export const waitlistRelations = relations(waitlist, ({ one }) => ({
  user: one(user, {
    fields: [waitlist.userId],
    references: [user.id],
  }),
}));

/**
 * A user-owned game identified globally by a unique slug.
 * The active deployment (served at `{slug}.vibedgames.com`) is pinned via
 * `currentDeploymentId`. Each deploy is immutable; a new deploy replaces the
 * previous one atomically.
 */
export const game = sqliteTable(
  "game",
  {
    id: text("id").primaryKey().notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    slug: text("slug").notNull().unique(),
    name: text("name"),
    currentDeploymentId: text("current_deployment_id"),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
      .notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => ({
    userIdx: index("game_user_idx").on(table.userId),
  }),
);

/**
 * A single upload of a game. Files live in R2 under
 * `games/{gameId}/{deploymentId}/{path}` and are immutable for the life of
 * the deployment.
 */
export const deployment = sqliteTable(
  "deployment",
  {
    id: text("id").primaryKey().notNull(),
    gameId: text("game_id")
      .notNull()
      .references(() => game.id, { onDelete: "cascade" }),
    status: text("status", { enum: ["pending", "ready", "failed"] }).notNull(),
    fileCount: integer("file_count").notNull(),
    totalBytes: integer("total_bytes").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
      .notNull(),
  },
  (table) => ({
    gameIdx: index("deployment_game_idx").on(table.gameId),
  }),
);

/**
 * File metadata for a deployment. Content lives in R2; this table records
 * path, mime, size, and sha256 for lookup and integrity.
 */
export const deploymentFile = sqliteTable(
  "deployment_file",
  {
    deploymentId: text("deployment_id")
      .notNull()
      .references(() => deployment.id, { onDelete: "cascade" }),
    path: text("path").notNull(),
    contentType: text("content_type").notNull(),
    size: integer("size").notNull(),
    sha256: text("sha256").notNull(),
    r2Key: text("r2_key").notNull(),
  },
  (table) => ({
    pk: primaryKey({
      name: "deployment_file_deployment_id_path_pk",
      columns: [table.deploymentId, table.path],
    }),
  }),
);

export const gameRelations = relations(game, ({ one, many }) => ({
  user: one(user, {
    fields: [game.userId],
    references: [user.id],
  }),
  deployments: many(deployment),
}));

export const deploymentRelations = relations(deployment, ({ one, many }) => ({
  game: one(game, {
    fields: [deployment.gameId],
    references: [game.id],
  }),
  files: many(deploymentFile),
}));

export const deploymentFileRelations = relations(deploymentFile, ({ one }) => ({
  deployment: one(deployment, {
    fields: [deploymentFile.deploymentId],
    references: [deployment.id],
  }),
}));
