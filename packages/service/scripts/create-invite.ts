#!/usr/bin/env tsx
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { MAX_INVITE_BATCH } from "@repo/contract/auth/auth-limits";

import { buildInviteRows } from "../src/auth/invite-create";
import { usdToMicro } from "../src/credits/credit-ledger";

interface Args {
  code: string | null;
  count: number;
  creditUsd: number;
  maxUses: number | null;
  expiresDays: number | null;
  note: string | null;
  remote: boolean;
}

const usage =
  "Usage: pnpm exec tsx packages/service/scripts/create-invite.ts -- [--code <CODE>]\n" +
  "         [--count <n>] [--credit-usd <n>] [--max-uses <n|unlimited>] [--expires-days <n>] [--note <text>] [--remote]\n" +
  "\n" +
  "  --code <CODE>          Mint one code with this exact value (default: random).\n" +
  "  --count <n>            How many random codes to mint (default: 1).\n" +
  "  --credit-usd <n>       Dollars of credit one redemption grants (default: 20).\n" +
  "  --max-uses <n>         Uses per code before exhaustion (default: 1).\n" +
  "                         Pass `unlimited` or `0` for an uncapped code.\n" +
  "  --expires-days <n>     Expire codes n days from now (default: never).\n" +
  "  --note <text>          Free-text note stored alongside the code(s).\n" +
  "  --remote               Target production D1 (default: local).";

const validateArgs = (out: Args) => {
  if (!Number.isInteger(out.count) || out.count < 1 || out.count > MAX_INVITE_BATCH) {
    console.error(`--count must be an integer between 1 and ${MAX_INVITE_BATCH}.`);
    process.exit(1);
  }

  if (!Number.isFinite(out.creditUsd) || out.creditUsd <= 0 || out.creditUsd > 1000) {
    console.error("--credit-usd must be a positive number of dollars, at most 1000.");
    process.exit(1);
  }

  if (out.maxUses !== null && (!Number.isInteger(out.maxUses) || out.maxUses < 1)) {
    console.error("--max-uses must be a positive integer, or `unlimited`.");
    process.exit(1);
  }

  if (out.expiresDays !== null && (!Number.isFinite(out.expiresDays) || out.expiresDays <= 0)) {
    console.error("--expires-days must be a positive number.");
    process.exit(1);
  }

  if (out.code !== null) {
    out.code = out.code.trim().toUpperCase();

    if (!out.code) {
      console.error("--code cannot be empty.");
      process.exit(1);
    }

    if (out.count > 1) {
      console.error("--code mints a single code; drop --count (or use it without --code).");
      process.exit(1);
    }
  }
};

const parseArgs = (argv: string[]) => {
  const out: Args = {
    code: null,
    count: 1,
    creditUsd: 20,
    expiresDays: null,
    maxUses: 1,
    note: null,
    remote: false,
  };

  const nextValue = (i: number, flag: string) => {
    const v = argv[i];

    if (v === undefined) {
      console.error(`${flag} expects a value.\n\n${usage}`);
      process.exit(1);
    }

    return v;
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];

    if (arg === "--") {
      continue;
    } else if (arg === "--remote") {
      out.remote = true;
    } else if (arg === "--code") {
      out.code = nextValue((i += 1), arg);
    } else if (arg === "--count") {
      out.count = Number(nextValue((i += 1), arg));
    } else if (arg === "--credit-usd") {
      out.creditUsd = Number(nextValue((i += 1), arg));
    } else if (arg === "--max-uses") {
      const v = nextValue((i += 1), arg);
      out.maxUses = v === "unlimited" || v === "0" ? null : Number(v);
    } else if (arg === "--expires-days") {
      out.expiresDays = Number(nextValue((i += 1), arg));
    } else if (arg === "--note") {
      out.note = nextValue((i += 1), arg);
    } else if (arg === "--help" || arg === "-h") {
      console.log(usage);
      process.exit(0);
    } else {
      console.error(`Unknown argument: ${arg}\n\n${usage}`);
      process.exit(1);
    }
  }

  validateArgs(out);

  return out;
};

const lit = (v: string | null) => (v === null ? "NULL" : `'${v.replaceAll("'", "''")}'`);

const main = () => {
  const args = parseArgs(process.argv.slice(2));

  let rows: ReturnType<typeof buildInviteRows>;

  try {
    rows = buildInviteRows({
      code: args.code,
      count: args.count,
      createdBy: null,
      creditMicro: usdToMicro(args.creditUsd),
      expiresAt:
        args.expiresDays === null ? null : new Date(Date.now() + args.expiresDays * 86_400_000),
      maxUses: args.maxUses,
      note: args.note,
    });
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }

  const values = rows
    .map((r) => {
      const maxUses = r.maxUses === null || r.maxUses === undefined ? "NULL" : String(r.maxUses);

      const exp =
        r.expiresAt === null || r.expiresAt === undefined ? "NULL" : String(r.expiresAt.getTime());

      return `(${lit(r.id ?? null)}, ${lit(r.code)}, ${lit(r.createdBy ?? null)}, ${r.creditMicro}, ${maxUses}, ${exp}, ${lit(r.note ?? null)})`;
    })
    .join(",\n  ");

  const sql = `INSERT INTO invite_code (id, code, created_by, credit_micro, max_uses, expires_at, note)\nVALUES\n  ${values};`;

  const tmpDir = mkdtempSync(path.join(tmpdir(), "vg-invite-"));
  const sqlFile = path.join(tmpDir, "create-invite.sql");
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

  const target = args.remote ? "remote" : "local";
  console.log(`Creating ${rows.length} credit code(s) (${target} D1)…`);
  const result = spawnSync("pnpm", executeArgs, { stdio: "inherit" });
  rmSync(tmpDir, { force: true, recursive: true });

  if (result.status !== 0) {
    console.error("\nd1-execute exited with code", result.status);
    process.exit(result.status ?? 1);
  }

  const cap = args.maxUses === null ? "unlimited uses" : `${args.maxUses} use(s) each`;
  console.log(`\nCreated ${rows.length} credit code(s) worth $${args.creditUsd} — ${cap}:`);

  for (const r of rows) {
    console.log(`  ${r.code}`);
  }
};

main();
