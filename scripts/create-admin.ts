#!/usr/bin/env tsx
/**
 * Bootstrap an admin user.
 *
 * Hashes the password with better-auth's scrypt and inserts directly into the
 * `user` + `account` tables via `wrangler d1 execute`. Used to mint the first
 * admin account before the invite-gated signup flow is usable.
 *
 *   ADMIN_PASSWORD='...' pnpm admin:create -- --email me@x.com --name 'Me'
 *   pnpm admin:create -- --email me@x.com --name 'Me'   # prompts for password
 *
 * Pass --remote to target production D1 (default is local).
 *
 * After the first admin exists, additional users can be created from the
 * /admin page in the web app.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

import { hashPassword } from "better-auth/crypto";

type Args = {
  email: string;
  name: string;
  remote: boolean;
};

const parseArgs = (argv: string[]): Args => {
  const out: Partial<Args> = { remote: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--remote") out.remote = true;
    else if (arg === "--email") out.email = argv[++i];
    else if (arg === "--name") out.name = argv[++i];
    else if (arg === "--help" || arg === "-h") {
      console.log(
        "Usage: ADMIN_PASSWORD='...' pnpm admin:create -- --email <email> --name <name> [--remote]\n" +
          "       pnpm admin:create -- --email <email> --name <name>   # prompts for password",
      );
      process.exit(0);
    }
  }
  if (!out.email || !out.name) {
    console.error("Missing required flags. Use --help for usage.");
    process.exit(1);
  }
  return out as Args;
};

/**
 * Read a password from stdin without echoing it. Falls back to a visible
 * prompt if stdin isn't a TTY (e.g. piped input). Avoids putting the secret
 * on the argv (visible in `ps` and shell history).
 */
const readPassword = async (): Promise<string> => {
  const fromEnv = process.env.ADMIN_PASSWORD;
  if (fromEnv) return fromEnv;

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const stdin = process.stdin;
  process.stdout.write("Password: ");

  let muted = false;
  const writeOriginal = process.stdout.write.bind(process.stdout);
  if (stdin.isTTY) {
    muted = true;
    process.stdout.write = ((chunk: string | Uint8Array) => {
      if (muted && typeof chunk === "string" && chunk !== "Password: ") return true;
      return writeOriginal(chunk);
    }) as typeof process.stdout.write;
  }

  const password = await new Promise<string>((resolve) => rl.question("", resolve));
  if (muted) process.stdout.write = writeOriginal;
  rl.close();
  process.stdout.write("\n");
  return password;
};

// SQLite/D1 string literal — single quotes doubled.
const lit = (s: string) => `'${s.replace(/'/g, "''")}'`;

const main = async () => {
  const args = parseArgs(process.argv.slice(2));
  const password = await readPassword();
  if (password.length < 8) {
    console.error("Password must be at least 8 characters.");
    process.exit(1);
  }

  const passwordHash = await hashPassword(password);
  const userId = crypto.randomUUID();
  const accountId = crypto.randomUUID();
  const now = Date.now();

  // Two statements separated by `;`. D1 executes them in one batch.
  // `email_verified` is set true so the admin doesn't get blocked by any
  // future verification flow. For credential accounts better-auth uses the
  // user's ID as `account_id` (see sign-up.mjs in better-auth).
  const sql = [
    `INSERT INTO user (id, email, name, role, email_verified, created_at, updated_at)`,
    `VALUES (${lit(userId)}, ${lit(args.email)}, ${lit(args.name)}, 'admin', 1, ${now}, ${now});`,
    `INSERT INTO account (id, account_id, provider_id, user_id, password, created_at, updated_at)`,
    `VALUES (${lit(accountId)}, ${lit(userId)}, 'credential', ${lit(userId)}, ${lit(passwordHash)}, ${now}, ${now});`,
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
