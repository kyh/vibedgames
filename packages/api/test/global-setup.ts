import { generateSQLiteDrizzleJson, generateSQLiteMigration } from "drizzle-kit/api";
import type { TestProject } from "vitest/node";

import * as schemaAuth from "@repo/db/drizzle-schema-auth";
import * as schema from "@repo/db/drizzle-schema";

/**
 * Derive the schema DDL straight from the Drizzle TS schema.
 *
 * This repo has no SQL migration files on purpose — `drizzle-kit push` against
 * the TS schema is the source of truth (see CLAUDE.md). Checking a snapshot of
 * CREATE TABLEs into the test suite would immediately start drifting from it,
 * so we generate the statements at setup time from the same modules the app
 * imports. A schema change is picked up by the next test run with nothing to
 * regenerate by hand.
 *
 * drizzle-kit is a Node tool and cannot run inside workerd, so this happens in
 * globalSetup and the statements are handed to the Workers pool via `provide`.
 */
export default async function setup(project: TestProject) {
  const empty = await generateSQLiteDrizzleJson({});
  const current = await generateSQLiteDrizzleJson(
    { ...schema, ...schemaAuth },
    empty.id,
    "snake_case",
  );
  const statements = await generateSQLiteMigration(empty, current);

  project.provide("schemaSql", statements);
}

declare module "vitest" {
  interface ProvidedContext {
    schemaSql: string[];
  }
}
