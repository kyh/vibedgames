import { createHmac } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";

import { inviteCode } from "../src/drizzle-schema";
import { session, user } from "../src/drizzle-schema-auth";
import { readDevVar, repoRoot, requireLocalD1 } from "./local-d1";

// Deterministic local identity so Claude / devs can act as a logged-in user
// headlessly — no browser device-flow, no prod. Reseeding is idempotent.
const DEV = {
  userId: "dev-local-user",
  email: "dev@vibedgames.local",
  name: "Dev User",
  // Opaque session token used as the CLI bearer (VG_TOKEN) and, once signed,
  // as the web session cookie. Fixed so scripts can hard-code it.
  sessionToken: "dev-local-session-token-0000000000",
  inviteCode: "DEV123",
} as const;

const dbPath = requireLocalD1();
const db = drizzle(createClient({ url: `file:${dbPath}` }));

const now = new Date();
const yearOut = new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000);

await db
  .insert(user)
  .values({
    id: DEV.userId,
    name: DEV.name,
    email: DEV.email,
    emailVerified: true,
    role: "admin",
    createdAt: now,
    updatedAt: now,
  })
  .onConflictDoUpdate({
    target: user.id,
    set: { email: DEV.email, name: DEV.name, role: "admin", updatedAt: now },
  });

await db
  .insert(session)
  .values({
    id: "dev-local-session",
    token: DEV.sessionToken,
    userId: DEV.userId,
    expiresAt: yearOut,
    createdAt: now,
    updatedAt: now,
  })
  .onConflictDoUpdate({
    target: session.id,
    set: { token: DEV.sessionToken, expiresAt: yearOut, updatedAt: now },
  });

await db
  .insert(inviteCode)
  .values({
    id: "dev-local-invite",
    code: DEV.inviteCode,
    maxUses: 100000,
    usedCount: 0,
    createdAt: now,
  })
  .onConflictDoUpdate({
    target: inviteCode.id,
    set: { code: DEV.inviteCode, maxUses: 100000 },
  });

// Sign the token exactly like better-call's cookie signer (which better-auth
// uses): standard-base64 HMAC-SHA256, joined as `token.signature`, then the
// whole thing URI-encoded — so the value drops straight into the session
// cookie for headless browser auth.
const secret = readDevVar("AUTH_SECRET") ?? "local-dev-secret-change-me";
const signature = createHmac("sha256", secret).update(DEV.sessionToken).digest("base64");
const signedCookie = encodeURIComponent(`${DEV.sessionToken}.${signature}`);

const out = {
  userId: DEV.userId,
  email: DEV.email,
  inviteCode: DEV.inviteCode,
  token: DEV.sessionToken,
  cookieName: "better-auth.session_token",
  signedCookie,
};
writeFileSync(join(repoRoot, "apps/web/.dev-session.json"), JSON.stringify(out, null, 2));

console.log("Seeded local dev identity:");
console.log(`  user:        ${DEV.email} (${DEV.userId}, role=admin)`);
console.log(`  invite code: ${DEV.inviteCode}`);
console.log(`  VG_TOKEN:    ${DEV.sessionToken}`);
console.log(`  cookie:      better-auth.session_token=${signedCookie}`);
console.log("  wrote apps/web/.dev-session.json");
console.log(
  "\nCLI:  VG_API_URL=http://localhost:5173 VG_TOKEN=" + DEV.sessionToken + " vg media models",
);
