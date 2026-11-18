#!/usr/bin/env tsx
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline/promises";

import { hashPassword } from "better-auth/crypto";

const parseArgs = (argv: string[]) => {
  let email: string | undefined;
  let name: string | undefined;
  let remote = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];

    if (arg === "--remote") {
      remote = true;
    } else if (arg === "--email") {
      email = argv[(i += 1)];
    } else if (arg === "--name") {
      name = argv[(i += 1)];
    } else if (arg === "--help" || arg === "-h") {
      console.log(
        "Usage: ADMIN_PASSWORD='...' pnpm admin:create -- --email <email> --name <name> [--remote]\n" +
          "       pnpm admin:create -- --email <email> --name <name>   # prompts for password",
      );
      process.exit(0);
    }
  }

  if (!email || !name) {
    console.error("Missing required flags. Use --help for usage.");
    process.exit(1);
  }

  return { email, name, remote };
};

const readPassword = async () => {
  const fromEnv = process.env.ADMIN_PASSWORD;

  if (fromEnv) {
    return fromEnv;
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const { stdin } = process;
  process.stdout.write("Password: ");

  let muted = false;
  const writeOriginal = process.stdout.write.bind(process.stdout);

  if (stdin.isTTY) {
    muted = true;
    process.stdout.write = (chunk: string | Uint8Array) => {
      if (muted && !(chunk instanceof Uint8Array) && chunk !== "Password: ") {
        return true;
      }

      return writeOriginal(chunk);
    };
  }

  const password = await rl.question("");

  if (muted) {
    process.stdout.write = writeOriginal;
  }

  rl.close();
  process.stdout.write("\n");

  return password;
};

const lit = (s: string) => `'${s.replaceAll("'", "''")}'`;

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

  const sql = [
    `INSERT INTO user (id, email, name, role, email_verified, created_at, updated_at)`,
    `VALUES (${lit(userId)}, ${lit(args.email)}, ${lit(args.name)}, 'admin', 1, ${now}, ${now});`,
    `INSERT INTO account (id, account_id, provider_id, user_id, password, created_at, updated_at)`,
    `VALUES (${lit(accountId)}, ${lit(userId)}, 'credential', ${lit(userId)}, ${lit(passwordHash)}, ${now}, ${now});`,
  ].join(" ");

  const tmpDir = mkdtempSync(path.join(tmpdir(), "vg-admin-"));
  const sqlFile = path.join(tmpDir, "create-admin.sql");
  writeFileSync(sqlFile, sql);

  const executeArgs = [
    "-F",
    "db",
    "exec",
    "tsx",
    "d1-execute.ts",
    "--file",
    sqlFile,
    ...(args.remote ? ["--remote"] : []),
  ];

  console.log(`Creating admin ${args.email} (${args.remote ? "remote" : "local"} D1)…`);
  const result = spawnSync("pnpm", executeArgs, { stdio: "inherit" });
  rmSync(tmpDir, { force: true, recursive: true });

  if (result.status !== 0) {
    console.error("\nd1-execute exited with code", result.status);
    process.exit(result.status ?? 1);
  }

  console.log(`\nAdmin user created: ${args.email}`);
  console.log("Sign in at /auth/login, then visit /admin.");
};

void main();
