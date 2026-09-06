# Quality beyond the first polish pass

The active goal is AAA finish quality across the collection. Prior graphics and
session passes establish the baseline. The remaining work below is now part of
the [AAA completion plan](aaa-completion-plan.md), not a reason to end the task.
Preserve each game's existing identity, core rules and input/animation paths.

## Completed graphics pass

The two graphics upgrades below are implemented and verified. All ten games also
received the [complete-session quality pass](session-quality-plan.md), implemented
one game at a time. [Verification and limits](session-quality-report.md) record
the tested behavior and the remaining release work.

### Bomberman: a stronger art direction

Replace seven static textures with a coordinated generated set: sage courtyard,
blue-gray beveled stone, amber reinforced crates, glossy dark bomb, and three
brass pickup medallions. Keep the original teal characters and generated fire
animation. Retain the grass outside the arena; give blockers, bombs and pickups
contact shadows. Match the fuse effect to the new sprite.

Frame arena edges more tightly with the current zoom. Reserve enough screen
space for the existing touch bomb button at narrow or low-zoom viewports.

Keep collision tiles, movement, fuse deadlines, chains, drops, bots and controls.
Check small-screen readability, texture filtering, transparent edges, shadow
cleanup, chain reactions, pickups, pause and existing effects under load.

Asset prompts and runtime paths: [Bomberman art direction](bomberman/art-direction.md).

### Starfall: a convincing battle in space

Make each existing weapon visually distinct through luminous cores, trails,
muzzle effects and directional impacts. Add layered vector destruction: hot
flash, hull fragments, debris and slower afterglow. Give the boss a bounded
sequence of secondary detonations and shock fronts. Add subdued distant salvos
and explosions for depth, clearly behind the playable battlefield.

Preserve projectile geometry, damage, attack cadence, ship handling, locked aim,
network rules and the vector hulls. Protect threat outlines and the local ship
from decorative effects. Use bounded pools, separate cosmetic randomness, scene
time and reduced motion. Check every weapon family, crowd saturation, boss
defeat, pause, reset, scene cleanup and portrait readability.

Unresolved questions: none for this pass.

## Release work after the session pass

1. Play complete sessions on a phone and laptop. Measure input-to-response delay,
   loading, frame pacing and sustained heat. Exercise actual hand/face/pose
   recognition, native touch and controller reconnects; synthetic inputs cannot
   establish those qualities.
2. Listen to each mix on phone speakers and headphones. Tune relative levels,
   quiet intervals and repeated sounds. Source budgets establish cleanup and
   headroom, not whether a mix sounds good.
3. Continue real two-client checks for reconnect, host migration and match
   endings. Ancients' ended-snapshot takeover bug is fixed: only the connected
   elected host simulates and writes. Live checks preserve hero seats, match
   state and results through reconnect, promotion and late join.
   [Authority evidence](/Users/kyh/.codex/visualizations/2026/09/05/01a072e5-b121-77b0-b7f7-52a06ec3e9e2/aaa-completion/moba-authority/README.md).
4. Make quality settings and input teaching discoverable, then observe a new
   player without coaching. Fix the point where they hesitate or lose the action.
5. Add one optional replay feature per game, evaluate it with players, then tune.
   More simultaneous mechanics would obscure which change improves the game.

## Next candidate per game

These are queued implementation directions. The completion plan tracks active
work and verified results; they are not yet claimed as implemented.

| Game                  | Next candidate                                                                             | Purpose                                                                     |
| --------------------- | ------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------- |
| Crazy Waymo           | Measure its current full session and device behavior                                       | Establish a reliable reference without disturbing its ongoing work          |
| Pong                  | Spin practice and optional trick-shot challenges                                           | Teach the existing expressive move and give rematches goals                 |
| Flappy Dragons        | Authored forest landmarks and optional seeded daily routes                                 | Give pose flight a memorable journey and repeatable challenge               |
| Bomberman             | Dedicated character anticipation/victory clips, then optional arena mutators               | Bring character acting up to the new courtyard art and deepen rematches     |
| Farm                  | Seasonal collection goals and additional character/tool transition clips                   | Give daily routines longer-term purpose while preserving yields and fishing |
| Pacman                | A measured musical escalation pass and optional maze challenges                            | Give the plush chase more contrast and replay variety                       |
| Tetris                | Optional seeded score challenges and clearer examples of advanced placement                | Build mastery around the existing spatial puzzle and rescue mechanic        |
| Lunerfall             | Enemy anticipation/recovery clips and a portrait-first hub layout                          | Make threats easier to read and remove the small letterboxed phone menu     |
| Ancients of Eldermoor | Crowd plates, neutral attack poses, action labels, settings and adaptive score implemented | Live authority, pause and dense-fight receipts in the completion plan       |
| Battle Arena          | Consistent champion animation transitions and material/lighting treatment                  | Make the whole arena match its strongest effects                            |
| Starfall              | Authored encounter pacing and optional weapon-specific trials                              | Give the battle more contrast, identity and reasons to return               |

New mechanics remain optional until playtests show that they improve the game.
Existing video, hand, face, pose, touch and controller paths remain core product
constraints. None of these proposals authorizes a balance rewrite.

Unresolved questions: none blocking this implementation; prioritize replay modes
from observed playtests.
