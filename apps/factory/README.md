# @repo/factory — autonomous game factory

The **factory** runs one autonomous **agent** per game. Each agent builds **one**
browser game end-to-end and then **runs it like a studio** — shipping bug fixes,
new features, gameplay & balance iteration, content, and polish — with no human
in the loop. You start an agent with a one-line idea; it keeps running until you
stop it.

Each agent operates in the shape of Vercel's [Eve](https://vercel.com/blog/introducing-eve):

- **A durable, checkpointed loop.** Every turn is written to disk (`.vgfactory/`),
  so an agent survives crashes, restarts, and individual context windows and
  resumes exactly where it stopped.
- **Clean-context subagents.** Each phase spawns a fresh headless Claude Code
  session — a specialist (director / designer / engineer / artist / QA /
  shipper) that starts with a clean context window and the full toolbelt.
  Everything it needs to know lives on disk, not in memory.
- **Filesystem-first definitions.** A subagent is a directory of markdown under
  [`agents/`](./agents): its name and place in the tree _is_ its definition.
  Edit the markdown (prompt or emoji) to redefine a subagent — no code change.
- **Per-turn observability.** Every turn appends one span to
  `.vgfactory/trace.jsonl` (role, phase, cost, duration, outcome) — an append-only,
  machine-readable trail you can replay, audit, or monitor.
- **Human-in-the-loop.** Production deploys are gated on your approval; the agent
  keeps improving the game locally and never publishes without you.
- **Sandboxed workspace.** The agent works only inside its game workspace, and
  runs each subagent's tools there.

The agent does not reimplement any game knowledge. It drives the **vibedgames
skills** and the **`vg` CLI** through its subagents.

You run it with **pnpm scripts** from `apps/factory/` (or with `-F @repo/factory`
from the repo root):

```
pnpm start                   # open the dashboard — set up a new game on the setup screen
pnpm start --dir ~/games/my-proto    # adopt & evolve whatever project lives in that folder
pnpm start   neon-slasher --idea "a top-down neon slasher where every hit shakes the screen"
# …builds, generates art, iterates forever — but does NOT publish until you approve…
pnpm status  neon-slasher    # peek at progress
pnpm approve neon-slasher    # publish the current build to neon-slasher.vibedgames.com
pnpm stop    neon-slasher    # graceful stop (or just Ctrl-C / the S key)
```

### Interactive dashboard (TUI)

In a terminal, `pnpm start` opens the interactive dashboard
([opentui](https://github.com/anomalyco/opentui)). Run it **with no arguments**
and it lands on the **setup screen**:

- **FOLDER** — optional: where the game lives. Point it at a directory that
  already contains a project and the agent **builds upon what's there** (the
  hint under the field confirms detection). Empty or omitted → a game from
  scratch.
- **INSTRUCTIONS** — what should it build? Required when starting from
  scratch; optional extra direction when the folder already has a project.
- **SLUG** — optional. The slug is just the game's deploy identity
  (`{slug}.vibedgames.com` + the default workspace name); leave it blank and
  it's derived from the folder name, else the instructions — the hint shows
  the resolved subdomain live.
- **MODEL** — optional. A stepper (`⇅`): `↑`/`↓` cycles fable / opus /
  sonnet (claude) and gpt-5.6-sol / gpt-5.5 (codex). Defaults to the launch
  flags; `--model` covers anything not in the menu.

`TAB`/`↑↓` move between fields, `ENTER` starts, `ESC` quits. From the command
line, `pnpm start <slug>` resumes a game and `pnpm start --dir <folder>`
adopts one directly — both skip the setup screen.

The dashboard shows run status + spend, a phase/cycle/deploy strip, the
scrollable **ACTIVITY** feed of what the current subagent is doing, the
director's **BACKLOG** (on terminals ≥ 96 cols), and the current turn with
elapsed time. Left alone, the loop just keeps going — the hotkeys steer it at
runtime without stopping it:

- **`i`** — **steer**: type a directive ("focus on mobile controls") — it's
  injected into every subagent task until you change it (empty clears it)
- **`p`** — pause after the current step / resume
- **`s`** — stop after the current step · **`⇧S`** — stop at the next release
  point (a ship, or a ship-ready build)
- **`a`** — approve one deployment (same as `pnpm approve <slug>`)
- **`enter`** — resume a stopped agent from its saved phase
- **`↑↓` / `PgUp`** — scroll the activity feed
- **`q` / Ctrl-C** — stop, then exit; press again while stopping to force quit

### Checkpoints (the agent asks for feedback)

At real milestones — first playable, a big feature, a release — the director
writes `.vgfactory/checkpoint.md`, and the loop **holds with a countdown**
(`--checkpoint-wait`, default 120s): the dashboard shows what it wants you to
test and what it's asking. Press `ENTER` to continue now, `i` to respond (your
directive answers it and continues), `s` to stop — or say nothing and it keeps
going on its own.

