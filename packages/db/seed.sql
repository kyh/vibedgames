-- Local dev seed. Idempotent. Applied to the local Miniflare D1 via:
--   wrangler d1 execute vibedgames --local --file=packages/db/seed.sql
--
-- Gives Claude / devs a deterministic identity to drive the app headlessly:
--  - dev user (admin)
--  - invite code DEV123 (unlimited, for exercising signup)
--  - a long-lived session whose token is the CLI bearer (VG_TOKEN)
--  - browser-login accounts (password `password123` for both):
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

INSERT OR REPLACE INTO invite_code (id, code, max_uses, used_count, created_at)
VALUES (
  'dev-local-invite', 'DEV123', NULL, 0,
  cast(unixepoch('subsecond') * 1000 as integer)
);

-- Browser-login accounts. The password hash is better-auth's scrypt output
-- for `password123` (salt:hash format, precomputed — regenerate with
-- `node --input-type=module -e "import {hashPassword} from 'better-auth/crypto';
-- console.log(await hashPassword('password123'))"` if the hasher ever changes).
-- Credential accounts follow better-auth's convention: provider_id
-- 'credential', account_id = user id.

INSERT OR REPLACE INTO user (id, name, email, email_verified, role, created_at, updated_at)
VALUES
  ('dev-local-member', 'Dev Member', 'user@vibedgames.com', 1, 'user',
   cast(unixepoch('subsecond') * 1000 as integer),
   cast(unixepoch('subsecond') * 1000 as integer)),
  ('dev-local-admin', 'Dev Admin', 'admin@vibedgames.com', 1, 'admin',
   cast(unixepoch('subsecond') * 1000 as integer),
   cast(unixepoch('subsecond') * 1000 as integer));

INSERT OR REPLACE INTO account (id, account_id, provider_id, user_id, password, created_at, updated_at)
VALUES
  ('dev-local-member-cred', 'dev-local-member', 'credential', 'dev-local-member',
   'd1ea5799e425ed32cd5ba41fb3b6780f:2b514c99078ef449da467650ab2626666cb30c94550f0380264951a8e5352cd077073cb090ce09b4d5eaca92b7341de469209c94cc377c4fc5ba9e4db3d1e289',
   cast(unixepoch('subsecond') * 1000 as integer),
   cast(unixepoch('subsecond') * 1000 as integer)),
  ('dev-local-admin-cred', 'dev-local-admin', 'credential', 'dev-local-admin',
   'd1ea5799e425ed32cd5ba41fb3b6780f:2b514c99078ef449da467650ab2626666cb30c94550f0380264951a8e5352cd077073cb090ce09b4d5eaca92b7341de469209c94cc377c4fc5ba9e4db3d1e289',
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
