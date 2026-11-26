-- Local dev seed. Idempotent. Applied to the local Miniflare D1 via:
--   pnpm db:seed-local
--
-- Gives Claude / devs a deterministic identity to drive the app headlessly:
--  - dev user (admin)
--  - credit code DEV123 ($20 per redemption, unlimited uses, once per account)
--  - a long-lived session whose token is the CLI bearer (VG_TOKEN)
--  - browser-login accounts (sign in with a code from `pnpm sign-in-code <email>`):
--      user@vibedgames.com   (regular user)
--      admin@vibedgames.com  (admin)
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

INSERT OR REPLACE INTO invite_code (id, code, credit_micro, max_uses, used_count, created_at)
VALUES (
  'dev-local-invite', 'DEV123', 20000000, NULL, 0,
  cast(unixepoch('subsecond') * 1000 as integer)
);

-- Browser-login accounts. Sign-in is an emailed code, so a user row is the
-- whole account: `pnpm sign-in-code <email>` writes a fresh code for it into
-- the local D1 and prints it.

INSERT OR REPLACE INTO user (id, name, email, email_verified, role, created_at, updated_at)
VALUES
  ('dev-local-member', 'Dev Member', 'user@vibedgames.com', 1, 'user',
   cast(unixepoch('subsecond') * 1000 as integer),
   cast(unixepoch('subsecond') * 1000 as integer)),
  ('dev-local-admin', 'Dev Admin', 'admin@vibedgames.com', 1, 'admin',
   cast(unixepoch('subsecond') * 1000 as integer),
   cast(unixepoch('subsecond') * 1000 as integer));

-- Sample games for the admin account: a subset of the games actually deployed
-- in prod, so game URLs (and favicons — starfall serves a real one, the rest
-- fall back) resolve against the live subdomains. Local-D1 rows only; the
-- games themselves are served by prod. moon-lander models the one non-live
-- state that really occurs: a game whose deploy never finalized
-- (current_deployment_id NULL). A current deployment is always 'ready' —
-- finalize sets the pointer and the status together.

INSERT OR REPLACE INTO game (id, user_id, slug, name, current_deployment_id, created_at, updated_at)
VALUES
  ('seed-game-starfall', 'dev-local-admin', 'starfall', 'Starfall',
   'seed-dep-starfall',
   cast(unixepoch('subsecond') * 1000 as integer),
   cast(unixepoch('subsecond') * 1000 as integer)),
  ('seed-game-lunerfall', 'dev-local-admin', 'lunerfall', 'Lunerfall',
   'seed-dep-lunerfall',
   cast(unixepoch('subsecond') * 1000 as integer),
   cast(unixepoch('subsecond') * 1000 as integer)),
  ('seed-game-waymo', 'dev-local-admin', 'crazy-waymo', 'Crazy Waymo',
   'seed-dep-waymo',
   cast(unixepoch('subsecond') * 1000 as integer),
   cast(unixepoch('subsecond') * 1000 as integer)),
  ('seed-game-tetris', 'dev-local-admin', 'tetris', 'Tetris',
   'seed-dep-tetris',
   cast(unixepoch('subsecond') * 1000 as integer),
   cast(unixepoch('subsecond') * 1000 as integer)),
  ('seed-game-pending', 'dev-local-admin', 'moon-lander', 'Moon Lander', NULL,
   cast(unixepoch('subsecond') * 1000 as integer),
   cast(unixepoch('subsecond') * 1000 as integer));

INSERT OR REPLACE INTO deployment (id, game_id, status, file_count, total_bytes, created_at)
VALUES
  ('seed-dep-starfall', 'seed-game-starfall', 'ready', 42, 18400000,
   cast(unixepoch('subsecond') * 1000 as integer)),
  ('seed-dep-lunerfall', 'seed-game-lunerfall', 'ready', 96, 31200000,
   cast(unixepoch('subsecond') * 1000 as integer)),
  ('seed-dep-waymo', 'seed-game-waymo', 'ready', 178, 84500000,
   cast(unixepoch('subsecond') * 1000 as integer)),
  ('seed-dep-tetris', 'seed-game-tetris', 'ready', 12, 2100000,
   cast(unixepoch('subsecond') * 1000 as integer));
