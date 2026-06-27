# Build Doc — Overthrow-style Arena (working title: **OVERTHRONE**)

> **For the implementing agent:** This is a self-contained build spec. Read it top to
> bottom, then build the game in `games/overthrow/` using the vibedgames `vg` CLI and the
> bundled Claude Code skills. It is opinionated about scope and architecture on purpose —
> follow the MVP milestones in order, and **ship the vertical slice before adding breadth**.
> Where a number is marked _(tunable)_ it is a starting default, not gospel — put it in
> `src/data/config.ts` and balance later.

---

## 0. TL;DR

Build a **top-down 3D online PvP arena deathmatch** in the spirit of the Dota 2 custom game
**Overthrow**. Players each control a champion, fight to rack up kills, and the central
**Throne** + a coin-throwing **Over Boss** + **catch-up item deliveries** keep fights
converging on the middle and keep losers in the game. First to the kill goal (FFA) or the
top team when the timer ends (team modes) wins.

- **Engine:** Three.js (low-poly 3D, top-down / 3⁄4 ARPG camera). Assets are **KayKit** GLB models (user-provided).
- **Multiplayer:** online PvP via `@vibedgames/multiplayer` (PartyServer). **Host-authoritative simulation, intent → snapshot** netcode — the exact pattern already shipped in `games/moba` (reuse it).
- **Platform:** static Vite build, deployed with `vg deploy` to `{slug}.vibedgames.com`.

---

## 1. Source game: how Overthrow actually works

Overthrow is the first official Valve-made Dota 2 custom game (shipped with the Reborn
beta). It is a **kill-race deathmatch** built on normal Dota heroes/items, with a few
signature twists that force action and rubber-band the score. Confirmed mechanics:

| Mechanic | Detail |
|---|---|
| **Players / modes** | 10 players. Configurations include **FFA** (free-for-all), **2v2v2v2v2**, and **3v3v3**, across several maps. |
| **Goal** | **FFA:** first player to the goal number of kills wins. **Team:** the team with the most kills when the round timer ends wins. **Tie → Sudden Death:** the first team/player to pull 1 point ahead of the current leader wins. |
| **Bases** | Each player/team spawns in a small base at the map edge with a shop, a secret shop, an **indestructible tower**, and a fountain (healing + safe zone). |
| **Midas Throne (center)** | A central platform. Standing near it gives **faster gold + XP gain** (an aura). It is the contested heart of the map. |
| **Over Boss** | A neutral boss that sits atop the Throne and **throws giant coins** out onto the map. **Picking up a coin = +300 gold.** |
| **Item deliveries (catch-up)** | Items are randomly air-dropped onto the map, marked on the minimap. **The fewer kills your team has, the better the item you receive** — rubber-banding for losers. |
| **Leader bounty** | Killing the top-rated player / a member of the leading team awards a **bonus +500 gold**. |
| **Map detail** | River around the edges with **rune** spawn locations; high-ground walking paths between bases and center. |
| **Pace** | Fast — accelerated gold/XP so heroes power up quickly and fights are constant. Death sends you back to your fountain on a respawn timer; no buybacks-as-strategy, you just get back in. |

**Design intent to preserve:** _constant fighting, a contested center, and mechanics that
punish the leader and arm the loser so nobody snowballs uncatchably._ That tension is the
game. Keep it.

