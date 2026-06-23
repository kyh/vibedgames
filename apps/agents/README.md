# @repo/agents — autonomous game studio

A long-running, multi-agent orchestrator that builds **one** browser game
end-to-end and then **runs it like a studio** — shipping bug fixes, new
features, gameplay & balance iteration, content, and polish — with no human in
the loop. You start it with a one-line idea; it keeps running until you stop it.

It does not reimplement any game knowledge. It drives the **vibedgames skills**
and the **`vg` CLI** by spawning headless Claude Code sessions (`claude -p`),
one specialist at a time.

You run it with **pnpm scripts** from `apps/agents/` (or with `-F @repo/agents`
from the repo root):

```
pnpm start   neon-slasher --idea "a top-down neon slasher where every hit shakes the screen"
# …builds, generates art, iterates forever — but does NOT publish until you approve…
pnpm status  neon-slasher    # peek at progress
pnpm approve neon-slasher    # publish the current build to neon-slasher.vibedgames.com
pnpm stop    neon-slasher    # graceful stop (or just Ctrl-C the running process)
```

### Deploys need your approval

By default **nothing goes live without you.** The studio builds, playtests, and
keeps improving the game locally; when it reaches a release point it does **not**
publish — it just records that a build is ready. Run `pnpm approve <slug>`
and the studio ships the **current** build (after the in-flight step finishes,
so what goes live is the build you approved, not a newer one). Approval grants
**one** deployment; the next release needs fresh approval. Pass `--auto-deploy`
on `start` to opt into continuous, unattended deploys instead.

### Choosing where the game lives + building on existing files

The game's project directory defaults to `apps/agents/.workspaces/<slug>/`
(gitignored). Pass `--dir <path>` to put it anywhere you like — e.g.
`pnpm start my-game --idea "…" --dir ~/games/my-game`. If you point it
**outside this repo**, run `vg init` there first so Claude Code can resolve the
vibedgames skills. (`stop`, `status`, and `approve` take the same `--dir`.)

If `--dir` points at a directory that **already contains a project**, the studio
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
- **a directory** — `--context ./references` (the agents get read access and build upon it)

The brief is written to `<dir>/.studio/context.md` and every specialist reads it
first. With `--context`, `--idea` is optional.

## How it works

A single Node process runs a **phase machine**. Each phase invokes one
specialist as a fresh headless Claude Code session with a role-specific system
prompt, the dogfooded skills, and the `vg` CLI available:

| Phase      | Specialist  | Does                                                                  |
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

### Coordination: the blackboard

Specialists never talk directly — they coordinate through files in
`<workspace>/.studio/`, which is also the orchestrator's durable memory (so the
loop survives restarts and individual context windows):

- `state.json` — orchestrator-owned phase / cycle / iteration / deploy URL
- `spec.md` — the game design (designer)
- `backlog.json` — prioritized work, `[{id,title,detail,role,priority,status}]` (director)
- `context.md` — optional operator brief / reference (from `--context`), read first by every specialist
- `next.json` — the current assignment `{role, type, task}` (director → work phase)
- `playtest.md` — QA findings
- `journal.md` — append-only history every specialist writes to
- `STOP` — sentinel; `pnpm stop` writes it, the loop halts after the current step
- `APPROVE` — one-shot deploy approval; `pnpm approve` writes it, the next ship consumes it

The game itself is scaffolded directly into the game directory (default
`apps/agents/.workspaces/<slug>/`, gitignored; override with `--dir`).

## Prerequisites

1. **Claude Code CLI** logged in on your machine (`claude` on `PATH`, or set
   `CLAUDE_BIN`). The studio uses your existing Claude subscription/login — it
   shells out to `claude -p`.
2. **`vg` CLI + skills linked locally:** run `pnpm dogfood` once at the repo
   root. The orchestrator runs each agent with its cwd inside this repo so
   Claude Code resolves the skills from `<repo>/.claude/skills`.
3. Anything `vg generate` / `vg deploy` need (a logged-in `vg`, env from
   `.env`). The agents call `vg login`-gated commands.

## Install & run

Build once, then drive it with the package's pnpm scripts. From `apps/agents/`:

```bash
pnpm build
pnpm start <slug> --idea "<one-line idea>"
```

From the repo root, target the package with `-F`:

```bash
pnpm -F @repo/agents build
pnpm -F @repo/agents start <slug> --idea "<one-line idea>"
```

The `start`, `stop`, `status`, and `approve` scripts map to the orchestrator's
subcommands; everything after the script name (the slug and any flags) is passed
straight through.

### `start` options

| Flag                | Default                          | Meaning                                                                          |
| ------------------- | -------------------------------- | -------------------------------------------------------------------------------- |
| `--idea`            | — (one of idea/context/existing) | Seed idea. Optional with `--context` or when `--dir` has a project.              |
| `--context`         | —                                | Extra brief: literal text, a file (read inline), or a directory (referenced).    |
| `--model`           | `claude-opus-4-8`                | `claude --model`. Defaults to the latest model; pass `sonnet` for a cheaper run. |
| `--max-cycles`      | `0` (forever)                    | Stop after N specialist runs.                                                    |
| `--max-turns`       | `40`                             | Per-specialist agentic turn ceiling.                                             |
| `--idle-timeout`    | `45`                             | Kill a specialist that emits no output for this many minutes (0 disables).       |
| `--session-timeout` | `120`                            | Absolute cap on a single specialist session, in minutes (0 disables).            |
| `--interval`        | `0`                              | ms to pause between specialist runs.                                             |
| `--auto-deploy`     | off                              | Deploy automatically. Default OFF — deploys wait for `pnpm approve <slug>`.      |
| `--skip-ship`       | off                              | Never prepare a release at all (use while testing).                              |
| `--dir`             | `apps/agents/.workspaces/<slug>` | Where the game lives — its project directory.                                    |
| `--guarded`         | off                              | Do **not** auto-approve tools — for debugging only; breaks autonomy.             |

Re-running `pnpm start <slug>` **resumes** from the saved phase.

### Other commands

```bash
pnpm approve <slug>   # grant one deployment of the current build
pnpm status  <slug>   # show phase / shipped / live URL / pending approval (--json for machine output)
pnpm stop    <slug>   # graceful stop after the current step
```

## ⚠️ Safety & cost

For unattended autonomy the studio runs each agent with
`--dangerously-skip-permissions` (disable with `--guarded`, but then it will
block waiting for approvals and is no longer autonomous). That means agents run
shell/file tools and **`vg generate` (costs money)** without asking.

- **Deploys are gated by default** — nothing publishes to production until you
  run `pnpm approve <slug>`. Only `--auto-deploy` lets the loop publish on
  its own (it writes to production R2 and serves a live game).
- Use `--max-cycles` while you're trying it out; `--skip-ship` if you never want
  it to even prepare a release.
- Watch the streamed output; stop anytime with `Ctrl-C` or `pnpm stop <slug>`.
- `status --json` is machine-readable for monitoring.
- Approximate spend is tracked in `state.json` (`totalCostUsd`).
