import { randomInt, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

import { localD1File } from "./local-d1.ts";

const CODE_TTL_MS = 5 * 60 * 1000;

const email = (process.argv[2] ?? "user@vibedgames.com").toLowerCase();
const otp = String(randomInt(0, 1_000_000)).padStart(6, "0");
const identifier = `sign-in-otp-${email}`;
const now = Date.now();

const db = new DatabaseSync(localD1File());

try {
  db.prepare("DELETE FROM verification WHERE identifier = ?").run(identifier);
  db.prepare(
    "INSERT INTO verification (id, identifier, value, expires_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(randomUUID(), identifier, `${otp}:0`, now + CODE_TTL_MS, now, now);
} finally {
  db.close();
}

console.log(otp);
