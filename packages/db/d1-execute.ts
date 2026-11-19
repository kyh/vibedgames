import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { parseArgs } from "node:util";

import { localD1File } from "./local-d1.ts";

const D1_DATABASE_ID = "8aba7674-bee1-4532-b5f0-36243172cf81";

const { values } = parseArgs({
  options: { file: { type: "string" }, remote: { default: false, type: "boolean" } },
});

if (values.file === undefined) {
  throw new Error("--file is required");
}

const sql = readFileSync(path.resolve(values.file), "utf-8");

if (values.remote) {
  const web = path.join(import.meta.dirname, "..", "..", "apps", "web");

  const result = spawnSync("pnpm", ["exec", "cf", "d1", "query", D1_DATABASE_ID, "--sql", sql], {
    cwd: web,
    stdio: "inherit",
  });

  process.exit(result.status ?? 1);
}

const db = new DatabaseSync(localD1File());

try {
  db.exec(sql);
} finally {
  db.close();
}
