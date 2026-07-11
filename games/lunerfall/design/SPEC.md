# Lunerfall — SPEC

> Compass, not a plan. One page. Deploys to `lunerfall.vibedgames.com`.

## Hook

A TowerFall-fast roguelite crawl through a procedurally-stitched neon shrine.
Pick one Little warrior; **dash, stomp, and slash** through rooms of minions,
spend relics at shrine-merchants, descend past bosses. One life per run.
Solo or **online co-op** (2–4).

## References

- **TowerFall Ascension** — movement feel, dash, head-stomp, retrievable
  arrows, one-hit snap.
- **Nuclear Throne / Enter the Gungeon** — room-to-room proc-gen crawl,
  branching exits, room types.
- **Hades / Dead Cells** — run structure, in-run boons, meta unlocks.
- **The twist:** TowerFall is a single-arena PvP deathmatch; we keep its _feel_
  but wrap it in a co-op roguelite crawl. Melee heroes (not just archers) make
  that wrap sing.

## Perspective & engine

Side-on 2D pixel platformer. **Phaser** + a hand-rolled fixed-step platformer
controller (precise TowerFall movement — not arcade-physics mush).

## The 30-second loop

Drop into a room → minions spawn from torii gates → dash in, stomp one, combo
two, dodge the archer's arrow → room clears, doors open → pick an exit
(💰 merchant / ⚔️ combat / 💀 elite / ❓ mystery) → 4–6 rooms → **boss** →
descend. Die → back to hub with what you banked.

## Combat model (the TowerFall soul)

- **Universal:** run, jump, wall-slide, **dash** (i-frames), **head-stomp** kill.
- **Lethality:** player has a small **heart pool** (3–4); enemies die in **1–2
  hits**. Arcade snap, but survivable across a multi-room run.
- **Per-hero verb** (fixed archetypes, pick one per run):
  - **Axion** (teal sword) — 3-hit ground combo + super-smash. The comboer.
  - **Reaper** (pink scythe) — wide slashes + leaping "surprise jump." Reach/leap.
  - **Riven** (blades) — **smoke teleport blink** + double-slash. Assassin.
  - **Mooni** (staff) — spin + thrust + **self/ally heal**. Support/tank.
  - **Salamander** (fire) — fire punch/slam + **retrievable flame-wave
    projectile**. Ranged bruiser. Also the first boss.
- **Ranged tension:** projectile heroes have scarce, **retrievable** shots
  (pick them back up — the TowerFall pickup loop).

## Enemies (crawl bestiary — 80px minions)

Warrior (melee), Spearman (charge-lunge), Archer (arrows), Bomber (suicide AoE).
**Boss:** Salamander (flame-wave projectile, slam AoE). More via `vg generate`
later.

## Rooms & proc-gen

Hand-authored platform **templates**, randomly picked + populated at runtime.
A run = a small **branching map** of typed rooms; player chooses exits.
Types: combat/wave, elite, **shrine-merchant** (spend relics), treasure,
rest/fountain (heal), boss. Torii gates = doors. Teal/magenta neon shrine art.

## Win / lose / session

- **Lose:** hearts → 0. Permadeath, back to hub.
- **Win (run):** clear the boss → descend to next biome (endless-ish; MVP = 1
  biome + boss).
- **Session:** 5–15 min a run. Pull = unlocks + "one more run."

## Progression

- **Persistent (hub):** start with 1–2 heroes; unlock the rest + buy permanent
  shrine perks with currency banked from runs.
- **In-run:** relics/boons from merchants + shrines, reset on death.

## Multiplayer

**Online co-op, 2–4 players**, host-authoritative via `@vibedgames/multiplayer`
(PartyServer). Host simulates world+enemies; clients send inputs + own their
avatar. Shared dungeon, shared boss, revive downed teammates. Solo = host alone.
(Online _versus_ explicitly out — our last-write-wins stack fights competitive
twitch hit-detection.)

## Art / audio direction

- **Art:** the Luneblade pack — chibi neon warriors, near-black stone platforms
  with teal/magenta neon edges, torii gates + shrines + braziers. Moonlit,
  moody, high-contrast. Missing pieces (extra bosses, UI, covers) via
  `vg generate`.
- **Audio:** taiko/synth hybrid — driving neon-oriental. The 5 that matter:
  **hit/slash**, **stomp-kill**, **dash whoosh**, **hurt**, **boss roar**.

## Title / slug

**Lunerfall** → `lunerfall.vibedgames.com`.

## MVP cut (first deploy)

IN: solo run; 1 biome; proc-gen room stitching + 4 room types (combat, merchant,
rest, boss); **1–2 heroes** feeling _great_; 4 minions; Salamander boss; hearts;
in-run relics; hub with hero-unlock. **Then** layer online co-op.
OUT of first deploy: all 5 heroes, versus mode, multiple biomes, deep meta tree.
Ship a solo slice that _feels_ like TowerFall before adding netcode.
