/**
 * Application schema
 */
import { relations } from "drizzle-orm";
import { sqliteTable, text } from "drizzle-orm/sqlite-core";

import { user } from "./drizzle-schema-auth";

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