### Built-in quality ratchet

The loop can't run forever on the agents' word alone, so the harness enforces:

- **Quality gate** — after engineering phases the orchestrator itself runs the
  workspace's `typecheck` + `build` scripts and refuses to advance on red (the
  phase retries with the failure in the journal).
- **Git ratchet** — every successful phase is a commit in the game workspace
  (`.vgfactory/` stays out of history), so a phase that made things worse is a
  `git revert`, not a hope the next agent notices.
- **Journal compaction** — `journal.md` is kept bounded (newest 40 entries);
  older history lives in the git log.
- **Failure forensics + resume** — a failed turn journals what it left on disk
  (uncommitted diff summary) and the next attempt **resumes the dead session**
  (`--resume`, once per failure chain) instead of re-deriving the work; a
  failed resume falls back to a fresh session.
- **Rate-limit stand-down** — a provider usage/rate-limit failure doesn't burn
  the retry budget: the loop parses the reset time from the message when
  present ("resets 7:40am (America/Los_Angeles)") and sleeps through it.
- **No nested repos** — a workspace inside an existing git repository (e.g. a
  game dir in a monorepo) never gets `git init`; the phase ratchet stands down
  and history belongs to the enclosing repo.

### Operator notifications

Events that block on a human — a build awaiting deploy approval, a checkpoint,
a rate-limit stall, a phase skipped after repeated failures — post a
notification: macOS native by default, or set `FACTORY_NOTIFY` to any shell
command (it runs with `FACTORY_NOTIFY_TITLE` / `FACTORY_NOTIFY_MESSAGE` in the
environment — point it at ntfy, a Slack webhook, etc.).

When stdout isn't a TTY (CI, piped logs) — or with `--no-tui` — the factory
streams the same events as plain log lines instead (there the game must be
identifiable up front: a slug, `--dir`, or `--idea`).

### Deploys need your approval

By default **nothing goes live without you.** The agent builds, playtests, and
keeps improving the game locally; when it reaches a release point it does **not**
publish — it just records that a build is ready. Run `pnpm approve <slug>`
and the agent ships the **current** build (after the in-flight step finishes,
so what goes live is the build you approved, not a newer one). Approval grants
**one** deployment; the next release needs fresh approval. Pass `--auto-deploy`
on `start` to opt into continuous, unattended deploys instead.

Deploys also require an authenticated `vg` CLI: when `vg` isn't logged in the
ship step is **skipped** (journaled, loop keeps iterating) rather than burning
a turn on a failing deploy — run `vg login` (or set `VG_TOKEN`) any time and
the next release point ships.

### Choosing where the game lives + building on existing files

The game's project directory defaults to `apps/factory/.workspaces/<slug>/`
(gitignored). Pass `--dir <path>` to put it anywhere you like — e.g.
`pnpm start my-game --idea "…" --dir ~/games/my-game`. If you point it
**outside this repo**, run `vg init` there first so Claude Code can resolve the
vibedgames skills. (`stop`, `status`, and `approve` take the same `--dir`.)

If `--dir` points at a directory that **already contains a project**, the agent
**builds upon it** instead of scaffolding fresh: it reads the existing source,
adopts the stack/engine, makes it deployable, and evolves it. `--idea` is
optional in that case.

```bash
pnpm start my-proto --dir ~/code/my-proto   # adopt & evolve an existing game
```

### Giving it context

Pass `--context` to steer the build with more than a one-liner. It accepts:

- **literal text** — `--context "co-op only, controller-first, synthwave palette"`
- **a file** — `--context ./design-brief.md` (read inline)
- **a directory** — `--context ./references` (the agent gets read access and builds upon it)

The brief is written to `<dir>/.vgfactory/context.md` and every subagent reads it
first. With `--context`, `--idea` is optional.

## How it works

A single Node process runs the agent's **durable phase machine**. Each phase
invokes one subagent as a fresh headless Claude Code session with a role-specific
system prompt (loaded from [`agents/`](./agents)), the full toolbelt, the
dogfooded skills, and the `vg` CLI available:

| Phase      | Subagent    | Does                                                                  |
| ---------- | ----------- | --------------------------------------------------------------------- |
| `spec`     | 🧭 Designer | Turns the seed idea into a build-ready `spec.md`                      |
| `scaffold` | 🛠️ Engineer | `vg new` the engine (phaser/threejs) + install                        |
| `assets`   | 🎨 Artist   | `vg generate` the first art set (sprites, VFX, bg)                    |
| `build`    | 🛠️ Engineer | Core loop + mandatory craft pass                                      |
| `playtest` | 🔎 QA       | Drives the build, files findings + bugs                               |
| `ship`     | 🚀 Shipper  | Only with your approval: `vg deploy ./dist` → `{slug}.vibedgames.com` |

