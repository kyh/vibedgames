---
name: production
description: "Run a long game build — one agent or many — so the person's notes land in few rounds: a written bar, a register of their asks in their own words, streams that own their paths, rounds that end in a deployed build, and updates that show evidence. Use when a game takes many rounds of feedback, several agents share one game, or fixes keep not reaching the build."
---

# Production

Most lost days on a big game are not hard problems. They are notes that were
paraphrased, fixes that never reached the build the person plays, agents that
overwrote each other, and a lead that sat waiting for an answer. This skill is
the operating system for a build that runs over many rounds. It sits on top of
`game-playbook` (what to build, in what order) and `finish-it` (when to stop).

## Before the first build: the bar

Write `production/BAR.md` in the first hour:

- The reference frames per screen (named shipped games or the person's
  concept art), and the look statements (`look`).
- Target devices, the frame-rate floor, load and size budgets
  (`ship-ready`).
- Spend caps for generation (`vg generate pricing` per endpoint, and a total
  the person agreed to).

Every spec number lives in that file and nowhere else.

## The ask register

`production/ASKS.md`, one row per thing the person asked for:

| id  | their exact words | as a rule for every instance | dates repeated | status | evidence |
| --- | ----------------- | ---------------------------- | -------------- | ------ | -------- |

- **Their words, verbatim.** A paraphrase that strengthens or softens a note
  produces the wrong fix.
- **Rewrite each as a rule over the whole class.** "This gun looks like a
  toy" becomes "no held weapon may read as a toy at hip distance", and the
  fix sweeps every gun before it is reported.
- **Rank by repeats.** A note the person gave three times outranks anything
  new. Twice-reported classes get an automated check (`playtest`) that sees
  the problem the way they do.
- **Status rises only on evidence** from the exact deployed build, gathered by
  someone other than whoever made the fix.
- Superseded asks are marked, not deleted.

## Rounds

- **A round ends in a build the person can open.** `vg deploy` from a clean
  tree, then open the URL yourself, play through the real menu, capture, and
  only then report. "Done" means seen in that build.
- **The builder never grades the round.** Before reporting a round as done,
  run `game-review`: a fresh adversarial panel plays the deployed build and
  its findings, with evidence, are what the update reports.
- **One latest address.** The game's `{slug}.vibedgames.com` URL is always
  the newest promoted build. If a round needs a separate address to compare,
  deploy it under a second slug.
- **Each round fixes the highest-impact open gap game-wide**, re-scored from
  fresh captures. A fault that comes back twice gets a found cause before a
  third patch.
- **Batch the person's feedback**: one message or play session becomes
  register rows, and the whole batch lands in one round.
- **Freeze what they approve.** Keep the approved capture and commit; later
  changes are diffed against it, and a regression is fixed by restoring
  first.

## Many agents in one game

- **A typed contract first.** Shared types for the seams (entities, events,
  asset manifests) before streams start.
- **Each stream owns its paths** (e.g. `src/audio/**`, `src/ai/**`,
  `public/models/**`). Nobody edits another stream's files; requests go in
  that stream's `REQUESTS.md`.
- **Status lives in files.** Each stream keeps `production/status/<stream>.md`
  with its current state at the top, so a replacement agent reads it cold and
  carries on. Commit often; nothing important lives only in a session.
- **One path to the shared tree.** Branches per stream, one integrator
  merges, the shared tree always builds and boots. Nobody rewrites shared
  history.
- **Size the team to what you have.** More agents than the model's rate limit
  sustains stalls all of them. Heavy jobs (builds, browsers, captures) each
  take a slot, free it on every exit, and are watched until their result is
  read.
- **Never block the loop on the person.** Decide, write the decision and why
  in `production/DECISIONS.md`, and carry on; put the question in the next
  update with your default.

## Reference first for iconic things

Anything players will compare with something they know (a real weapon or
vehicle, a known creature type, an item from the person's earlier game) is
built from measured reference before its first build, and judged side by side
under one camera. Generated hard-surface objects top out at passable; plan
for authored or licensed models where the player looks closely.

## Updates to the person

Short, at an agreed interval, and in this order:

1. Corrections and anything that broke since last time.
2. The playable link and the build it serves, and whether you booted it.
3. What was **seen** working, separately from what was only tested or
   reported.
4. One thing to try.

Every picture you send is reviewed whether or not you meant it to be: name
its flaws in its caption.
