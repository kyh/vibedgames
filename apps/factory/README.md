# @repo/factory — autonomous game factory

The **factory** runs one autonomous **agent** per game. Each agent builds **one**
browser game end-to-end and then **runs it like a studio** — shipping bug fixes,
new features, gameplay & balance iteration, content, and polish — with no human
in the loop. You start an agent with a one-line idea; it keeps running until you
stop it.

Each agent operates in the shape of Vercel's [Eve](https://vercel.com/blog/introducing-eve):

- **A durable, checkpointed loop.** Every turn is written to disk (`.agent/`),
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
  `.agent/trace.jsonl` (role, phase, cost, duration, outcome) — an append-only,
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
pnpm start   neon-slasher --idea "a top-down neon slasher where every hit shakes the screen"
# …builds, generates art, iterates forever — but does NOT publish until you approve…
pnpm status  neon-slasher    # peek at progress
pnpm approve neon-slasher    # publish the current build to neon-slasher.vibedgames.com
pnpm stop    neon-slasher    # graceful stop (or just Ctrl-C the running process)
```

### Deploys need your approval

By default **nothing goes live without you.** The agent builds, playtests, and
keeps improving the game locally; when it reaches a release point it does **not**
publish — it just records that a build is ready. Run `pnpm approve <slug>`
and the agent ships the **current** build (after the in-flight step finishes,
so what goes live is the build you approved, not a newer one). Approval grants
**one** deployment; the next release needs fresh approval. Pass `--auto-deploy`
on `start` to opt into continuous, unattended deploys instead.

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

The brief is written to `<dir>/.agent/context.md` and every subagent reads it
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

### Coordination + durable memory: the shared `.agent/`

Subagents never talk directly — they coordinate through files in
`<workspace>/.agent/`, which is also the agent's durable memory (so the loop
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

`.agent/trace.jsonl` records one JSON span per turn. Tail it live or slice it
after the fact:

```bash
tail -f apps/factory/.workspaces/<slug>/.agent/trace.jsonl
# total spend by role:
cat .agent/trace.jsonl | jq -s 'group_by(.role) | map({role: .[0].role, cost: (map(.costUsd // 0) | add)})'
```

## Prerequisites

1. **Claude Code CLI** logged in on your machine (`claude` on `PATH`, or set
   `CLAUDE_BIN`). The agent uses your existing Claude subscription/login — it
   shells out to `claude -p`.
2. **`vg` CLI + skills linked locally:** run `pnpm dogfood` once at the repo
   root. The orchestrator runs each subagent with its cwd inside this repo so
   Claude Code resolves the skills from `<repo>/.claude/skills`.
3. Anything `vg generate` / `vg deploy` need (a logged-in `vg`, env from
   `.env`). The subagents call `vg login`-gated commands.

## Run

There's no build step — the scripts run the TypeScript sources directly with
Node's built-in type stripping (Node ≥ 22.18). From `apps/factory/`:

```bash
pnpm start <slug> --idea "<one-line idea>"
```

From the repo root, target the package with `-F`:

```bash
pnpm -F @repo/factory start <slug> --idea "<one-line idea>"
```

The `start`, `stop`, `status`, and `approve` scripts each run `node
src/index.ts <cmd>`; everything after the script name (the slug and any flags)
is passed straight through. `pnpm typecheck` runs `tsc --noEmit` (the only
TypeScript step — nothing is emitted).

### `start` options

| Flag                | Default                           | Meaning                                                                          |
| ------------------- | --------------------------------- | -------------------------------------------------------------------------------- |
| `--idea`            | — (one of idea/context/existing)  | Seed idea. Optional with `--context` or when `--dir` has a project.              |
| `--context`         | —                                 | Extra brief: literal text, a file (read inline), or a directory (referenced).    |
| `--model`           | `claude-opus-4-8`                 | `claude --model`. Defaults to the latest model; pass `sonnet` for a cheaper run. |
| `--max-cycles`      | `0` (forever)                     | Stop after N subagent runs.                                                      |
| `--max-turns`       | `40`                              | Per-subagent agentic turn ceiling.                                              |
| `--idle-timeout`    | `45`                              | Kill a subagent that emits no output for this many minutes (0 disables).         |
| `--session-timeout` | `120`                             | Absolute cap on a single subagent session, in minutes (0 disables).              |
| `--interval`        | `0`                               | ms to pause between subagent runs.                                              |
| `--auto-deploy`     | off                               | Deploy automatically. Default OFF — deploys wait for `pnpm approve <slug>`.      |
| `--skip-ship`       | off                               | Never prepare a release at all (use while testing).                             |
| `--dir`             | `apps/factory/.workspaces/<slug>` | Where the game lives — its project directory.                                    |
| `--guarded`         | off                               | Do **not** auto-approve tools — for debugging only; breaks autonomy.             |

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
- `status --json` is machine-readable for monitoring; `.agent/trace.jsonl` is
  the per-turn trail.
- Approximate spend is tracked in `state.json` (`totalCostUsd`).
