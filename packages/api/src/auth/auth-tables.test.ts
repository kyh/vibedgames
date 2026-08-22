import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getTableColumns, is, Table } from "drizzle-orm";
import * as drizzleSchema from "@repo/db/drizzle-schema-auth";
import { getAuthTables } from "better-auth/db";

import { auth } from "./auth-codegen";

/**
 * better-auth owns the shape of its tables; the Drizzle schema is a hand-written
 * mirror of them (the CLI regen is disabled — see @repo/db's generate:auth-schema).
 * Nothing else in the gate can catch a divergence: typecheck, lint and build never
 * touch a database, so a field the library requires and the schema lacks stays
 * green until the first real query fails in production. That is exactly how
 * better-auth 1.7's required `account.issuer` slipped through.
 *
 * The drizzle adapter resolves `schema[modelName]` and then `table[fieldName]`,
 * so both sides are matched on the *export key* and the *property name* — not on
 * the physical table/column names, which may differ (`rateLimit` -> "rate_limit",
 * `accountId` -> "account_id").
 *
 * We read `auth-codegen`, not `auth`: the Worker builds its auth inside
 * `createAuth()` because it needs runtime bindings, and there is no module-level
 * instance to introspect. `auth-codegen` exists precisely to be a static mirror
 * of that option set, so keep the two in sync — that file is the only thing this
 * guard can see.
 */

const authTables = getAuthTables(auth.options);

const drizzleTables = new Map<string, Table>(
  Object.entries(drizzleSchema).flatMap(([key, value]) =>
    is(value, Table) ? [[key, value] as const] : [],
  ),
);

const fieldNamesOf = (authTable: (typeof authTables)[string]) =>
  Object.entries(authTable.fields).map(([key, field]) => field.fieldName ?? key);

for (const key of Object.keys(authTables)) {
  describe(key, () => {
    const authTable = authTables[key];
    const table = drizzleTables.get(authTable?.modelName ?? "");

    it("is exported from the Drizzle schema", () => {
      assert.deepEqual(
        { model: authTable?.modelName, found: table !== undefined },
        { model: authTable?.modelName, found: true },
      );
    });

    it("declares every field better-auth requires", () => {
      if (!authTable || !table) return;
      const properties = new Set(Object.keys(getTableColumns(table)));
      const missing = fieldNamesOf(authTable).filter((fieldName) => !properties.has(fieldName));
      assert.deepEqual(missing, []);
    });

    it("does not declare fields better-auth does not know about", () => {
      if (!authTable || !table) return;
      const known = new Set([...fieldNamesOf(authTable), "id"]);
      const extra = Object.keys(getTableColumns(table)).filter((property) => !known.has(property));
      assert.deepEqual(extra, []);
    });

    it("matches better-auth on which fields are NOT NULL", () => {
      if (!authTable || !table) return;
      const columns = getTableColumns(table);
      const mismatched = Object.entries(authTable.fields)
        .map(([key, field]) => ({
          fieldName: field.fieldName ?? key,
          required: field.required === true,
        }))
        .filter(({ fieldName, required }) => {
          const column = columns[fieldName];
          return column !== undefined && column.notNull !== required;
        })
        .map(({ fieldName, required }) => `${fieldName}: expected notNull=${required}`);
      assert.deepEqual(mismatched, []);
    });
  });
}
