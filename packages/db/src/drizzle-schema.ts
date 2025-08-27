/**
 * Application schema
 */
import { relations } from "drizzle-orm";
import { pgTable } from "drizzle-orm/pg-core";

import { user } from "./drizzle-schema-auth";

export const waitlist = pgTable("waitlist", (t) => ({
  id: t.uuid().notNull().primaryKey().defaultRandom(),
  userId: t.text().references(() => user.id),
  source: t.text(),
  email: t.text(),
}));

export const waitlistRelations = relations(waitlist, ({ one }) => ({
  user: one(user, {
    fields: [waitlist.userId],
    references: [user.id],
  }),
}));
