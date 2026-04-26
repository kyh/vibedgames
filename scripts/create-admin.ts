#!/usr/bin/env tsx
/**
 * Bootstrap an admin user.
 *
 * Hashes the password with better-auth's scrypt and inserts directly into the
 * `user` + `account` tables via `wrangler d1 execute`. Used to mint the first
 * admin account before the invite-gated signup flow is usable.
 *
 *   pnpm admin:create -- --email me@x.com --password '...' --name 'Me'
 *   pnpm admin:create -- --email me@x.com --password '...' --name 'Me' --remote
 *
 * After the first admin exists, additional users can be created from the
 * /admin page in the web app.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { hashPassword } from "better-auth/crypto";

type Args = {
  email: string;
  password: string;
  name: string;
  remote: boolean;
};

const parseArgs = (argv: string[]): Args => {
  const out: Partial<Args> = { remote: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--remote") out.remote = true;
    else if (arg === "--email") out.email = argv[++i];
    else if (arg === "--password") out.password = argv[++i];
    else if (arg === "--name") out.name = argv[++i];
    else if (arg === "--help" || arg === "-h") {
      console.log(
        "Usage: pnpm admin:create -- --email <email> --password <password> --name <name> [--remote]",
      );
      process.exit(0);
    }
  }
  if (!out.email || !out.password || !out.name) {
    console.error("Missing required flags. Use --help for usage.");
    process.exit(1);
  }
  return out as Args;
};

// SQLite/D1 string literal — single quotes doubled.
const lit = (s: string) => `'${s.replace(/'/g, "''")}'`;

const main = async () => {
  const args = parseArgs(process.argv.slice(2));

  const passwordHash = await hashPassword(args.password);
  const userId = crypto.randomUUID();
  const accountId = crypto.randomUUID();
  const now = Date.now();

  // Two statements separated by `;`. D1 executes them in one batch.
  // `email_verified` is set true so the admin doesn't get blocked by any
  // future verification flow.
  const sql = [
    `INSERT INTO user (id, email, name, role, email_verified, created_at, updated_at)`,
    `VALUES (${lit(userId)}, ${lit(args.email)}, ${lit(args.name)}, 'admin', 1, ${now}, ${now});`,
    `INSERT INTO account (id, account_id, provider_id, user_id, password, created_at, updated_at)`,
    `VALUES (${lit(accountId)}, ${lit(args.email)}, 'credential', ${lit(userId)}, ${lit(passwordHash)}, ${now}, ${now});`,
  ].join(" ");

  const tmpDir = mkdtempSync(join(tmpdir(), "vg-admin-"));
  const sqlFile = join(tmpDir, "create-admin.sql");
  writeFileSync(sqlFile, sql);

  const repoRoot = join(fileURLToPath(import.meta.url), "..", "..");
  const cwd = join(repoRoot, "apps", "web");
  const wranglerArgs = [
    "wrangler",
    "d1",
    "execute",
    "vibedgames",
    `--file=${sqlFile}`,
    args.remote ? "--remote" : "--local",
  ];

  console.log(`Creating admin ${args.email} (${args.remote ? "remote" : "local"} D1)…`);
  const result = spawnSync("pnpm", ["exec", ...wranglerArgs], { cwd, stdio: "inherit" });
  rmSync(tmpDir, { recursive: true, force: true });

  if (result.status !== 0) {
    console.error("\nwrangler exited with code", result.status);
    process.exit(result.status ?? 1);
  }

  console.log(`\nAdmin user created: ${args.email}`);
  console.log("Sign in at /auth/login, then visit /admin.");
};

void main();
