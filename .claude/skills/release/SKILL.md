---
name: release
description: Bump, build, and publish vibedgames npm packages — `vibedgames` (CLI) and/or `@vibedgames/multiplayer`. Use when the user wants to ship a new version. Args optional: package(s) and bump type, e.g. "release multiplayer patch", "release cli minor", "release both patch".
allowed-tools: Bash(*), Read, Edit
---

# Release

Cut a new npm version of one or both publishable packages in this repo.

## Context

- Repo root: `/Users/kyh/Documents/Projects/vibedgames`
- Publishable packages:
  - `vibedgames` → `apps/cli/package.json`
  - `@vibedgames/multiplayer` → `packages/multiplayer/package.json`
- Both ship a `dist/` built by `tsc`. `tsBuildInfoFile` lives in `dist/.tsbuildinfo` so cleaning dist invalidates incremental cache.
- No internal workspace consumers — these are end-user packages. No downstream sync needed.
- Current branch: !`git -C /Users/kyh/Documents/Projects/vibedgames rev-parse --abbrev-ref HEAD`
- Working tree: !`git -C /Users/kyh/Documents/Projects/vibedgames status --short`

## Arguments

Parse from the user message:
- Which package(s): `cli`, `multiplayer`, or `both`. Default `both`.
- Bump type: `patch`, `minor`, `major`. Default `patch`.

If ambiguous, ask in one short sentence before proceeding.

## Process

### 1. Preflight

Run in parallel:
- `npm whoami` — must be `kaiyuhsu`. If not, stop and tell the user to `npm login`.
- `git -C <repo> status --porcelain` — if dirty in unrelated files, surface and ask whether to proceed.
- `npm view vibedgames version` and/or `npm view @vibedgames/multiplayer version` — current published.

### 2. Bump

Edit `version` in the target package.json file(s). Keep semver. If the published `latest` is ahead of the local file (someone published out-of-band), use the published version as the floor and bump from there.

### 3. Install + build

- `pnpm -C <repo> install` — defensive; deps may be unlinked after a pull.
- For each target, force a clean build to avoid stale incremental state:
  - `rm -rf <pkg>/dist`
  - then build via the package's own script: `pnpm --filter <pkg-name> build`
- Verify `dist/` exists and is non-empty.

### 4. Publish

For each target, from its directory:
```
pnpm publish --access public --no-git-checks
```
- `--access public` is required (npm scoped + unscoped both fine with it).
- `--no-git-checks` because we commit *after* publish (so we don't tag a commit for a publish that failed).

### 5. Verify

`npm view <pkg> dist-tags` — confirm `latest` matches the new version. Registry can lag a few seconds; retry once after `sleep 5` if needed before flagging.

### 6. Commit

Single commit covering both bumps if both were released:
```
bump <pkg> [+ <pkg>] to <version>, publish
```
Stage only the changed `package.json` files. Do not push.

### 7. Report

One short block:
```
Published:
  vibedgames@X.Y.Z
  @vibedgames/multiplayer@X.Y.Z
Commit: <sha>
```
If anything failed, lead with the failure and what state the registry is in (published vs not).

## Rules

- Never run `wrangler deploy` here. This skill is npm-only. Worker deploys go through GitHub Actions on push to main.
- Never `--force` push or amend prior release commits. If a publish half-succeeds (e.g. one of two packages), commit what shipped, then handle the other separately.
- If `npm publish` fails with `EPUBLISHCONFLICT` (version already on registry), bump again rather than try to overwrite.
- Don't bump versions on packages that didn't actually change since last publish unless the user explicitly asks. Check `git log <pkg-path>` against the last release commit to decide.