After the first ship it enters the **forever loop**, where the Director runs the
game like a product owner — triaging a typed backlog (bug / feature / gameplay /
balance / content / polish / art), fixing ship-stoppers first, then picking the
highest-impact work for the game's current maturity so it keeps _growing_, not
just glistening:

```
plan (🎬 Director triages the backlog & assigns the next item) → work (designer | engineer | artist | QA) → playtest → ship → plan → …
```

### Subagent definitions (filesystem-first)

Each subagent is defined by files on disk, not constants in code:

```
agents/
  charter.md            # shared system prompt, prepended to every subagent
  director/AGENT.md     # role prompt + frontmatter (emoji)
  designer/AGENT.md
  engineer/AGENT.md
  artist/AGENT.md
  qa/AGENT.md
  shipper/AGENT.md
```

Each `AGENT.md` opens with YAML-ish frontmatter and then the role prompt:

```md
---
emoji: 🛠️
---

ROLE: Game Engineer …
```

Every subagent runs with the full toolbelt — the charter and role prompt steer
what each one does. To retune a role, edit its prompt; no code change needed.

### Coordination + durable memory: the shared `.vgfactory/`

Subagents never talk directly — they coordinate through files in
`<workspace>/.vgfactory/`, which is also the agent's durable memory (so the loop
survives restarts and individual context windows):

- `state.json` — orchestrator-owned phase / cycle / iteration / deploy URL (the checkpoint)
- `spec.md` — the game design (designer)
- `backlog.json` — prioritized work, `[{id,title,detail,role,priority,status}]` (director)
- `context.md` — optional operator brief / reference (from `--context`), read first by every subagent
- `next.json` — the current assignment `{role, type, task}` (director → work phase)
- `playtest.md` — QA findings
- `journal.md` — append-only history every subagent writes to
- `trace.jsonl` — one span per turn (role, phase, cost, duration, outcome) — the agent's observability trail
- `STOP` — sentinel; `pnpm stop` writes it, the loop halts after the current step
- `APPROVE` — one-shot deploy approval; `pnpm approve` writes it, the next ship consumes it

The game itself is scaffolded directly into the game directory (default
`apps/factory/.workspaces/<slug>/`, gitignored; override with `--dir`).

### Observability: replaying a run

`.vgfactory/trace.jsonl` records one JSON span per turn. Tail it live or slice it
after the fact:

```bash
tail -f apps/factory/.workspaces/<slug>/.vgfactory/trace.jsonl
# total spend by role:
cat .vgfactory/trace.jsonl | jq -s 'group_by(.role) | map({role: .[0].role, cost: (map(.costUsd // 0) | add)})'
```

## Prerequisites

