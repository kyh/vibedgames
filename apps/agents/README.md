# @repo/agents — autonomous game studio

A long-running, multi-agent orchestrator that builds **one** browser game
end-to-end and then **runs it like a studio** — shipping bug fixes, new
features, gameplay & balance iteration, content, and polish — with no human in
the loop. You start it with a one-line idea; it keeps running until you stop it.

It does not reimplement any game knowledge. It drives the **vibedgames skills**
and the **`vg` CLI** by spawning headless Claude Code sessions (`claude -p`),
one specialist at a time.

```
vg-studio start neon-slasher --idea "a top-down neon slasher where every hit shakes the screen"
# …builds, generates art, ships to neon-slasher.vibedgames.com, then iterates forever…
vg-studio status neon-slasher     # peek at progress
vg-studio stop   neon-slasher     # graceful stop (or just Ctrl-C the running process)
```

## How it works

A single Node process runs a **phase machine**. Each phase invokes one
specialist as a fresh headless Claude Code session with a role-specific system
prompt, the dogfooded skills, and the `vg` CLI available:

| Phase      | Specialist        | Does                                                    |
| ---------- | ----------------- | ------------------------------------------------------- |
| `spec`     | 🧭 Designer       | Turns the seed idea into a build-ready `spec.md`        |
| `scaffold` | 🛠️ Engineer       | `vg new` the engine (phaser/threejs) + install          |
| `assets`   | 🎨 Artist         | `vg generate` the first art set (sprites, VFX, bg)      |
| `build`    | 🛠️ Engineer       | Core loop + mandatory craft pass                        |
| `playtest` | 🔎 QA             | Drives the build, files findings + bugs                 |
| `ship`     | 🚀 Shipper        | `vg deploy ./dist` → `{slug}.vibedgames.com`            |

After the first ship it enters the **forever loop**, where the Director runs the
game like a product owner — triaging a typed backlog (bug / feature / gameplay /
balance / content / polish / art), fixing ship-stoppers first, then picking the
highest-impact work for the game's current maturity so it keeps *growing*, not
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
- `next.json` — the current assignment `{role, task}` (director → work phase)
- `playtest.md` — QA findings
- `journal.md` — append-only history every specialist writes to
- `STOP` — sentinel; `vg-studio stop` writes it, the loop halts after the current step

The game itself is scaffolded directly into the workspace root (default
`apps/agents/.workspaces/<slug>/`, gitignored).

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

```bash
pnpm -F @repo/agents build
node apps/agents/dist/index.js start <slug> --idea "<one-line idea>"
# or, after `pnpm dogfood` / npm-link, just:  vg-studio start <slug> --idea "..."
```

### `start` options

| Flag            | Default                          | Meaning                                                              |
| --------------- | -------------------------------- | ------------------------------------------------------------------- |
| `--idea`        | — (required for a new game)      | Seed idea. Optional when resuming an existing workspace.            |
| `--model`       | `sonnet`                         | `claude --model` alias. Try `opus` for higher-craft (pricier) runs. |
| `--max-cycles`  | `0` (forever)                    | Stop after N specialist runs.                                       |
| `--max-turns`   | `40`                             | Per-specialist agentic turn ceiling.                                |
| `--idle-timeout`| `45`                             | Kill a specialist that emits no output for this many minutes (0 disables). |
| `--session-timeout`| `120`                         | Absolute cap on a single specialist session, in minutes (0 disables). |
| `--interval`    | `0`                              | ms to pause between specialist runs.                                |
| `--skip-ship`     | off                              | Skip deploys — no production R2 writes (use while testing).         |
| `--workspace`   | `apps/agents/.workspaces/<slug>` | Override the game workspace dir.                                     |
| `--guarded`     | off                              | Do **not** auto-approve tools — for debugging only; breaks autonomy.|

Re-running `start <slug>` **resumes** from the saved phase.

## ⚠️ Safety & cost

For unattended autonomy the studio runs each agent with
`--dangerously-skip-permissions` (disable with `--guarded`, but then it will
block waiting for approvals and is no longer autonomous). That means agents run
shell/file tools, **`vg generate` (costs money)** and **`vg deploy` (writes to
production R2 and publishes a live game)** without asking.

- Use `--skip-ship` and/or `--max-cycles` while you're trying it out.
- Watch the streamed output; stop anytime with `Ctrl-C` or `vg-studio stop <slug>`.
- `status --json` is machine-readable for monitoring.
- Approximate spend is tracked in `state.json` (`totalCostUsd`).
