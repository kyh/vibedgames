/**
 * Application schema
 */
import { relations, sql } from "drizzle-orm";
import {
  integer,
  primaryKey,
  sqliteTable,
  text,
} from "drizzle-orm/sqlite-core";

import { organization, user } from "./drizzle-schema-auth";

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
 * A game build with files, owned by a user or organization.
 * Each game has a single build that gets updated with the latest files.
 */
export const gameBuild = sqliteTable("game_build", {
  id: text("id").primaryKey().notNull(),
  userId: text("user_id").references(() => user.id, { onDelete: "cascade" }),
  organizationId: text("organization_id").references(() => organization.id, {
    onDelete: "cascade",
  }),
  title: text("title"),
  description: text("description"),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
    .notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" })
    .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
    .$onUpdate(() => new Date())
    .notNull(),
});

/**
 * Files for a game build. These are updated to always reflect the latest state.
 */
export const gameBuildFile = sqliteTable(
  "game_build_file",
  {
    buildId: text("build_id")
      .notNull()
      .references(() => gameBuild.id, { onDelete: "cascade" }),
    path: text("path").notNull(),
    content: text("content").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
      .notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => ({
    pk: primaryKey({
      name: "game_build_file_build_id_path_pk",
      columns: [table.buildId, table.path],
    }),
  }),
);

export const gameBuildRelations = relations(gameBuild, ({ one, many }) => ({
  user: one(user, {
    fields: [gameBuild.userId],
    references: [user.id],
  }),
  organization: one(organization, {
    fields: [gameBuild.organizationId],
    references: [organization.id],
  }),
  gameBuildFiles: many(gameBuildFile),
}));

export const gameBuildFileRelations = relations(gameBuildFile, ({ one }) => ({
  build: one(gameBuild, {
    fields: [gameBuildFile.buildId],
    references: [gameBuild.id],
  }),
}));
