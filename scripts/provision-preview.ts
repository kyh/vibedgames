/**
 * Provision the backing resources for the `preview` Worker environment.
 *
 * Previews deploy as a separate Worker (`vibedgames-web-preview`) bound to a
 * separate D1 database and a separate R2 bucket, so a preview build can never
 * read or write production data. This script creates those two resources if
 * they do not exist and writes the resulting D1 id into
 * `apps/web/wrangler.jsonc`, replacing the `PREVIEW_D1_DATABASE_ID`
 * placeholder.
 *
 * Idempotent: re-running it against an already-provisioned account finds the
 * existing resources and only rewrites the config if the id drifted.
 *
 *   pnpm preview:provision              # create + patch wrangler.jsonc
 *   pnpm preview:provision --check      # verify only, non-zero exit if unset
 *   pnpm -s preview:provision --print-id  # print the configured id, for CI
 *
 * Requires CLOUDFLARE_API_TOKEN (and CLOUDFLARE_ACCOUNT_ID) in the environment,
 * the same credentials the deploy workflow uses.
 */

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const webDir = join(repoRoot, "apps/web");
const configPath = join(webDir, "wrangler.jsonc");

/** Marker committed to wrangler.jsonc until a real database is provisioned. */
const PLACEHOLDER = "PREVIEW_D1_DATABASE_ID";
const D1_NAME = "vibedgames-preview";
const R2_BUCKET = "vibedgames-games-preview";

const checkOnly = process.argv.includes("--check");
/** Emit just the configured database id, for CI to consume. Implies --check. */
const printId = process.argv.includes("--print-id");

const wrangler = (args: string[]): string =>
  execFileSync("./node_modules/.bin/wrangler", args, {
    cwd: webDir,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  });

type D1ListEntry = { uuid: string; name: string };

const findDatabaseId = (): string | undefined => {
  // `d1 list --json` prints the account's databases; match on the exact name
  // rather than creating blindly, so re-runs don't pile up duplicates.
  const raw = wrangler(["d1", "list", "--json"]);
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) return undefined;
  const match = (parsed as D1ListEntry[]).find((d) => d.name === D1_NAME);
  return match?.uuid;
};

const ensureDatabase = (): string => {
  const existing = findDatabaseId();
  if (existing) {
    console.log(`d1: ${D1_NAME} already exists (${existing})`);
    return existing;
  }
  console.log(`d1: creating ${D1_NAME}…`);
  wrangler(["d1", "create", D1_NAME]);
  const created = findDatabaseId();
  if (!created) {
    throw new Error(`Created ${D1_NAME} but could not read its id back from 'd1 list'.`);
  }
  console.log(`d1: created ${D1_NAME} (${created})`);
  return created;
};

const bucketExists = (): boolean => {
  try {
    wrangler(["r2", "bucket", "info", R2_BUCKET]);
    return true;
  } catch {
    return false;
  }
};

const ensureBucket = (): void => {
  // Check existence first rather than creating and swallowing the error. A
  // blanket catch around `create` would report success for an auth failure, a
  // quota limit, or a typo'd bucket name, and provisioning would "succeed"
  // without a preview bucket. Anything that goes wrong below now propagates.
  if (bucketExists()) {
    console.log(`r2: ${R2_BUCKET} already exists`);
    return;
  }
  wrangler(["r2", "bucket", "create", R2_BUCKET]);
  console.log(`r2: created ${R2_BUCKET}`);
};

const readConfig = (): string => readFileSync(configPath, "utf8");

const currentConfiguredId = (): string | undefined => {
  // Deliberately a regex over the raw text rather than a JSONC parse: the file
  // is comment-heavy and hand-maintained, and a targeted replace preserves
  // every comment exactly as written.
  const match = /"database_name":\s*"vibedgames-preview",\s*"database_id":\s*"([^"]+)"/.exec(
    readConfig(),
  );
  return match?.[1];
};

if (checkOnly || printId) {
  const id = currentConfiguredId();
  if (!id || id === PLACEHOLDER) {
    console.error(
      !id
        ? `✗ No preview D1 binding found in ${configPath}`
        : `✗ Preview D1 is still the ${PLACEHOLDER} placeholder.\n` +
            `  Run 'pnpm preview:provision' with CLOUDFLARE_API_TOKEN set, then commit wrangler.jsonc.`,
    );
    process.exit(1);
  }
  // `--print-id` writes the bare id to stdout so CI can bind schema pushes to
  // the SAME database the Worker binds. Keeping the id in one place — the
  // committed wrangler.jsonc — is the point: a second copy in a CI secret can
  // drift, and then the schema lands in one database while traffic hits
  // another.
  console.log(printId ? id : `✓ Preview D1 configured (${id})`);
  process.exit(0);
}

const databaseId = ensureDatabase();
ensureBucket();

const config = readConfig();
const configured = currentConfiguredId();

if (configured === databaseId) {
  console.log("wrangler.jsonc: already up to date");
} else {
  if (!configured) {
    throw new Error(
      `Could not find the preview d1_databases block in ${configPath}. ` +
        `Expected a "database_name": "${D1_NAME}" entry under env.preview.`,
    );
  }
  writeFileSync(
    configPath,
    config.replace(`"database_id": "${configured}"`, `"database_id": "${databaseId}"`),
  );
  console.log(`wrangler.jsonc: preview database_id → ${databaseId}`);
}

console.log(
  "\nNext: push the schema and seed the preview database —\n" +
    `  CLOUDFLARE_DATABASE_ID=${databaseId} pnpm -F db push\n` +
    `  pnpm -C apps/web exec wrangler d1 execute ${D1_NAME} --remote --file=../../packages/db/seed.sql`,
);
