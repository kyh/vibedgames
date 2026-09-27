import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { is } from "drizzle-orm";
import { getTableConfig, SQLiteTable } from "drizzle-orm/sqlite-core";

import * as schema from "./drizzle-schema";
import * as authSchema from "./drizzle-schema-auth";

/**
 * drizzle-kit 1.0 diffs an inline UNIQUE constraint or a renamed PK against
 * production as a table recreate, and D1 ignores `PRAGMA foreign_keys=OFF`, so
 * the recreate's DROP cascade-deletes every child row. Typecheck, lint and build
 * never see that diff — see "Declare uniques as named unique indexes" in the
 * root CLAUDE.md.
 */

const tables = Object.values({ ...schema, ...authSchema }).flatMap((value) =>
  is(value, SQLiteTable) ? [getTableConfig(value)] : [],
);

describe("D1 schema", () => {
  it("declares uniques as named unique indexes, never inline constraints", () => {
    const inline = tables.flatMap((table) => [
      ...table.columns
        .filter((column) => column.isUnique)
        .map((column) => `${table.name}.${column.name}: .unique()`),
      ...table.uniqueConstraints.map(
        (constraint) =>
          `${table.name}: unique(${constraint.columns.map((c) => c.name).join(", ")})`,
      ),
    ]);
    assert.deepEqual(
      inline,
      [],
      'Replace with uniqueIndex("<table>_<column>_unique").on(table.<column>) in the table\'s extra config — see "Declare uniques as named unique indexes" in CLAUDE.md.',
    );
  });

  it("keeps the deployment_file composite PK named deployment_file_pk", () => {
    const names = tables
      .filter((table) => table.name === "deployment_file")
      .flatMap((table) => table.primaryKeys.map((primaryKey) => primaryKey.getName()));
    assert.deepEqual(names, ["deployment_file_pk"]);
  });
});
