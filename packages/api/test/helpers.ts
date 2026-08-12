import { env } from "cloudflare:test";
import { inject } from "vitest";

import { createDb } from "@repo/db/drizzle-client";
import { user } from "@repo/db/drizzle-schema-auth";

/**
 * Apply the generated schema to the test database. Call once per file in
 * `beforeAll`.
 *
 * Made idempotent with IF NOT EXISTS rather than relying on each test file
 * getting its own storage: if the pool ever shares a database between files,
 * a bare CREATE TABLE would throw on the second file and the failure would
 * look like a schema bug rather than a harness detail.
 */
export const applySchema = async (): Promise<void> => {
  const statements = inject("schemaSql");
  for (const statement of statements) {
    // `exec` takes one statement per call and chokes on the multi-line
    // formatting drizzle-kit emits, so flatten onto a single line first.
    const flat = statement.replaceAll("\n", " ").replaceAll("\t", " ");
    await env.DB.exec(
      flat
        .replace(/^CREATE TABLE /i, "CREATE TABLE IF NOT EXISTS ")
        .replace(/^CREATE (UNIQUE )?INDEX /i, "CREATE $1INDEX IF NOT EXISTS "),
    );
  }
};

export const testDb = () => createDb(env.DB);

let seq = 0;

/**
 * Insert a user row. `credit_entry.user_id` and `generation.user_id` are
 * foreign keys, so a ledger test without a real user row would fail on the
 * constraint rather than on the behaviour under test.
 */
export const createUser = async (id?: string): Promise<string> => {
  const userId = id ?? `user-${++seq}`;
  await testDb()
    .insert(user)
    .values({
      id: userId,
      name: userId,
      email: `${userId}@example.test`,
    })
    .onConflictDoNothing();
  return userId;
};
