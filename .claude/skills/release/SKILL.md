---
name: release
description: Bump, build, publish, tag, and changelog vibedgames npm packages — `vibedgames` (CLI) and/or `@vibedgames/multiplayer`. Skips packages with no changes since last release. Use when the user wants to ship a new version. Args optional: package(s) and bump type, e.g. "release multiplayer patch", "release cli minor", "release both patch".
allowed-tools: Bash(*), Read, Edit, Write
---

# Release

Cut a new npm version of one or both publishable packages in this repo.

## Context

- Repo root: `/Users/kyh/Documents/Projects/vibedgames`
- Publishable packages (path = where commits "count" for change detection):
  - `vibedgames` → `apps/cli` → tag prefix `vibedgames@`
  - `@vibedgames/multiplayer` → `packages/multiplayer` → tag prefix `@vibedgames/multiplayer@`
- Both ship `dist/` built by `tsc`. `tsBuildInfoFile` lives in `dist/.tsbuildinfo` so cleaning dist invalidates incremental cache.
- No internal workspace consumers — these are end-user packages. No downstream sync needed.
- Current branch: !`git -C /Users/kyh/Documents/Projects/vibedgames rev-parse --abbrev-ref HEAD`
- Working tree: !`git -C /Users/kyh/Documents/Projects/vibedgames status --short`

## Arguments

Parse from the user message:
- Which package(s): `cli`, `multiplayer`, or `both`. Default `both`.
- Bump type: `patch`, `minor`, `major`. Default `patch`.
- `--force` to release even if no changes since last tag (otherwise unchanged packages are skipped).

If ambiguous, ask in one short sentence before proceeding.

## Process

### 1. Preflight

Run in parallel:
- `npm whoami` — must be `kaiyuhsu`. If not, stop and tell the user to `npm login`.
- `git status --porcelain` — if dirty in unrelated files, surface and ask whether to proceed.
- `npm view vibedgames version` and/or `npm view @vibedgames/multiplayer version` — current published.
- For each candidate package, find its last release tag and check for changes:
  ```
  LAST=$(git tag --list '<tag-prefix>*' --sort=-v:refname | head -1)
  git log --oneline ${LAST:+$LAST..}HEAD -- <pkg-path>
  ```
  If the log is empty and `--force` was not passed, **drop that package from the release set** with a note. If both packages drop, stop.

### 2. Bump

Edit `version` in each remaining target's `package.json`. Keep semver. If the published `latest` is ahead of the local file (out-of-band publish), use the published version as the floor and bump from there.

### 3. Changelog

For each remaining target, prepend a new entry to `<pkg-path>/CHANGELOG.md` (create the file if missing). Source the bullets from `git log --pretty='- %s' ${LAST:+$LAST..}HEAD -- <pkg-path>`, dropping merge commits and the previous bump commits. Format:

```markdown
# Changelog

## <new-version> — <YYYY-MM-DD>

- <commit subject>
- <commit subject>
```

Keep bullets terse — sacrifice grammar for concision. Drop noise like "fix typo" or pure dependency bumps unless they're the whole release. If unsure, show the proposed entry to the user before writing.

### 4. Install + build

- `pnpm install` from repo root — defensive; deps may be unlinked after a pull.
- For each target, force a clean build:
  - `rm -rf <pkg-path>/dist`
  - `pnpm --filter <pkg-name> build`
- Verify `dist/` exists and is non-empty.

### 5. Publish

For each target, from its directory:
```
pnpm publish --access public --no-git-checks
```
- `--access public` is required.
- `--no-git-checks` because we commit + tag *after* publish (so we don't tag a commit for a publish that failed).

### 6. Verify

`npm view <pkg> dist-tags` — confirm `latest` matches the new version. Registry can lag a few seconds; retry once after `sleep 5` if needed before flagging.

### 7. Commit + tag

Single commit covering all bumps + changelogs:
```
release: <pkg>@<version>[, <pkg>@<version>]
```
Stage the changed `package.json` and `CHANGELOG.md` files only. Then create one annotated tag per released package pointing at that commit:
```
git tag -a '<pkg-name>@<version>' -m '<pkg-name>@<version>'
```
For `@vibedgames/multiplayer` this means a tag literally named `@vibedgames/multiplayer@0.0.3` — git accepts `@` in tag names. Do not push commits or tags.

### 8. Report

One short block:
```
Released:
  vibedgames@X.Y.Z          (tag: vibedgames@X.Y.Z)
  @vibedgames/multiplayer@X.Y.Z (tag: @vibedgames/multiplayer@X.Y.Z)
Skipped (no changes): <pkg> (since <last-tag>)
Commit: <sha>
Push:  git push --follow-tags
```
If anything failed, lead with the failure and what state the registry is in (published vs not).

## Rules

- Never run `wrangler deploy` here. This skill is npm-only. Worker deploys go through GitHub Actions on push to main.
- Never `--force` push or amend prior release commits. If a publish half-succeeds (e.g. one of two packages), commit + tag what shipped, then handle the other separately.
- If `npm publish` fails with `EPUBLISHCONFLICT` (version already on registry), bump again rather than try to overwrite.
- Tags must be created **after** successful publish + verify, never before. A tag without a matching registry version is worse than no tag.
- Skipping is the default for packages with no path-scoped commits since their last tag. Pass `--force` to override.
- Bootstrap: if no prior tag exists for a package, treat all of its history as "the changes" — but cap the changelog bullets at the last 20 commits to keep it readable.
