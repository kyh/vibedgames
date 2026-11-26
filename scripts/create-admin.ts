#!/usr/bin/env tsx
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

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
      console.log("Usage: pnpm admin:create -- --email <email> --name <name> [--remote]");
      process.exit(0);
    }
  }

  if (email === undefined || email === "" || name === undefined || name === "") {
    console.error("Missing required flags. Use --help for usage.");
    process.exit(1);
  }

  return { email, name, remote };
};

const lit = (s: string) => `'${s.replaceAll("'", "''")}'`;

const main = () => {
  const args = parseArgs(process.argv.slice(2));
  const userId = crypto.randomUUID();
  const now = Date.now();

  const sql = [
    `INSERT INTO user (id, email, name, role, email_verified, created_at, updated_at)`,
    `VALUES (${lit(userId)}, ${lit(args.email.toLowerCase())}, ${lit(args.name)}, 'admin', 1, ${now}, ${now});`,
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
  console.log("Sign in at /auth/login with the code emailed to that address, then visit /admin.");
};

main();
