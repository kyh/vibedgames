---
name: game-review
description: "Gate a game before it ships with a panel of fresh adversarial reviewer agents: one breaks it, one plays it cold, others judge feel, look, sound and release-readiness against a written bar. Use when a game is called done, before every deploy of a polished build, or when the person wants AAA quality or taste."
---

# Game review: adversarial agents gate the build

The agent that built a game is the worst judge of it. It knows what each
thing is meant to be, so it sees intent instead of pixels, forgives its own
shortcuts, and reports "looks great". This skill takes the verdict away from
the builder and gives it to a panel of **fresh reviewer agents whose only job
is to find out why the game is not good enough**. A build ships when the panel
cannot find a blocker. Nobody's word that it is done counts.

Use it at every "done": the end of a `production` round, before `deploy` of a
build anyone will see, and whenever the person asks for AAA quality, polish
or taste.

## Rules for every reviewer

- **Fresh every round.** Spawn a new subagent or session for each role each
  round (in Claude Code, the Agent tool; elsewhere, a new session). A reviewer
  that saw round 3 passes in round 6 what it failed before.
- **Evidence only, never builder chat.** A reviewer gets the build URL, the
  commit, the bar (`art/BAR.md`, the ask register if there is one) and the
  evidence folder. Never the builder's summary, plan or reasons.
- **The game fails until shown otherwise.** A reviewer starts from FAIL and
  must cite what it saw to pass anything: a file, a frame, a timestamp, a
  report path. "Seems fine" is a FAIL.
- **Reviewers never edit.** They play, capture, measure and write a verdict.
  The builder fixes; the orchestrator (you) decides.
- **No partial credit.** Each criterion is PASS or FAIL. "Good for a browser
  game", "close enough" and "with notes" are FAILs; write the punch item.
- **Name the target, not the fix.** A punch item says what the player sees and
  when it is done, never which library or technique to use.
- **No subagents available?** Run each role as its own pass that starts by
  reading only the evidence folder, and tell the person the review was not
  independent.

## The panel

Run every role every round, in parallel. A fix in one area regresses
another, so a partial panel misses exactly the bug the fix introduced.

| Role               | Mandate                                                     | Tools                                                   |
| ------------------ | ----------------------------------------------------------- | ------------------------------------------------------- |
| **Breaker**        | Make it crash, softlock, cheat or misbehave                 | `vg playtest`, the scripted bot, errors and console     |
| **Cold player**    | Play it as a stranger: does the first minute work?          | `vg playtest run`, screenshots, recordings              |
| **Feel critic**    | Is every action responsive, weighty and readable in motion? | recordings, frame-stepped clips, `game-feel` numbers    |
| **Taste critic**   | Does it look like one shipped game, next to the refs?       | `game-playbook`'s critic loop, `quality-bar.md` tells   |
| **Sound critic**   | Is it mixed, never silent, never harsh?                     | `vg asset video-probe` loudness, the `audio` skill's QA |
| **Release critic** | Would it survive real players on real phones?               | the `ship-ready` gate                                   |

### Breaker

Spends the whole budget trying to break the game, through the build players
get (the deployed or preview URL, not a dev server):

- Mash, hold and combine every input; pause and unpause mid-action; restart
  from every state; lose focus mid-run (tab away, minimise); resize and rotate.
- Hunt softlocks: stand in corners, back into walls, kill yourself during a
  transition, finish a level while dying. `longestStuckRun` from the scripted
  bot over 2 is a finding.
- Hunt exploits: a strategy that wins without playing (stand still, spam one
  attack, farm one spot). Point `vg playtest run` at "win without playing
  properly" as the goal.
- Reload mid-run, open it twice, go offline, return on a second visit with
  saved settings.
- On a phone viewport with real touch emulation (`playtest`'s cheatsheet,
  § Environment): every control reachable, nothing under the notch.
- Any page error, console error or failed request is a blocker unless it
  can be named as harmless.

### Cold player

Plays with no knowledge beyond what the game itself shows. It gets no
`--goal` text from the builder: it writes its own goal from the title screen
and first frames, then plays with `vg playtest run` and by hand through
`vg playtest` screenshots. It reports in time order:

- When it understood what to do, and what told it. Over 10 seconds with no
  idea is a FAIL.