Sources: [Dota 2 Wiki — Overthrow](https://dota2.fandom.com/wiki/Overthrow),
[Dota 2 Custom Games Wikia — Overthrow](https://dota2customgame.fandom.com/wiki/Overthrow),
[CyberScore — best custom games](https://cyberscore.live/en/articles/the-best-custom-games-in-dota-2/).

---

## 2. Our adaptation — decisions already made

These were chosen by the product owner; do not re-litigate them.

1. **PvP arena deathmatch** is the core loop (90% of the session is fighting other players).
2. **Online multiplayer from day one.** Use `@vibedgames/multiplayer`.
3. **Three.js, top-down / 3⁄4 ARPG camera.** KayKit models are low-poly 3D.
4. **Champion roster is small and hand-authored** — we cannot replicate Dota's 120+ heroes.
   Build **4–6 champions**, each with a basic attack + 3 abilities + 1 ultimate. This is the
   single biggest scope decision: Overthrow's depth came from Dota's hero/item pool; ours
   comes from a tight, readable roster plus the signature throne/coin/delivery loop.

### Scope reality check — host-authoritative netcode

`@vibedgames/multiplayer` is **host-authoritative, last-write-wins** (the platform's
multiplayer model). That is fine for this game **if** the host runs the whole simulation and
clients send inputs — which is exactly how `games/moba` already does real-time PvP on this
stack. **Do not** try to make each client authoritative over its own hero (last-write-wins
will let players cheat and desync). The host simulates; everyone else renders snapshots. See
§9.

---

## 3. Design pillars

1. **The center is the magnet.** Throne aura + Over Boss coins + delivery drops all pull
   players into the middle so fights happen. An empty map is a failure state.
2. **Nobody runs away with it.** Leader bounty + catch-up deliveries keep last place within
   striking distance. The scoreboard should stay close until the final kills.
3. **Readable at a glance.** Top-down 3D, big silhouettes, color-coded teams, loud hit feel.
   A spectator should understand who's winning in 2 seconds.
4. **Instant to join, instant to re-enter.** Pick champion → spawn → fight. Death costs you a
   short timer, never the match.

---

## 4. Core loop (per player)

```
spawn at base ─▶ move to center / contest Throne ─▶ fight enemies, grab coins & deliveries
     ▲                                                            │
     │                                                            ▼
 respawn timer ◀──── die ◀──── lose fight        get kills ─▶ gold + XP ─▶ level up + buy items
                                                       │
                                                       ▼
                                            reach kill goal / be top at timer ─▶ WIN
```

A match is ~5–8 minutes _(tunable)_. Long enough for two or three item purchases, short
enough to re-queue.

---

## 5. Match structure & modes

Ship **FFA first** (simplest netcode + fewest balance variables). Add team modes after the
vertical slice works.

| Mode | Players | Win condition | Ship order |
|---|---|---|---|
| **FFA** | 2–6 | First to **25 kills** _(tunable)_, or most kills at **8:00** _(tunable)_ | **MVP** |
| **Teams (2–3 teams)** | up to 6 | Most team kills at timer; sudden death on tie | Phase 2 |

- **Lobby:** one room = one match. Use a room id like `overthrow-<lobbyCode>`. First player
  in is host. Players pick a champion in a pre-match lobby; host starts the match when ≥2
  players are ready (or a countdown).
- **Sudden death:** if tied at timer, first to go +1 ahead wins (mirror Overthrow).
- **End screen:** scoreboard (K/D, gold, level), winner banner, "play again" → new room.

---

## 6. Arena / map design

A single symmetric arena (one map for MVP). See the `level-design` skill for arena pacing.

```
  ┌───────────────────────────────────────────────┐
  │  base(P1)        rune            base(P2)       │   • Bases at the edges: fountain
  │   ⛲                 ◆                ⛲          │     (heal + safe), shop pad,
  │                                                 │     indestructible spawn guard.
  │        delivery-pad         delivery-pad        │   • Center: raised THRONE platform
  │                  ┌─────────┐                    │     with the Over Boss on top and a
  │     rune ◆       │  THRONE │       ◆ rune       │     gold/XP AURA radius.
  │                  │  +AURA  │                    │   • Delivery pads: drop zones the
  │                  └─────────┘                    │     server marks; first to touch claims.
  │        delivery-pad         delivery-pad        │   • Runes ◆ spawn on a timer at fixed
  │                                                 │     spots (buff pickups, §10).
  │   ⛲                 ◆                ⛲          │   • Lanes/ramps connect edges→center;
  │  base(P3)        rune            base(P4)       │     a little cover (pillars/crates)
  └───────────────────────────────────────────────┘     breaks line of sight.
```

- **Throne aura:** a radius around center. Inside it: **+X% gold and +Y% XP** gain _(tunable;
  start +30% gold, +30% XP)_. This is the carrot that creates the brawl.
- **Bases:** fountain heals fast and a spawn guard makes spawn-camping impossible (damages or
  knocks back enemies that enter). No destructible towers in MVP — keep it a deathmatch.
- **Build the map as data**, not hand-placed in the renderer: `src/data/map.ts` exports
  spawn points, throne center+radius, rune spots, delivery pads, and a navmesh/grid. The sim
  reads this; the renderer reads this. (Mirror `games/moba/src/data/map.ts`.)

---

## 7. Champions

**4 champions for MVP, 6 at launch.** Each shares the KayKit rig so animations are
interchangeable. Use the `animation` skill for clip budgets and the `game-feel` skill for
cast/hit responsiveness.

### Attribute model (Overthrow inherits Dota's STR/AGI/INT)

Keep a lightweight version so itemization has meaning:

- **STR** → max HP + HP regen.
- **AGI** → attack speed + armor (physical mitigation).
- **INT** → max mana + ability power/cooldown.

Each champion has a primary attribute and per-level growth. Don't expose free point-buy
(Overflow did that; Overthrow uses fixed heroes) — fixed per-champion growth is simpler and
more readable.

### Roster (starting proposal — rename/retheme to match the KayKit models you're given)

| # | Champion | Primary | Fantasy | Basic attack | Kit (3 abilities + ult) |
|---|---|---|---|---|---|
| 1 | **Knight** | STR | Frontline bruiser | Melee cleave | Shield bash (stun) · Charge (dash + knockback) · Taunt aura · **ULT: Whirlwind** (AoE spin) |
| 2 | **Ranger** | AGI | Kiting carry | Ranged arrow | Multishot · Roll (dodge dash) · Trap (root) · **ULT: Rain of arrows** (big AoE) |
| 3 | **Mage** | INT | Burst caster | Ranged bolt | Fireball (AoE nuke) · Frost nova (slow) · Blink (teleport) · **ULT: Meteor** (delayed heavy AoE) |
| 4 | **Druid/Barbarian** | STR/INT | Sustain/control | Melee | Heal-over-time · Vine root · Leap · **ULT: Summon/Enrage** |
| 5 | **Rogue** | AGI | Assassin | Melee | Stealth · Backstab dash · Poison blade (DoT) · **ULT: Execute** (bonus dmg to low HP) |
| 6 | **Skeleton Mage / Necromancer** | INT | Zoner | Ranged | Bone spear · Curse (amp dmg taken) · Wall · **ULT: Raise minions** |

**Ability design rules:** 1 mobility, 1 control (stun/slow/root), 1 damage, plus a
game-ending ult on a long cooldown. Every champion needs a way **into** a fight and a way
**out**, or the throne brawl becomes a coin flip. Telegraph enemy ults (wind-up + ground
marker) — see `vfx` skill.

---

## 8. Combat & controls

Top-down ARPG combat. Default to **WASD movement + mouse-aim**, with click-to-move as a
fallback; the moba in this repo is click/right-click order based — pick **WASD+aim** for a
PvP deathmatch (more responsive, better on the throne brawl).

| Input | Action |
|---|---|
| **WASD / left stick** | Move |
| **Mouse aim / right stick** | Facing + skillshot direction |
| **Left click / right trigger** | Basic attack (auto-attacks nearest in range if no aim) |
| **Q W E** | Abilities 1–3 |
| **R / space** | Ultimate / mobility (bind the dash to a dedicated button) |
| **Shop key (B) / tab** | Open shop (only usable in base) |

- **Targeting:** ground-target (AoE), direction (skillshots), and unit-target (lock-on).
  Show range indicators and ground markers while aiming.
- **Damage:** `damage = base × (1 − mitigation)`. Physical mitigated by armor (AGI/items),
  magic by magic resist (items). Keep one or two damage types — don't port Dota's full
  table. (Overflow's Shock/Fire/Poison split is **not** part of Overthrow; skip it unless you
  want elemental flavor later.)
- **CC:** stun, slow, root, knockback, silence. Cap stun chains; add brief CC immunity after
  a long stun so players aren't perma-locked in the brawl.
- **Game feel is the make-or-break.** Invoke the `game-feel` skill and budget for: hit-stop on
  ability impact, screen shake on ults, knockback, damage numbers, kill notifications, and a
  satisfying coin-pickup pop. See §13.

---

## 9. Netcode — host-authoritative sim with intent → snapshot

**Reuse the architecture in `games/moba/src/net/` and `games/moba/src/sim/` verbatim in
spirit.** It already does real-time PvP on this exact stack. Only the **render layer** changes
(Phaser → Three.js); the sim and net layers are engine-agnostic plain data.

### The model

```
GUEST                                 HOST (first player in room)
  │  input each frame                   │  fixed-timestep authoritative sim (e.g. 30 Hz)
  │  ──INTENT event──────────────────▶  │  applies intents, runs combat/economy/throne/coins
  │                                     │  encodes World ──▶ sharedState["snap"]
  │  ◀──snapshot (sharedState.snap)──── │  broadcast at SNAPSHOT_HZ (~15 Hz)
  │  applySnapshot → render (interp)    │
```

- **Guests never simulate.** They send `INTENT` events (`move/aim`, `cast`, `useItem`,
  `buy`, `join`) and render the latest snapshot. Mirror `net/protocol.ts`:
  ```ts
  export type Intent =
    | { kind: "join"; champId: string }
    | { kind: "input"; move: {x:number;y:number}; aim: {x:number;y:number}; buttons: number }
    | { kind: "cast"; key: "q"|"w"|"e"|"r"; point?: {x:number;y:number}; targetId?: string }
    | { kind: "buy"; itemId: string }
    | { kind: "useItem"; slot: number; point?: {x:number;y:number} };
  ```
- **Host broadcasts a `Snapshot`** (Map→record encoding, drop closures, include an `rngState`
  seed so any guest can deterministically take over). Mirror `net/snapshot.ts`:
  `encodeWorld`, `applySnapshot`, `emptyGuestWorld`, `isSnapshot`.
- **Shared vs player state:** put the whole authoritative world in `sharedState["snap"]`
  (host writes). Use `room.sendEvent(...)` for intents (guest→host) and for fire-and-forget FX
  pulses (host→all), exactly like moba's `fx`/`fxSeq`.
- **Host migration:** if the host leaves or its snapshot `gameTime` stalls, a guest seizes the
  room and continues from the last snapshot (the `rngState` makes it deterministic). Copy
  moba's `shouldTakeOverHost` / rate-sampling logic.
- **Smoothness:** snapshots arrive at ~15 Hz; **interpolate** unit positions on the render
  side (render ~100 ms behind the latest two snapshots) so movement is smooth. Optionally add
  **client-side prediction for your own hero's movement** to hide latency, reconciling to the
  host snapshot — add this only after the basic loop feels right; it's the most bug-prone part.

### Tick budget
- Sim: 30 Hz fixed timestep on host.
- Snapshot broadcast: 15 Hz.
- Keep the snapshot small: only units, projectiles, ground effects, scores, throne/coin/boss
  state, delivery state, phase/timer. Don't ship static map data every frame.

---

## 10. Economy & the signature mechanics

This is what makes it _Overthrow_ and not generic deathmatch. Build all four.

### a) Gold & XP sources
| Source | Reward _(tunable)_ |
|---|---|
| **Kill** | +base gold (e.g. 150) + XP. Scales slightly with victim's level/streak (bounty). |
| **Throne aura** | Passive **+30% gold and +30% XP** while inside the center radius. |
| **Over Boss coin** | **+300 gold** per coin picked up. |
| **Item delivery** | A free item (value scales **inversely** with your kills — see catch-up). |
| **Leader bounty** | **+500 gold** for killing the current scoreboard leader / a leading-team member. |
| **Assist** | Partial gold/XP to nearby allies (team modes). |

### b) Over Boss
- A neutral unit on the Throne. It periodically **throws a coin** to a random reachable spot
  (telegraphed arc + landing marker). Coin persists a few seconds; first player to touch it
  claims +300 gold and a satisfying pop.
- Optional v2: the Over Boss can be attacked for a big gold bounty but hits back hard —
  a high-risk objective. Keep it passive for MVP.

### c) Catch-up item deliveries (rubber-band — **do not skip this**)
- Every N seconds the server spawns a delivery on a random delivery pad, marked for everyone.
- The **content scales to the claimant's standing**: a last-place player gets a strong item;
  the leader gets a weak one. Resolve the tier **when claimed**, by the claimant's rank, so it
  always helps whoever's losing. This is the core anti-snowball valve.

### d) Leader bounty
- Track the current leader (most kills; in teams, leading team). Their head has a price:
  killing them pays **+500** and a global "leader slain" callout. Makes winning dangerous and
  keeps the pack hunting the front-runner.

### e) Shop & items
- Shop usable only in your base (forces a retreat → risk/reward, and resets the brawl).
- Small curated item list (`src/data/items.ts`, mirror moba): a few **stat items** (HP, attack
  speed, ability power, armor, magic resist), a couple **actives** (blink, heal, cleanse), and
  maybe one build-defining item per archetype. **Keep it short** — 10–14 items. Use the
  `game-balance` skill for cost/power curves and to audit for a dominant item.

### f) Levels & XP
- Kill/aura XP → levels (cap ~10–15). Each level: stat growth + one ability point (unlock/rank
  Q/W/E, ult at the usual breakpoints). Capped so a fed player is strong but not unkillable —
  the catch-up systems assume a soft ceiling.

### g) Runes (optional, Phase 2)
- Timed pickups at fixed spots (haste, double-damage, regen, invis). Cheap to add, adds map
  movement. Skip for MVP if time-constrained.

### Respawn
- Respawn at your fountain on a timer that scales with level _(start: 3 + level × 0.7 s, cap
  ~12 s)_. Short enough that death never benches you, long enough that dying matters.

---

## 11. Rendering, camera & game feel (Three.js)

- **Camera:** orthographic or slightly-perspective top-down at a fixed 3⁄4 tilt, following the
  local player with a soft lerp and a small look-ahead toward the aim. Clamp to arena bounds.
- **Models:** KayKit GLB characters share a rig — load once, instance per champion, swap the
  skinned mesh + tint per team. Drive animations by **named clips** (Idle, Walk/Run, Attack,
  Cast, Hit, Death). Crossfade clips; sync attack-anim to the attack cooldown. (The
  `regenerate-3d` and `capacitor-ios` skills show GLTF/animation loading patterns with an
  `assets_index`; reuse that approach for the animation map.)
- **Environment:** KayKit Dungeon/Prototype kits for the arena floor, throne platform, pillars,
  base props. Bake lighting cheap (hemisphere + one directional + shadows off or low) — this
  runs in a browser tab on phones too.
- **Team/identity color:** strong rim or emissive tint per player/team; floating nameplate +
  HP bar; a marker under the local player.
- **Game feel (use the `game-feel` and `vfx` skills):**
  - Hit-stop (2–4 frames) on ability impacts and the ult.
  - Trauma-based screen shake (small on hits, big on ults/coin-grab).
  - Knockback + squash/stretch on impact.
  - Floating damage numbers, kill feed, killstreak callouts, "LEADER SLAIN" banner.
  - Juicy coin pickup (pop + chime + gold count tick). The coin is the dopamine; make it feel great.
  - Ability telegraphs (ground markers, wind-up) so the throne brawl is readable, not noise.
- **Audio:** generate SFX/music with `vg generate` (see §14) — attack, cast, hit, death, coin,
  level-up, victory sting. Spatialize lightly.

---

## 12. Mobile / touch controls

Use the **`gamepad` skill** (`@vibedgames/gamepad`): left virtual stick = move, right stick or
aim-pad = facing/skillshot, on-screen buttons for Q/W/E/R + attack + shop. The whole game must
be playable one-thumb-per-stick on a phone in portrait or landscape. Test early — retrofitting
touch is painful.

---

## 13. Tech architecture & file layout

Mirror the proven `games/moba` split (sim / render / net / data are separate so the
authoritative sim is engine-agnostic and testable). Use Vite + TypeScript.

```
games/overthrow/
  package.json            # deps: three, @vibedgames/multiplayer, @vibedgames/gamepad
  vite.config.ts
  index.html
  public/assets/          # KayKit GLBs, textures, generated icons/SFX, skybox
  src/
    main.ts               # boot: renderer, net, scene wiring, game loop
    data/
      config.ts           # ALL tunable constants (the §15 table)
      map.ts              # spawns, throne center+radius, rune spots, delivery pads, navgrid
      champions.ts        # roster: stats, growth, ability defs
      items.ts            # shop items
    sim/                  # ENGINE-AGNOSTIC authoritative simulation (no Three.js imports)
      world.ts            # step(world, dt, intents) — the host loop
      types.ts            # Unit, Projectile, GroundEffect, Coin, Delivery, World
      combat.ts           # damage, armor/MR, CC, death/respawn
      abilities.ts        # ability execution
      economy.ts          # gold/XP, throne aura, coins, deliveries, leader bounty
      stats.ts            # attribute → derived stats
      math.ts / grid.ts / nav.ts
    net/
      protocol.ts         # Intent type, room/host constants, INTENT_EVENT
      snapshot.ts         # encodeWorld / applySnapshot / emptyGuestWorld / isSnapshot
    render/               # Three.js — reads World/Snapshot, never mutates sim
      view.ts             # scene, camera, lights, follow
      models.ts           # GLB load, rig, animation map, instancing, team tint
      fx.ts               # particles, hit-stop, shake, damage numbers
      hud.ts              # health/mana/abilities/scoreboard/shop/minimap
      audio.ts
    scenes/
      menu-scene.ts       # lobby: room code, champion select, ready-up
      game-scene.ts       # host/guest branch, intent send, snapshot apply, host migration
      end-scene.ts        # scoreboard + winner + play again
```

**Determinism:** the sim must be deterministic given `(world, intents, rngState)` — seed all
randomness through `rngState` in the World so host migration is seamless (copy moba's rng
closure pattern). No `Math.random()` / `Date.now()` in `sim/`.

**Dependencies:** `three`, `@vibedgames/multiplayer` (`workspace:^`), `@vibedgames/gamepad`.
Match the catalog/tsconfig setup of an existing game's `package.json`.

---

## 14. Asset plan

The product owner supplies **KayKit-based character models**. Spec what you need from them and
generate the rest with `vg generate` (see the `generate`, `model-catalog`, `pixel-art`,
`cinematography`, `media-workflow` skills).

**Required from the user (KayKit):**
- 4–6 rigged champion GLBs sharing one skeleton, each with clips: `Idle`, `Walk`/`Run`,
  `Attack` (1–2 variants), `Cast`, `Hit`, `Death`. Weapon attachment points if weapons are
  separate meshes.
- Arena/environment kit pieces (floor tiles, throne platform, pillars, base props) — KayKit
  Dungeon / Prototype Bits.
- The Over Boss model (a larger creature/idol on the throne).

**Generate with `vg generate` (don't name any provider in user-facing text):**
- **Ability/item icons** (Q/W/E/R + shop items) — a consistent icon set.
- **VFX textures / sprite FX** for spells, hit sparks, coin shimmer (`vfx` + `pixel-art`).
- **SFX & music** — attack/cast/hit/death/coin/level-up/victory; a short looping arena track.
- **Skybox / arena backdrop** and a key-art splash for the menu and the deploy listing.
- Use `--json` on every `vg generate` call so the build agent can parse results, and follow the
  `media-workflow` skill for multi-asset batches.

Validate assets with the `asset-pipeline` skill (manifest vs files on disk).

---

## 15. Tunable constants (starting defaults → `src/data/config.ts`)

| Constant | Default | Notes |
|---|---|---|
| `MODE` | `ffa` | `ffa` first; `teams` later |
| `KILL_GOAL_FFA` | 25 | first to this wins |
| `MATCH_TIME` | 480 s | fallback timer; top score wins; ties → sudden death |
| `MAX_PLAYERS` | 6 | per room |
| `SIM_HZ` / `SNAPSHOT_HZ` | 30 / 15 | host sim / broadcast rate |
| `THRONE_RADIUS` | ~8 units | center aura size |
| `THRONE_GOLD_MULT` / `THRONE_XP_MULT` | +30% / +30% | aura bonus |
| `KILL_GOLD` / `KILL_XP` | 150 / 120 | base reward |
| `COIN_GOLD` | 300 | Over Boss coin |
| `COIN_INTERVAL` | 12 s | boss throw cadence |
| `LEADER_BOUNTY` | 500 | bonus for killing the leader |
| `DELIVERY_INTERVAL` | 25 s | catch-up drop cadence |
| `RESPAWN_BASE` / `RESPAWN_PER_LVL` / `RESPAWN_CAP` | 3 s / 0.7 s / 12 s | death timer |
| `LEVEL_CAP` | 12 | soft power ceiling |
| `ITEM_COUNT` | 10–14 | curated shop |

Balance with the `game-balance` skill once it's playable; audit for dominant champion/item.

---

## 16. Build milestones (ship in this order — `finish-it` discipline)

**Do not build breadth before the slice is fun.** Each milestone is independently playable.

- **M0 — Boot & render (single player, no net).** Three.js scene, arena from `map.ts`, one
  KayKit champion you can WASD around with a follow camera and Idle/Run/Attack animations.
- **M1 — Combat slice (single player).** Basic attack + 3 abilities + ult vs a dummy bot.
  Damage, HP/mana, death/respawn, hit feel (game-feel skill). _This is the fun test — if M1
  isn't satisfying solo, multiplayer won't save it._
- **M2 — Online FFA core.** Wire `@vibedgames/multiplayer`: host-authoritative sim, intent →
  snapshot, interpolation, 2–4 players in one room fighting to a kill goal. Lobby + champion
  select + end screen. Host migration.
- **M3 — Signature economy.** Throne aura, Over Boss coins, leader bounty, catch-up
  deliveries, gold/XP/levels, shop & items. _Now it's Overthrow, not just deathmatch._
- **M4 — Roster & polish.** Fill out 4–6 champions; full VFX/audio/juice pass; HUD,
  scoreboard, minimap, kill feed; onboarding (`onboarding` skill) for the first 30 seconds.
- **M5 — Mobile & deploy.** `gamepad` touch controls; perf pass for phones; `vg deploy`.
- **Phase 2 (post-launch):** team modes (2–3 teams), runes, attackable Over Boss, more
  champions/items, ranked lobbies.

**Scope cuts if you're over budget (cut from the bottom up):** runes → team modes →
attackable boss → 5th/6th champion. **Never cut:** throne aura, coins, catch-up deliveries,
leader bounty — those four _are_ the game.

---

## 17. Which skills to use, and when

| Step | Skill(s) |
|---|---|
| Engine scaffolding, scenes, rendering | `threejs`, `phaser` (reference moba), `game-playbook` |
| Multiplayer wiring | `multiplayer` (and read `games/moba/src/net`, `/sim`) |
| Touch controls | `gamepad` |
| Champion/ability feel, animation budgets | `animation`, `game-feel` |
| VFX / particles / impact | `vfx` |
| Economy, costs, anti-snowball tuning | `game-balance` |
| Arena & wave/spawn pacing | `level-design` |
| First-30-seconds, teaching the loop | `onboarding` |
| Asset generation (icons, SFX, music, skybox, key art) | `generate`, `model-catalog`, `pixel-art`, `cinematography`, `media-workflow` |
| Asset manifest validation | `asset-pipeline` |
| Testing (deterministic sim, canvas/WebGL) | `playwright` |
| Scope discipline / finish line | `finish-it` |
| Design QA before ship | `design-lenses` |
| Ship it | `deploy` (`vg deploy --slug overthrow`) |

---

## 18. Open questions / things to confirm before/while building

1. **Champion themes & count** — confirm the 4 MVP champions and their fantasy once the KayKit
   models are in hand (rename the §7 roster to match the actual art).
2. **Player count target** — is 6 the cap, or do you want up to 10 like real Overthrow? (Higher
   counts stress the snapshot size and the brawl readability — start at 6.)
3. **FFA vs teams for launch** — doc assumes FFA-only at launch, teams in Phase 2. OK?
4. **Match length & kill goal** — 8 min / 25 kills are guesses; confirm the target session
   length.
5. **Movement scheme** — doc picks WASD + mouse-aim (twin-stick-ish) over Dota's click-to-move,
   for PvP responsiveness. Confirm.
6. **Elemental damage flavor** — Overthrow has none; want simple physical/magic only (default),
   or add an elemental layer later?
7. **Persistence** — any accounts/MMR/cosmetics, or pure drop-in lobbies (default)?

---

### Appendix — canonical in-repo references to copy from

- `games/moba/src/net/protocol.ts` — intent enum + room/host constants.
- `games/moba/src/net/snapshot.ts` — `encodeWorld` / `applySnapshot` / host-migration-safe
  snapshot (Map↔record, `rngState`).
- `games/moba/src/scenes/game-scene.ts` — host/guest branch, `sendEvent(INTENT_EVENT, …)`,
  reading `net.sharedState["snap"]`, snapshot-rate sampling + `shouldTakeOverHost`.
- `games/moba/src/sim/*` — deterministic world step, combat, abilities, stats, grid/nav.
- `games/moba/src/data/*` — `map.ts`, `items.ts`, `heroes.ts`, `config.ts` shape.
- `packages/multiplayer/README.md` — the `@vibedgames/multiplayer` hook API
  (`useMultiplayerRoom`, `useMultiplayerState`, `usePlayerState`, `useIsHost`,
  `room.sendEvent`, `onEvent`, `sharedState`, `players`, `playerId`).

> Net of it all: **Overthrow's magic is a contested center plus anti-snowball valves.** Build
> the brawl, then build the four mechanics that keep the brawl close, then make it _feel_
> great. Everything else is optional.
