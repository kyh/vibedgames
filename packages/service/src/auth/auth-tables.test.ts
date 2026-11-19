import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getColumns, is, Table } from "drizzle-orm";
import * as drizzleSchema from "@repo/db/drizzle-schema-auth";
import { getAuthTables } from "better-auth/db";

import { auth } from "./auth-codegen";

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
        { found: table !== undefined, model: authTable?.modelName },
        { found: true, model: authTable?.modelName },
      );
    });

    it("declares every field better-auth requires", () => {
      if (!authTable || !table) {
        return;
      }

      const properties = new Set(Object.keys(getColumns(table)));
      const missing = fieldNamesOf(authTable).filter((fieldName) => !properties.has(fieldName));
      assert.deepEqual(missing, []);
    });

    it("does not declare fields better-auth does not know about", () => {
      if (!authTable || !table) {
        return;
      }

      const known = new Set([...fieldNamesOf(authTable), "id"]);
      const extra = Object.keys(getColumns(table)).filter((property) => !known.has(property));
      assert.deepEqual(extra, []);
    });

    it("matches better-auth on which fields are NOT NULL", () => {
      if (!authTable || !table) {
        return;
      }

      const columns = getColumns(table);

      const mismatched = Object.entries(authTable.fields)
        .map(([fieldKey, field]) => ({
          fieldName: field.fieldName ?? fieldKey,
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
