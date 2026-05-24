-- Local dev seed. Idempotent. Applied to the local Miniflare D1 via:
--   wrangler d1 execute vibedgames --local --file=packages/db/seed.sql
--
-- Gives Claude / devs a deterministic identity to drive the app headlessly:
--  - dev user (admin)
--  - invite code DEV123 (for exercising signup)
--  - a long-lived session whose token is the CLI bearer (VG_TOKEN)
--
-- Never run against prod (no --remote).

INSERT OR REPLACE INTO user (id, name, email, email_verified, role, created_at, updated_at)
VALUES (
  'dev-local-user', 'Dev User', 'dev@vibedgames.local', 1, 'admin',
  cast(unixepoch('subsecond') * 1000 as integer),
  cast(unixepoch('subsecond') * 1000 as integer)
);

INSERT OR REPLACE INTO session (id, token, user_id, expires_at, created_at, updated_at)
VALUES (
  'dev-local-session', 'dev-local-session-token-0000000000', 'dev-local-user',
  cast((unixepoch() + 31536000) * 1000 as integer),
  cast(unixepoch('subsecond') * 1000 as integer),
  cast(unixepoch('subsecond') * 1000 as integer)
);

INSERT OR REPLACE INTO invite_code (id, code, max_uses, used_count, created_at)
VALUES (
  'dev-local-invite', 'DEV123', 100000, 0,
  cast(unixepoch('subsecond') * 1000 as integer)
);
