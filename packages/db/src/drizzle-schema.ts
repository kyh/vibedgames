/**
 * Application schema
 */
import { relations, sql } from "drizzle-orm";
import {
  foreignKey,
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
 * Top-level container for a game concept owned by a user or organization.
 */
export const gameProject = sqliteTable("game_project", {
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
 * Records a single sandbox-powered build for a project.
 */
export const gameBuild = sqliteTable(
  "game_build",
  {
    projectId: text("project_id")
      .notNull()
      .references(() => gameProject.id, { onDelete: "cascade" }),
    buildNumber: integer("build_number").notNull(),
    createdById: text("created_by_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    sandboxId: text("sandbox_id"),
    modelId: text("model_id"),
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
      name: "game_build_project_id_build_number_pk",
      columns: [table.projectId, table.buildNumber],
    }),
  }),
);

/**
 * Snapshot of all files produced during a build execution.
 */
export const gameBuildFile = sqliteTable(
  "game_build_file",
  {
    projectId: text("project_id")
      .notNull()
      .references(() => gameProject.id, { onDelete: "cascade" }),
    buildNumber: integer("build_number").notNull(),
    path: text("path").notNull(),
    content: text("content").notNull(),
    recordedAt: integer("recorded_at", { mode: "timestamp_ms" })
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
      .notNull(),
  },
  (table) => ({
    buildForeignKey: foreignKey({
      name: "game_build_file_build_fk",
      columns: [table.projectId, table.buildNumber],
      foreignColumns: [gameBuild.projectId, gameBuild.buildNumber],
    }).onDelete("cascade"),
    pk: primaryKey({
      name: "game_build_file_project_id_build_number_path_pk",
      columns: [table.projectId, table.buildNumber, table.path],
    }),
  }),
);

export const gameProjectRelations = relations(gameProject, ({ one, many }) => ({
  user: one(user, {
    fields: [gameProject.userId],
    references: [user.id],
  }),
  organization: one(organization, {
    fields: [gameProject.organizationId],
    references: [organization.id],
  }),
  builds: many(gameBuild),
}));

export const gameBuildRelations = relations(gameBuild, ({ one, many }) => ({
  project: one(gameProject, {
    fields: [gameBuild.projectId],
    references: [gameProject.id],
  }),
  creator: one(user, {
    fields: [gameBuild.createdById],
    references: [user.id],
  }),
  files: many(gameBuildFile),
}));

export const gameBuildFileRelations = relations(gameBuildFile, ({ one }) => ({
  build: one(gameBuild, {
    fields: [gameBuildFile.projectId, gameBuildFile.buildNumber],
    references: [gameBuild.projectId, gameBuild.buildNumber],
  }),
}));