1. **Bun ≥ 1.2** on `PATH` — the scripts run the TypeScript/TSX sources
   directly with Bun (the TUI's renderer requires the Bun runtime).
2. **A coding-agent CLI** logged in on your machine. The default runner is
   **Claude Code** (`claude` on `PATH`, or `CLAUDE_BIN`; shells out to
   `claude -p` per phase). Pass `--runner codex` to drive the **Codex CLI**
   instead (`codex exec --json`; `CODEX_BIN` to override). Same contract
   either way: one fresh clean-context session per phase, streamed into the
   dashboard. Checked at start; a missing binary fails fast. Codex reports
   token usage but not dollars, so the spend counter only tracks claude runs.
3. **`vg` CLI + skills linked locally:** run `pnpm dogfood` once at the repo
   root. The orchestrator runs each subagent with its cwd inside this repo so
   Claude Code resolves the skills from `<repo>/.claude/skills`.
4. Anything `vg generate` / `vg deploy` need (a logged-in `vg`, env from
   `.env`). The subagents call `vg login`-gated commands.

## Running installed (outside this repo)

The factory detects whether it's running inside the vibedgames monorepo:

- **In the repo (dev mode):** games default to `apps/factory/.workspaces/<slug>`
  (gitignored) and subagents resolve the dogfooded skills from
  `<repo>/.claude/skills`.
- **Installed (npm / a copied package):** games default to
  **`~/vibedgames/<slug>`** — a visible folder, stable regardless of cwd so
  `start`/`stop`/`status`/`approve` always agree. On first start the factory
  runs **`vg init`** in the game workspace (bootstrapped via
  `npx -y vibedgames init` when `vg` isn't installed yet), which installs the
  vibedgames skills into the workspace **and** the `vg` CLI globally — the two
  things every subagent drives.

### Building the publishable CLI

`pnpm build:npm` (or `bun scripts/build.ts --host` for the current platform
only) stages publish-ready packages under `dist/npm/`:

- `@vibedgames/factory-<os>-<cpu>` — a bun-compiled standalone binary per
  platform (agent markdown + opentui's native lib embedded; users need
  neither Bun nor a TS runtime)

The factory ships as an **optional plugin of the vg CLI**: `vg factory …`
installs the right platform package globally on first use, then execs its
binary with the args passed through — vg itself carries none of the factory.
(`VG_FACTORY_BIN` overrides resolution for development.) Still to do before a
real publish: bump the version and wire the platform packages into the
release flow.

## Run

There's no build step — the scripts run the TypeScript/TSX sources directly
with Bun. From `apps/factory/`:

```bash
pnpm start <slug> --idea "<one-line idea>"
```

From the repo root, target the package with `-F`:

```bash
pnpm -F @repo/factory start <slug> --idea "<one-line idea>"
```

The `start`, `stop`, `status`, and `approve` scripts each run `bun
src/index.ts <cmd>`; everything after the script name (the slug and any flags)
is passed straight through. `pnpm typecheck` runs `tsc --noEmit` (the only
TypeScript step — nothing is emitted).

### `start` options

| Flag                | Default                           | Meaning                                                                                                                                                    |
| ------------------- | --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--idea`            | — (one of idea/context/existing)  | Seed idea. Optional with `--context` or when `--dir` has a project.                                                                                        |
| `--context`         | —                                 | Extra brief: literal text, a file (read inline), or a directory (referenced).                                                                              |
| `--runner`          | `claude`                          | Which coding-agent CLI runs the subagents: `claude` or `codex`.                                                                                            |
| `--model`           | per runner                        | `claude-fable-5` (claude) / `gpt-5.6-sol` (codex); pass a cheaper tier to save.                                                                            |
| `--codex-roles`     | —                                 | Comma-separated roles routed to codex even under the claude runner (e.g. `engineer`) — bulk build work on a cheaper runner, judgment roles stay on claude. |
| `--codex-model`     | `gpt-5.6-sol`                     | Model for `--codex-roles` turns.                                                                                                                           |
| `--max-cycles`      | `0` (forever)                     | Stop after N subagent runs (lifetime count, persisted).                                                                                                    |
| `--checkpoint-wait` | `120`                             | Seconds an agent checkpoint waits for feedback before auto-continuing (0 = skip).                                                                          |
| `--max-turns`       | `40`                              | Per-subagent agentic turn ceiling.                                                                                                                         |
| `--idle-timeout`    | `45`                              | Kill a subagent that emits no output for this many minutes (0 disables).                                                                                   |
| `--session-timeout` | `120`                             | Absolute cap on a single subagent session, in minutes (0 disables).                                                                                        |
| `--interval`        | `0`                               | ms to pause between subagent runs.                                                                                                                         |
| `--auto-deploy`     | off                               | Deploy automatically. Default OFF — deploys wait for `pnpm approve <slug>`.                                                                                |
| `--skip-ship`       | off                               | Never prepare a release at all (use while testing).                                                                                                        |
| `--dir`             | `apps/factory/.workspaces/<slug>` | Where the game lives — its project directory.                                                                                                              |
| `--guarded`         | off                               | Do **not** auto-approve tools — for debugging only; breaks autonomy.                                                                                       |
| `--no-tui`          | off                               | Plain streamed logs instead of the interactive dashboard (automatic when not a TTY).                                                                       |

Re-running `pnpm start <slug>` **resumes** from the saved phase.

### Other commands

```bash
pnpm approve <slug>   # grant one deployment of the current build
pnpm status  <slug>   # show phase / shipped / live URL / pending approval (--json for machine output)
pnpm stop    <slug>   # graceful stop after the current step
```

## ⚠️ Safety & cost

For unattended autonomy the agent runs each subagent with
`--dangerously-skip-permissions` (disable with `--guarded`, but then it will
block waiting for approvals and is no longer autonomous). That means subagents
run shell/file tools and **`vg generate` (costs money)** without asking.

- **Deploys are gated by default** — nothing publishes to production until you
  run `pnpm approve <slug>`. Only `--auto-deploy` lets the loop publish on
  its own (it writes to production R2 and serves a live game).
- Use `--max-cycles` while you're trying it out; `--skip-ship` if you never want
  it to even prepare a release.
- Watch the streamed output; stop anytime with `Ctrl-C` or `pnpm stop <slug>`.
- `status --json` is machine-readable for monitoring; `.vgfactory/trace.jsonl` is
  the per-turn trail.
- Approximate spend is tracked in `state.json` (`totalCostUsd`).