- The first moment it was bored, confused or punished unfairly.
- Whether it wanted to retry after the first fail, and why.
- `decisions.progress` and `meanConfidence` from the run. Low confidence is a
  finding about what the game shows, not about the model.

### Feel critic

Judges motion, never stills. It records runs (the recording command is in
`vg playtest skills get core`), steps through frames, and checks the
`game-feel` numbers: input to first visible response, acceleration curves,
hit stop, shake, knockback, cancel windows, camera lag. Every verb the player
uses gets a verdict. Something that animates but has no weight (no anticipation,
no impact frame, no recovery) is a FAIL.

### Taste critic

Runs `game-playbook`'s `references/critic-loop.md` against the locked refs and
`BAR.md`. Then it runs two more checks a scoring pass misses:

- **Blind lineup.** Mix 3 to 5 stills of the game, unlabelled, with stills of
  the reference games. Ask a second fresh agent to sort them by production
  tier and to name the one made by an amateur. If it picks the game, that is a
  FAIL on taste, whatever the scores said.
- **The tells** (`quality-bar.md`): placeholder or template art anywhere, mixed
  art styles or resolutions, scale and perspective that disagree, default fonts
  or a HUD that looks like a web page, generic AI gloss (soft gradients,
  plastic shading, purple-blue everything), empty or flat-lit scenes, effects
  louder than the action, a title screen that sells nothing.

### Sound critic

Records a full run with sound and measures it with
`vg asset video-probe --video_url <recording>`: integrated loudness, true
peak, silences. It checks every action has a sound, nothing repeats
identically ten times in a row, and music ducks under important cues
(`audio` skill, `references/qa-without-ears.md`). It always reports that an
agent cannot hear tone or harshness, so a person must listen before release.

### Release critic

Runs the `ship-ready` gate: frame-time tails (not the average), cold and warm
load on a throttled connection, memory and touch on a phone profile, crash-free
runs, accessibility (remapping, subtitles, signals that don't rely on colour,
reduced motion, flashes).

## The verdict every reviewer writes

```
ROLE: <role>   BUILD: <url> @ <commit>   ROUND: R<n>
VERDICT: SHIP | FAIL | BLOCKED
CRITERIA: <id> PASS|FAIL, ... (every criterion in its mandate)
FINDINGS:
1. [BLOCKER|MAJOR|MINOR] <what the player sees, where, how to reproduce>;
   evidence: <file / frame / timestamp / report path>. Done when <observable condition>.
CANNOT JUDGE: <what this role could not perceive or reach, e.g. sound tone, a real phone>
```

- **BLOCKER**: a crash, softlock, data loss, an unwinnable or trivially
  winnable game, or anything that makes a stranger quit in the first minute.
- **MAJOR**: a FAIL on the bar or on feel, look or sound that a player would
  notice in five minutes.
- **MINOR**: polish a reviewer would mention but a player would not leave over.

## Running the gate

1. **Evidence pack.** The builder deploys a preview (`vg deploy`), then
   captures everything the critic loop asks for into `captures/`, named with
   the commit. Nothing old is relabelled as new.
2. **Spawn the panel** in parallel, each with its prompt: its role section
   above, the verdict format, the build URL, the commit and the paths. Send
   nothing else.
3. **Validate each verdict.** Wrong format, an uncited PASS, a banned phrase,
   or a reviewer that edited code: throw it away and spawn a new one.
4. **Merge** into one punch list: dedupe, keep the highest severity, order
   blockers first. Hand it to the builder verbatim.
5. **Repeat** with a fresh panel until the gate passes. Post one line per
   round: `R<n>: 2 blockers, 5 majors (breaker 1/2, taste 0/3, ...); next: builder R<n+1>`.
   Round count is never a reason to stop or to soften.
6. **Gate:** no BLOCKER and no MAJOR from any role, the taste critic's blind
   lineup does not pick the game, and the person has listened and played
   (everything under CANNOT JUDGE). Then `deploy` to production.

If the same findings come back three rounds running, stop fixing items and
spawn a fresh diagnoser with the last verdicts and captures (`critic-loop.md`,
§ Stuck loop): the problem is usually one level up (wrong art direction, a
core loop with no decision in it, a camera that frames nothing).

## Report to the person

Report what the panel observed, not what the builder intended: which roles
pass, the open findings with their evidence, and what needs a human. If the
person stops early, say plainly which roles still fail.
