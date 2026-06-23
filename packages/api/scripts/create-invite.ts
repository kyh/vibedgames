#!/usr/bin/env tsx
/**
 * Mint invite codes directly in the D1 database.
 *
 * Inserts rows into the `invite_code` table via `wrangler d1 execute`. Mirrors
 * the admin `createInvites` tRPC mutation, but runnable from the shell without
 * an admin session — handy for seeding codes locally or in production.
 *
 *   pnpm -F @repo/api invite:create                       # one random single-use code
 *   pnpm -F @repo/api invite:create -- --code FRIEND       # a specific custom code
 *   pnpm -F @repo/api invite:create -- --count 10          # ten random codes
 *   pnpm -F @repo/api invite:create -- --max-uses 5 --note 'launch'
 *   pnpm -F @repo/api invite:create -- --expires-days 30
 *   pnpm -F @repo/api invite:create -- --code GOLDEN --max-uses 100 --remote
 *
 * Pass --remote to target production D1 (default is local).
 *
 * Notes:
 *   --code mints exactly one code with the value you give (normalized to
 *     upper-case, like the signup flow does), so it can't be combined with
 *     --count > 1.
 *   --max-uses defaults to 1; pass `unlimited` (or 0) for an uncapped code.
 *   created_by is left NULL since there's no acting admin session.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { generateShortCode } from "../src/auth/utils";

type Args = {
  code: string | null;
  count: number;
  maxUses: number | null;
  expiresDays: number | null;
  note: string | null;
  remote: boolean;
};

const usage =
  "Usage: pnpm -F @repo/api invite:create -- [--code <CODE>] [--count <n>]\n" +
  "         [--max-uses <n|unlimited>] [--expires-days <n>] [--note <text>] [--remote]\n" +
  "\n" +
  "  --code <CODE>          Mint one code with this exact value (default: random).\n" +
  "  --count <n>            How many random codes to mint (default: 1).\n" +
  "  --max-uses <n>         Uses per code before exhaustion (default: 1).\n" +
  "                         Pass `unlimited` or `0` for an uncapped code.\n" +
  "  --expires-days <n>     Expire codes n days from now (default: never).\n" +
  "  --note <text>          Free-text note stored alongside the code(s).\n" +
  "  --remote               Target production D1 (default: local).";

const parseArgs = (argv: string[]): Args => {
  const out: Args = {
    code: null,
    count: 1,
    maxUses: 1,
    expiresDays: null,
    note: null,
    remote: false,
  };
  // Read the value following a flag, erroring clearly if it's missing (e.g.
  // the flag was the last token) rather than letting `undefined` slip through.
  const nextValue = (i: number, flag: string): string => {
    const v = argv[i];
    if (v === undefined) {
      console.error(`${flag} expects a value.\n\n${usage}`);
      process.exit(1);
    }
    return v;
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--")
      continue; // bare separator forwarded by `pnpm run -- …`
    else if (arg === "--remote") out.remote = true;
    else if (arg === "--code") out.code = nextValue(++i, arg);
    else if (arg === "--count") out.count = Number(nextValue(++i, arg));
    else if (arg === "--max-uses") {
      const v = nextValue(++i, arg);
      out.maxUses = v === "unlimited" || v === "0" ? null : Number(v);
    } else if (arg === "--expires-days") out.expiresDays = Number(nextValue(++i, arg));
    else if (arg === "--note") out.note = nextValue(++i, arg);
    else if (arg === "--help" || arg === "-h") {
      console.log(usage);
      process.exit(0);
    } else {
      console.error(`Unknown argument: ${arg}\n\n${usage}`);
      process.exit(1);
    }
  }

  if (!Number.isInteger(out.count) || out.count < 1 || out.count > 100) {
    console.error("--count must be an integer between 1 and 100.");
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
  return out;
};

// SQLite/D1 string literal — single quotes doubled.
const lit = (s: string) => `'${s.replace(/'/g, "''")}'`;

// `n` distinct random codes — regenerates on the vanishingly rare in-batch repeat.
const uniqueCodes = (n: number): Set<string> => {
  const set = new Set<string>();
  while (set.size < n) set.add(generateShortCode());
  return set;
};

const main = () => {
  const args = parseArgs(process.argv.slice(2));
  const now = Date.now();
  const expiresAt = args.expiresDays === null ? null : now + args.expiresDays * 86_400_000;

  // A custom code is used verbatim; random codes are deduped within the batch
  // (the `code` column is UNIQUE, so an intra-batch repeat would fail the whole
  // INSERT). Collisions are astronomically unlikely with a 32^6 space, but the
  // Set makes intra-batch repeats impossible regardless.
  const codes = args.code ? [args.code] : Array.from(uniqueCodes(args.count));

  // Columns left to their schema defaults: used_count (0), revoked_at (NULL).
  // created_by is NULL — these codes aren't attributed to an admin session.
  const values = codes
    .map((code) => {
      const id = crypto.randomUUID();
      const maxUses = args.maxUses === null ? "NULL" : String(args.maxUses);
      const exp = expiresAt === null ? "NULL" : String(expiresAt);
      const note = args.note === null ? "NULL" : lit(args.note);
      return `(${lit(id)}, ${lit(code)}, NULL, ${now}, ${exp}, ${maxUses}, 0, NULL, ${note})`;
    })
    .join(",\n  ");

  const sql = `INSERT INTO invite_code (id, code, created_by, created_at, expires_at, max_uses, used_count, revoked_at, note)\nVALUES\n  ${values};`;

  const tmpDir = mkdtempSync(join(tmpdir(), "vg-invite-"));
  const sqlFile = join(tmpDir, "create-invite.sql");
  writeFileSync(sqlFile, sql);

  // packages/api/scripts → repo root → apps/web (where wrangler is configured).
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
  const cwd = join(repoRoot, "apps", "web");
  const wranglerArgs = [
    "wrangler",
    "d1",
    "execute",
    "vibedgames",
    `--file=${sqlFile}`,
    args.remote ? "--remote" : "--local",
  ];

  const target = args.remote ? "remote" : "local";
  console.log(`Creating ${codes.length} invite code(s) (${target} D1)…`);
  const result = spawnSync("pnpm", ["exec", ...wranglerArgs], { cwd, stdio: "inherit" });
  rmSync(tmpDir, { recursive: true, force: true });

  if (result.status !== 0) {
    console.error("\nwrangler exited with code", result.status);
    process.exit(result.status ?? 1);
  }

  const cap = args.maxUses === null ? "unlimited uses" : `${args.maxUses} use(s) each`;
  console.log(`\nCreated ${codes.length} invite code(s) — ${cap}:`);
  for (const code of codes) console.log(`  ${code}`);
};

main();
