import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Miniflare } from "miniflare";
import { createDb } from "@repo/db/drizzle-client";

const dbPackage = path.dirname(
  path.dirname(fileURLToPath(import.meta.resolve("@repo/db/drizzle-schema"))),
);

const schemaStatements = () =>
  execFileSync(
    process.execPath,
    [
      path.join(dbPackage, "node_modules/drizzle-kit/bin.cjs"),
      "export",
      "--config",
      "drizzle.config.export.ts",
    ],
    { cwd: dbPackage, encoding: "utf-8" },
  )
    .split(/;\s*\n/u)
    .map((statement) => statement.trim())
    .filter((statement) => statement !== "");

/**
 * Starts a local D1 (Miniflare's, the one `wrangler dev` runs) holding the
 * whole schema, empty, and the drizzle client over it.
 */
export const startD1 = async () => {
  const miniflare = new Miniflare({
    d1Databases: ["DB"],
    modules: true,
    script: "export default { fetch: () => new Response(null, { status: 404 }) };",
  });

  const d1 = await miniflare.getD1Database("DB");

  await d1.batch(schemaStatements().map((statement) => d1.prepare(statement)));

  return {
    close: async () => {
      await miniflare.dispose();
    },
    db: createDb(d1),
  };
};
