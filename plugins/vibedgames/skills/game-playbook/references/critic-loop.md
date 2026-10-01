# Critic loop: capture → fresh critic → punch list → fix

The loop that enforces `visual-bar.md`. Three roles, kept apart:

- **You (orchestrator)** own the loop and validate verdicts. You never score.
- **Builder** — you, or a subagent — changes code and assets, then captures.
  Never scores, never claims quality.
- **Critic** — a **fresh** subagent or session every check, files only. Never
  edits. Reuse one critic across rounds and it drifts: it passes in round 8
  what it failed in round 3 with nothing changed.

The critic must open images at full resolution. If none can, stop — never score
from a text description of a frame.

## Capture (each round, all of it)

Fixes change every frame, so re-capture everything; partial sets are rejected.

1. **Stills** — one per ref, framed to that ref's slot, camera distance and
   subject. Drive the game to the state with `__GAME_TEST_HOOKS__`, freeze it
   (`playtest` → `references/canvas-determinism.md`), then
   `vg playtest screenshot captures/still-NN.png` at ≥ 1920×1080
   (`vg playtest set viewport 1920 1080`).
2. **Manifest** — `captures/MANIFEST.md`: file, commit, resolution, scene, matched ref.
3. **Motion frames** — 8–12 screenshots across a real run: boot/title, core loop,
   a hit, a win or fail, every HUD state → `captures/motion-NN.png`.
4. **Side-by-sides** — per pair, with the `playtest` skill's `ref-sxs.mjs`
   (load `playtest` for how its `$SKILL` resolves):
   `node $SKILL/scripts/ref-sxs.mjs --ref refs/ref-NN-x.png --game captures/still-NN.png --out captures/sxs-NN.png`
   writes `sxs-NN.png` + `sxs-NN-blur.png` (red strip = ref, green = game).

Keep `captures/` out of `public/` and out of the deploy.

## Builder handback (no quality claims)

```
ROUND R<n> COMPLETE
commit: <sha>
captures: stills (N), motion (N), sxs (N pairs)
addressed: 1, 2, 3
not addressed: 4 (reason; proposed escalation rung if any)
```

"Looks great, should pass" is not a handback.

## Critic prompt (fill the `<…>`, send nothing else)

```
You are the Critic. Score live captures of a browser game against locked
reference screenshots of shipped games. You do not build, fix, or advise on
implementation. Output exactly one verdict block, nothing else.

Read: art/BAR.md (the only criteria you score, in its order), art/LOOK.md,
refs/ + refs/SOURCES.md, captures/still-*.png + MANIFEST.md,
captures/sxs-*.png and sxs-*-blur.png, captures/motion-*.png.
Previous verdict: <path or none>. Scope: <all | C1,C3 | ...>. Round: R<n>. Commit: <sha>.

1. Inventory. One still per ref at matched framing, ≥1920×1080, manifest lists
   <sha>, every sxs has a -blur twin, 8–12 motion frames. Anything short →
   VERDICT: RECAPTURE with a numbered list, and stop. Never use RECAPTURE to
   dodge a FAIL ("capture from a more flattering angle" is a FAIL).
2. Open every still beside its ref at full resolution; walk every criterion.
3. Open every -blur pair: same genre? same production tier? Any no fails C3.
4. Check every motion frame; one bad frame fails C5.
5. A criterion PASSes only if it passes on every still, pair and frame it
   applies to.
6. PASS or FAIL only — no scores, no partial credit, no "PASS with notes".
   Don't compare to the previous round (use it only to see whether flagged
   regions changed). Don't comment on fun, code or effort. Don't suggest
   changing the refs or the bar. If you want to write "close enough", "fine
   for a browser game" or similar, the criterion is FAIL — write the punch item.

Punch item:
N. [C<id> <name>] <still ids> vs <ref ids>, <region>: <observed defect>; <what
the ref shows>. Done when <observable condition>.
Order by impact on the blur test. Group repeats. Name the visual target, never
the implementation (no "add SSAO", no library names).

Formats:
VERDICT: WIN
ROUND / COMMIT / then each criterion: "C<n> <name>: PASS. <evidence citing every still>"

VERDICT: FAIL
ROUND / COMMIT / CRITERIA: C1 PASS | C2 FAIL | ... (every BAR criterion, n/a if out of scope)
PUNCH LIST: 1. ...

VERDICT: RECAPTURE
1. <capture defect and what a correct capture looks like>

VERDICT: BLOCKED
REASON: <what could not be opened>
```

## Running it

- **Validate every verdict** before acting: right format, every `BAR.md`
  criterion in scope scored, every still cited, no banned phrase, no numbers.
  Invalid → discard and spawn a new critic.
- **FAIL** → hand the punch list to the builder verbatim. Next round.
- **RECAPTURE** → fix the captures and re-run. Not a round.
- After each round, one status line, then keep going without asking:
  `R<n> FAIL: failing C1, C3; punch items 4; rung none; next: builder R<n+1>`
- Ten or more rounds is normal when the gap is large. Round count is never a
  reason to stop or to soften.

### Stuck loop

Trigger: 3 FAILs in a row on the same criteria family, or the builder keeps
shipping the same class of fix (one more prop, one more panel) while the punch
list stays the same shape.

Pause punches. Spawn a fresh **diagnoser** with the last verdicts, current
stills and side-by-sides, `LOOK.md` and `BAR.md` — not builder chat. It writes:
root cause (wrong rung, stack ceiling, capture problem, punch list too
shallow), cited evidence, what to stop doing, 1–2 rounds of concrete steer
steps (may include an escalation rung), and what should visibly change in the
blur pairs if it worked. Apply the steer, then back to capture → critic. The
diagnoser never edits the game and never touches the bar.

### WIN is necessary, not sufficient

On a critic WIN, open every still and side-by-side yourself and write a short
plain read: one art system or a kit collage? Proportions consistent across
characters, props and buildings? Perspective and ground plane coherent? Light
coherent? Does the game half belong next to the refs? Any no → the WIN is void;
say so with the stills and resume punches. The user's eye overrides any critic
WIN. Only then: verify no ref bytes in the build (`refs/` hashes vs `dist/`),
and ship (`deploy`).

If the user stops mid-loop, report best-so-far honestly: which criteria are
still short of the refs.
