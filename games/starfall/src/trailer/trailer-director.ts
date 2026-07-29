// trailer-director.ts — STARFALL trailer mode (?trailer=1).
//
// The shell (trailer-shell.ts) owns the letterbox and the dip-to-black cuts;
// this file owns the game: it installs the staging overrides (trailerStage()),
// forces the offline solo session, and choreographs the 19-scene arc from the
// beat sheet. Every scene's setup() fully re-stages the world — no scene
// depends on RNG luck, the network, or a previous scene's state.
//
// FRAMING CONTRACT (the thing the last cut got wrong): normal play clamps zoom
// to clamp(width/1100, 0.9, 1), so 1.0 is what a player already sees. A trailer
// that frames WIDER than that is showing the game worse than the game does.
// Every shot here sits at zoom >= 1.0, and staging radii are sized from the
// shot's own half-frame (800/zoom by 450/zoom world px) so nothing composed for
// the shot lands off camera. Apparent density is bodies-per-SCREEN, not
// bodies-per-world — the escalation is carried by tightening the frame while
// the count rises, never by pulling the camera back.
//
// COVERAGE CONTRACT: the reel walks the game's axes rather than repeating one.
// Weapons appear in distinct CATEGORIES (screen-clear, pierce, chain, gravity,
// charged lance, deployables, homing swarm, point-blank flak), both halves of
// the loadout are shown (shield mods, boosters), the roster's elites get a shot
// where their mechanic is legible, PvP is a real fight between two ships, and
// the boss runs phase 1 -> 2 -> 3 and DIES on camera.

import type Phaser from "phaser";
import type { Player, PlayerMap } from "@vibedgames/multiplayer";

import { sfx } from "../audio/sfx";
import { GameScene } from "../scenes/game-scene";
import { ENEMY_SPECS, xpToNext } from "../shared/constants";
import type {
  EnemyKind,
  EnemyState,
  SerializedBeam,
  ShieldModKind,
  Vec,
} from "../shared/constants";
import { runTrailer } from "./trailer-shell";
import type { TrailerScene } from "./trailer-shell";
import type { TrailerStageApi } from "./trailer-staging";

const TAU = Math.PI * 2;

/** Deterministic per-scene jitter (never the game RNG — staging layouts stay
 *  identical across replays regardless of how much rand() the sim consumed). */
function mulberry(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const angleTo = (from: Vec, to: Vec): number => Math.atan2(to.y - from.y, to.x - from.x);
/** Wrap an angle difference into [-π, π]. */
const wrapAngle = (a: number): number => {
  let r = a % TAU;
  if (r > Math.PI) r -= TAU;
  if (r < -Math.PI) r += TAU;
  return r;
};
const dist = (a: Vec, b: Vec): number => Math.hypot(a.x - b.x, a.y - b.y);
const lerp = (a: number, b: number, t: number): number => a + (b - a) * Math.max(0, Math.min(1, t));
/** Smoothstep ease for zoom/camera glides. */
const ease = (t: number): number => {
  const c = Math.max(0, Math.min(1, t));
  return c * c * (3 - 2 * c);
};

// ---- fake peers --------------------------------------------------------------------
// Offline "remote players": Player entries whose state records feed the real
// peer pipeline (readNetState → ship gfx, shield rings, remote beams, enemy
// targeting, boss lance locks, beacon occupancy, sector standings). Bolts they
// fire are visual SerializedBeams; against enemies they are paired with real
// damageEnemy() calls, and against the PLAYER they need no pairing at all — the
// victim adjudicates PvP drain straight off st.beams in the real damage path.

type Bolt = { x: number; y: number; vx: number; vy: number; traveled: number };

type CrewMode = "idle" | "combat" | "duel";

type FakePeer = {
  player: Player;
  state: Record<string, unknown>;
  post: Vec;
  /** When set, the orbit POST glides here at postSpeed — a wingmate breaking
   *  into the beacon zone, or a RAM rival committing to its run. */
  postTarget: Vec | null;
  postSpeed: number;
  orbitR: number;
  angVel: number;
  phase0: number;
  baseAim: number;
  shotGapMs: number;
  tint: number;
  nextShotAt: number;
  bolts: Bolt[];
  x: number;
  y: number;
  angle: number;
};

const PEER_COLORS = ["#7ae0ff", "#ff7ad1", "#8dff9e", "#c9a2ff", "#ffd166"];
const PEER_TINTS = [0x7ae0ff, 0xff7ad1, 0x8dff9e, 0xc9a2ff, 0xffd166];
const BOLT_SPEED = 560;
const BOLT_RANGE = 740;
const BOLT_DAMAGE = 26; // one-shots fodder (drone 20 / wasp 25), like a beam hit
/** Serialized power of a rival's PvP bolt: 0.35 → a 35 drain, victim-side. */
const DUEL_BOLT_POWER = 0.35;

const show = (node: HTMLElement | null, on: boolean): void => {
  if (node) node.style.display = on ? "" : "none";
};

export function bootTrailerDirector(game: Phaser.Game): void {
  const tryBoot = (): void => {
    const scene = game.scene.getScene("Game");
    if (scene instanceof GameScene && game.scene.isActive("Game")) {
      direct(scene);
      return;
    }
    window.setTimeout(tryBoot, 60);
  };
  tryBoot();
}

function direct(scene: GameScene): void {
  const api: TrailerStageApi = scene.trailerStage();
  const staging = api.staging;
  const cam = scene.cameras.main;

  // Straight into the offline solo arena — no start overlay, no attract mode.
  api.forceStart();

  // Audio: unmute for this session only (direct field write — toggleMute would
  // persist the choice). Safe before any gesture because it builds nothing:
  // with no AudioContext yet, play() no-ops, and whichever path finally calls
  // unlock() then builds the graph at full gain instead of silently at zero.
  // The context itself is created in runTrailer's onGesture below — the trailer
  // rolls without a gesture, so an eager context would just sit suspended.
  sfx.muted = false;

  // ---- HUD policy -----------------------------------------------------------------
  // Everything hidden by default; scenes restore only what sells the shot
  // (loadout pop, combo pill, boss bar, sector tally). Canvas-side HUD (minimap,
  // edge pips) is suppressed by the trailer guards inside game-scene.
  const hud = {
    root: document.getElementById("hud"),
    left: document.querySelector<HTMLElement>("#hud > div:first-of-type"),
    right: document.getElementById("hudright"),
    players: document.getElementById("players"),
    boss: document.getElementById("bossbar"),
    combo: document.getElementById("combo"),
    pulse: document.getElementById("pulse"),
    recap: document.getElementById("recap"),
    countdown: document.getElementById("countdown"),
  };
  const hudBaseline = (): void => {
    show(hud.root, false);
    show(hud.boss, false);
    show(hud.combo, false);
    show(hud.pulse, false);
    show(hud.recap, false);
    show(hud.left, true);
    show(hud.right, true);
    show(hud.players, true);
    show(hud.countdown, true);
    // The bar is authored 14px from the viewport top; inside the 16:9 letterbox
    // that clips its top row. Scenes that turn it on push it clear.
    if (hud.boss) hud.boss.style.top = "";
  };
  hudBaseline();

  // ---- shared choreography state ----------------------------------------------------
  const camLock: Vec = { x: 0, y: 0 };
  let crew: FakePeer[] = [];
  let peerMap: PlayerMap | null = null;

  const steer = (angle: number, thrust: number): void => {
    staging.steer = { angle, thrust };
  };
  const anchor = (dx: number, dy: number): Vec => {
    const { w, h } = api.worldSize();
    return { x: w / 2 + dx, y: h / 2 + dy };
  };
  /** Anchor measured from the LEFT world edge instead of the centre. The play
   *  area grows with player count and never shrinks (worldScaleForPlayers), so
   *  once any scene has installed fake peers a centre-relative anchor no longer
   *  sits a known distance from the energy barrier — and for the barrier run
   *  that standoff IS the shot. */
  const edgeAnchor = (fromLeft: number, dy: number): Vec => {
    const { h } = api.worldSize();
    return { x: fromLeft, y: h / 2 + dy };
  };
  /** Shield floor: keeps the ring LOOKING healthy between staged volleys so a
   *  crowd scene doesn't spend itself down to a sliver on camera. It is not
   *  what keeps the pilot alive — `staging.deathless` is (set in stage(),
   *  cleared only by the death beat), because a once-per-rAF top-up always
   *  races the several drains that can resolve inside one sim step. Default 85
   *  covers the sparse scenes; bullet-weather scenes pass 130, the setShieldHp
   *  overheal clamp. */
  const floorShield = (min = 85): void => {
    const p = api.player();
    if (p.alive && p.shieldHp < min) api.setShieldHp(min);
  };
  const nearestEnemy = (
    from: Vec,
    maxD: number,
    exclude?: (e: Readonly<EnemyState>) => boolean,
  ): Readonly<EnemyState> | null => {
    let best: Readonly<EnemyState> | null = null;
    let bestD = maxD;
    for (const e of api.enemies()) {
      if (exclude?.(e)) continue;
      const d = Math.hypot(e.x - from.x, e.y - from.y);
      if (d < bestD) {
        bestD = d;
        best = e;
      }
    }
    return best;
  };
  /** Aim at the nearest hostile inside `range` and hold the trigger; coast on
   *  `fallback` when the field in front is clear. The staple combat loop. */
  const engage = (range: number, thrust: number, fallback: number): void => {
    const p = api.player();
    const e = nearestEnemy(p, range);
    steer(e ? angleTo(p, e) : fallback, thrust);
    staging.fire = e !== null;
  };
  /** Ring of enemies around a center, aimed at a target — the staple crowd. */
  const spawnRing = (
    rnd: () => number,
    kinds: readonly EnemyKind[],
    count: number,
    center: Vec,
    rMin: number,
    rMax: number,
    aimAt: Vec,
    arc?: { from: number; to: number },
  ): void => {
    for (let i = 0; i < count; i++) {
      const span = arc ? arc.to - arc.from : TAU;
      const base = arc ? arc.from : 0;
      const ang = base + (span * (i + 0.5)) / count + (rnd() - 0.5) * (span / count) * 0.8;
      const r = rMin + rnd() * (rMax - rMin);
      const kind = kinds[i % kinds.length] ?? "drone";
      api.spawnEnemy(kind, center.x + Math.cos(ang) * r, center.y + Math.sin(ang) * r, aimAt);
    }
  };
  /** Ellipse variant: 16:9 frames are 1.78× wider than tall, so a circular
   *  staging ring sized to fit vertically wastes the sides and one sized to
   *  fill the sides clips top and bottom. Everything composed to fill a frame
   *  uses this. */
  const spawnOval = (
    rnd: () => number,
    kinds: readonly EnemyKind[],
    count: number,
    center: Vec,
    rx: number,
    ry: number,
    aimAt: Vec,
  ): void => {
    for (let i = 0; i < count; i++) {
      const ang = (TAU * (i + 0.5)) / count + (rnd() - 0.5) * (TAU / count) * 0.8;
      const k = 0.72 + rnd() * 0.28;
      const kind = kinds[i % kinds.length] ?? "drone";
      api.spawnEnemy(
        kind,
        center.x + Math.cos(ang) * rx * k,
        center.y + Math.sin(ang) * ry * k,
        aimAt,
      );
    }
  };
  /** The shot's own half-frame in world px. Every composition measurement below
   *  is expressed in these units so it survives the per-shot zoom. */
  const halfFrame = (): { hw: number; hh: number } => ({ hw: 800 / cam.zoom, hh: 450 / cam.zoom });

  /** A circle the rock field must not land in — the pilot's working area, a
   *  firing lane, a crowd the shot is composed around. */
  type Keepout = { x: number; y: number; r: number };

  /** Half-frame coordinates: (0,0) is the frame centre, (±1,±1) the corners,
   *  anything past 1 is cropped by the frame edge. */
  type UV = { u: number; v: number };

  /**
   * Where a field puts its rocks.
   *
   * WHY this is a union and not the annulus it replaces: one layout across
   * nineteen shots produced nineteen wreaths-with-a-hole. The hole is not a
   * defect in any single frame — the corridor keep-outs carve it and the fight
   * belongs in it — but 55 seconds of the same silhouette reads as one repeated
   * wallpaper, and the fix for that is composition, not more rock. The density
   * target is already met; what each shot needs is its OWN picture.
   *
   * Angles and offsets are in half-frames, i.e. the frame is treated as a unit
   * SQUARE. Because the real half-frame is 1.78× wider than tall, a `band` at
   * 45° draws as the ~29° shallow diagonal a drift lane wants rather than a
   * 45° one — which is the useful behaviour, so the space is left un-corrected.
   */
  type RockLayout =
    /** A wedge of an annulus: dress one side, one corner, a horizon, or simply
     *  the arc the action is not in. `from`/`to` are frame-space radians, 0 =
     *  frame right, +y down (so π/2 is the bottom of frame). Spanning a full
     *  TAU gives back the ring the reel used to be made of — deliberately not
     *  a named case, because reaching for it should feel like a choice. */
    | { kind: "arc"; from: number; to: number; inner?: number; outer?: number }
    /** A drift lane crossing the frame. No centre hole and no symmetry: the
     *  ship reads as flying THROUGH a field rather than sitting inside one. */
    | { kind: "band"; angle: number; halfWidth?: number; length?: number; offset?: number }
    /** One knot at (cx, cy) and nothing else — the rest of the frame stays
     *  black on purpose, so the dressed shots either side of it land harder. */
    | { kind: "clump"; cx: number; cy: number; spread: number };

  type RockField = {
    /** Frame centre the field is composed around — the shot's camera target
     *  AT THE MOMENT IT IS SAMPLED, which for a shot whose frame travels is not
     *  its setup anchor. Two shots measured several points emptier because the
     *  field was composed on the opening frame and had walked off the closing
     *  one. */
    at: Vec;
    /** Required, with no default: every shot has to state its own picture. */
    layout: RockLayout;
    count?: number;
    rMin?: number;
    rMax?: number;
    keepOut?: ReadonlyArray<Keepout>;
  };

  /** World px² of covered frame per rock. Count is a DENSITY, never a number:
   *  a shot at zoom 1.05 shows four times the world area of one at 2.0, so a
   *  fixed count reads as a belt in one and as four stray pebbles in the other.
   *
   *  Tuned against the emptiness measurement, not by eye. The layouts below
   *  cover LESS of the frame than the ring they replaced — that is the point —
   *  so at the ring's old figure the reel measured 3.7pp emptier even though
   *  every shot read better. Packing the area a layout does cover is the way to
   *  pay that back without putting the wreath back. */
  const ROCK_AREA = 4300;

  /** Ceiling on one field. ASTEROID_CAP_MAX (110) is what the arena itself will
   *  hold, so even the widest shot stays inside what the game does on its own.*/
  const ROCK_COUNT_MAX = 96;

  /** Rocks that land outside the play bounds are culled by the host on the
   *  first sim step, and the display sweep bursts anything whose state
   *  vanished — a shot framed near the energy barrier would otherwise open on a
   *  row of unexplained shatters. Stay inside, with margin. */
  const inPlayBounds = (x: number, y: number, r: number): boolean => {
    const { w, h } = api.worldSize();
    return x > r + 40 && y > r + 40 && x < w - r - 40 && y < h - r - 40;
  };

  /**
   * Set dressing: the arena's own rocks, composed into the shot.
   *
   * WHY (the defect this fixes): the arena seeds ASTEROID_SEED_COUNT = 7 rocks
   * across 3840×2160, so a frame the director composed anywhere else contains
   * one only by luck. Measured across the whole reel, 98.2% of every still sat
   * within ±10 luma of the background — an order of magnitude emptier than any
   * other game's trailer, because the art is thin unfilled vector outlines and
   * nothing in the frame has SIZE. Rocks are the one body in this game's
   * vocabulary that does: at ASTEROID_MAX_RADIUS = 80 each draws ~500 world px
   * of outline, twenty times a drone's silhouette.
   *
   * This is dressing, not a prop: the same asteroids the arena spawns, through
   * the same factory, with the same collision, chip and burst behaviour — a
   * blast that reaches one shatters it on camera.
   */
  const dressRocks = (rnd: () => number, f: RockField): void => {
    const { hw, hh } = halfFrame();
    const layout = f.layout;
    // Each layout yields its own candidate sampler plus the area it covers in
    // half-frame² — the count follows from that area, so a wedge does not come
    // out as crowded as a full sweep and a clump does not come out as thin as a
    // band. The field has to reach INSIDE the frame whatever the shape: rock
    // parked out at 0.7-1.2 half-frames measured almost nothing, because at
    // those radii most of it is behind the letterbox.
    const plan = ((): { coverage: number; sample: (i: number, count: number) => UV } => {
      switch (layout.kind) {
        case "arc": {
          const inner = layout.inner ?? 0.3;
          const outer = layout.outer ?? 1.04;
          const span = layout.to - layout.from;
          return {
            coverage: Math.PI * (outer * outer - inner * inner) * (span / TAU),
            sample: (i, count) => {
              const ang =
                layout.from + (span * (i + 0.5)) / count + (rnd() - 0.5) * (span / count) * 1.5;
              const k = inner + rnd() * (outer - inner);
              return { u: Math.cos(ang) * k, v: Math.sin(ang) * k };
            },
          };
        }
        case "band": {
          const halfWidth = layout.halfWidth ?? 0.42;
          const length = layout.length ?? 1.5;
          const offset = layout.offset ?? 0;
          const ca = Math.cos(layout.angle);
          const sa = Math.sin(layout.angle);
          return {
            coverage: 4 * length * halfWidth,
            sample: (i, count) => {
              const step = (2 * length) / count;
              const s = -length + step * (i + 0.5) + (rnd() - 0.5) * step * 1.5;
              const lat = offset + (rnd() - 0.5) * 2 * halfWidth;
              return { u: ca * s - sa * lat, v: sa * s + ca * lat };
            },
          };
        }
        case "clump": {
          const { cx, cy, spread } = layout;
          return {
            coverage: Math.PI * spread * spread,
            // sqrt keeps the disc evenly filled instead of piling on its centre.
            sample: () => {
              const r = spread * Math.sqrt(rnd());
              const a = rnd() * TAU;
              return { u: cx + Math.cos(a) * r, v: cy + Math.sin(a) * r };
            },
          };
        }
      }
    })();
    const count =
      f.count ?? Math.min(ROCK_COUNT_MAX, Math.round((plan.coverage * hw * hh) / ROCK_AREA));
    // Perimeter — the only thing a rock contributes to a frame — is linear in
    // radius, so the field is biased to the large end of what the arena itself
    // spawns (ASTEROID_MAX_RADIUS = 80). Shots override this HARD in both
    // directions: twenty medium rocks and three near-max ones are different
    // pictures, and the reel needs both.
    const rMin = f.rMin ?? 50;
    const rMax = f.rMax ?? 80;
    const zones = f.keepOut ?? [];
    for (let i = 0; i < count; i++) {
      // Four tries per slot: a rejected candidate re-rolls inside the same slot
      // rather than leaving a hole in the field.
      for (let attempt = 0; attempt < 4; attempt++) {
        const { u, v } = plan.sample(i, count);
        const radius = rMin + rnd() * (rMax - rMin);
        const x = f.at.x + u * hw;
        const y = f.at.y + v * hh;
        if (!inPlayBounds(x, y, radius)) continue;
        if (zones.some((z) => Math.hypot(z.x - x, z.y - y) < z.r + radius)) continue;
        api.spawnAsteroid(x, y, radius);
        break;
      }
    }
  };

  /**
   * A cropped foreground MASS, placed at (u, v) half-frames from `at`.
   *
   * spawnAsteroid clamps to ASTEROID_MAX_RADIUS (80), so the largest single
   * body this game can put on screen is 160 world px across — at zoom 1.05 that
   * is a ninth of the frame height, i.e. another pebble in a field of pebbles.
   * Packing 5-7 near-max rocks inside a `spread` SMALLER than their own radii
   * fuses their outlines into one silhouette 300-400px wide, which at every
   * zoom in the reel is a foreground object.
   *
   * They stay ordinary asteroids — real collision, real chip, and a blast that
   * reaches the mass shatters it a rock at a time. This is composition, not a
   * prop.
   *
   * Placed at |u| or |v| ≥ 1 the frame CROPS it, which is the point: on a flat
   * 2D field a cropped body is the only depth cue there is, and it is what
   * tells the eye the belt is a volume the ship is inside rather than a decal
   * ringing it. Rocks draw under every combatant (depth 5 vs 9/10), so "in
   * front" here means large-and-cut-off, not occluding.
   */
  const boulder = (
    rnd: () => number,
    at: Vec,
    u: number,
    v: number,
    opts: { count?: number; spread?: number; rMin?: number; rMax?: number } = {},
  ): void => {
    const { hw, hh } = halfFrame();
    const count = opts.count ?? 6;
    const spread = opts.spread ?? 78;
    const rMin = opts.rMin ?? 62;
    const rMax = opts.rMax ?? 80;
    const cx = at.x + u * hw;
    const cy = at.y + v * hh;
    for (let i = 0; i < count; i++) {
      // Golden-angle walk out from the centre: the lumps interlock instead of
      // stacking on one side, so the fused outline stays a blob.
      const ang = i * 2.399963 + rnd() * 0.6;
      const r = spread * Math.sqrt((i + 0.35) / count);
      const radius = rMin + rnd() * (rMax - rMin);
      const x = cx + Math.cos(ang) * r;
      const y = cy + Math.sin(ang) * r;
      if (!inPlayBounds(x, y, radius)) continue;
      api.spawnAsteroid(x, y, radius);
    }
  };

  /** Keep-out circles laid along the run the pilot is scripted to make. Rocks
   *  are solid — one parked in the lane bounces the ship off its mark, and
   *  `deathless` protects the hull but not the choreography.
   *
   *  The radius is deliberately small: dressRocks adds the ROCK's radius on
   *  top, and hull contact only triggers when the ship's centre is inside the
   *  rock, so 60 already leaves 60px of clearance at the closest approach. The
   *  first cut used 120-175 and, once the rock radius was added, excluded a
   *  240px band — wider than the half-height of every shot above zoom 1.6, so
   *  the belt was pushed off frame entirely and measured nothing. */
  const corridor = (from: Vec, to: Vec, r = 60, steps = 5): Keepout[] => {
    const zones: Keepout[] = [];
    for (let i = 0; i <= steps; i++) {
      const f = i / steps;
      zones.push({ x: from.x + (to.x - from.x) * f, y: from.y + (to.y - from.y) * f, r });
    }
    return zones;
  };

  const spawnShardRing = (rnd: () => number, center: Vec, count: number, rMax: number): void => {
    for (let i = 0; i < count; i++) {
      const ang = (TAU * (i + 0.5)) / count + (rnd() - 0.5) * 0.5;
      const r = rMax * (0.7 + 0.3 * rnd());
      api.spawnShards(1, center.x + Math.cos(ang) * r, center.y + Math.sin(ang) * r * 0.62);
    }
  };

  // ---- fake-peer crew ---------------------------------------------------------------
  const addPeer = (
    id: string,
    colorIdx: number,
    post: Vec,
    opts: {
      orbitR: number;
      angVel: number;
      phase0: number;
      baseAim: number;
      level: number;
      score: number;
      shotGapMs?: number;
      mod?: ShieldModKind;
    },
  ): FakePeer => {
    const state: Record<string, unknown> = {
      x: post.x,
      y: post.y,
      angle: opts.baseAim,
      vx: 0,
      vy: 0,
      alive: true,
      present: true,
      level: opts.level,
      shieldHp: 100,
      sectorScore: opts.score,
      weaponName: "BEAM",
      beams: [],
    };
    if (opts.mod) {
      // Serialized exactly as a real client would: the victim reads kind+active
      // and runs its own RAM / TESLA adjudication off it.
      state["shieldMod"] = {
        kind: opts.mod,
        until: Date.now() + 20_000,
        active: true,
        phased: false,
      };
    }
    const player: Player = {
      id,
      color: PEER_COLORS[colorIdx % PEER_COLORS.length] ?? "#7ae0ff",
      state,
    };
    const peer: FakePeer = {
      player,
      state,
      post,
      postTarget: null,
      postSpeed: 0,
      orbitR: opts.orbitR,
      angVel: opts.angVel,
      phase0: opts.phase0,
      baseAim: opts.baseAim,
      shotGapMs: opts.shotGapMs ?? 240,
      tint: PEER_TINTS[colorIdx % PEER_TINTS.length] ?? 0x7ae0ff,
      // Infinity = a peer that never fires (the RAM raider: its hull is the
      // weapon). The opening stagger has to honour that too, or the first
      // bolt is already in the air before shotGapMs is ever consulted.
      nextShotAt: opts.shotGapMs === Infinity ? Infinity : 200 + colorIdx * 90,
      bolts: [],
      x: post.x,
      y: post.y,
      angle: opts.baseAim,
    };
    crew.push(peer);
    if (peerMap) peerMap[id] = player;
    return peer;
  };
  const installPeers = (): void => {
    peerMap = { solo: { id: "solo" } };
    staging.peers = peerMap;
  };
  const clearPeers = (): void => {
    crew = [];
    peerMap = null;
    staging.peers = null;
  };
  /** Per-frame crew choreography: glide the post, orbit it, face (and in
   *  combat/duel, shoot) the target. Against enemies the bolts land REAL
   *  damage on contact; against the player they are published beams only —
   *  detectIncomingDamage does the drain, the impact arcs and the i-frames. */
  const updateCrew = (t: number, dt: number, mode: CrewMode): void => {
    const dts = dt / 1000;
    const me = api.player();
    for (const b of crew) {
      // Glide velocity has to reach the wire: syncShips lights a remote's
      // thruster trail off hypot(vx,vy) > 100, and the orbit term alone is
      // ~11 px/s, so a peer crossing the frame at 240 px/s used to publish
      // itself as parked and drew no trail at all.
      let postVX = 0;
      let postVY = 0;
      if (b.postTarget) {
        const dx = b.postTarget.x - b.post.x;
        const dy = b.postTarget.y - b.post.y;
        const d = Math.hypot(dx, dy);
        const step = b.postSpeed * dts;
        if (d <= step) {
          b.post = { x: b.postTarget.x, y: b.postTarget.y };
        } else {
          b.post = { x: b.post.x + (dx / d) * step, y: b.post.y + (dy / d) * step };
          postVX = (dx / d) * b.postSpeed;
          postVY = (dy / d) * b.postSpeed;
        }
      }
      const phase = b.phase0 + (b.angVel * t) / 1000;
      b.x = b.post.x + Math.cos(phase) * b.orbitR;
      b.y = b.post.y + Math.sin(phase) * b.orbitR;
      const vx = -Math.sin(phase) * b.orbitR * b.angVel + postVX;
      const vy = Math.cos(phase) * b.orbitR * b.angVel + postVY;
      const target: Vec | null =
        mode === "duel"
          ? me.alive
            ? { x: me.x, y: me.y }
            : null
          : mode === "combat"
            ? nearestEnemy(b, 760)
            : null;
      b.angle = target ? angleTo(b, target) : b.baseAim;
      if (target && t >= b.nextShotAt) {
        b.nextShotAt = t + b.shotGapMs + (b.nextShotAt % 7) * 23; // deterministic stagger
        const nose = { x: b.x + Math.cos(b.angle) * 10, y: b.y + Math.sin(b.angle) * 10 };
        b.bolts.push({
          x: nose.x,
          y: nose.y,
          vx: Math.cos(b.angle) * BOLT_SPEED,
          vy: Math.sin(b.angle) * BOLT_SPEED,
          traveled: 0,
        });
      }
      const kept: Bolt[] = [];
      for (const bolt of b.bolts) {
        bolt.x += bolt.vx * dts;
        bolt.y += bolt.vy * dts;
        bolt.traveled += BOLT_SPEED * dts;
        if (bolt.traveled > BOLT_RANGE) continue;
        let hit = false;
        if (mode !== "duel") {
          for (const e of api.enemies()) {
            const rad = ENEMY_SPECS[e.kind].hitRadius + 8;
            if (Math.hypot(e.x - bolt.x, e.y - bolt.y) <= rad) {
              api.damageEnemy(e.id, BOLT_DAMAGE);
              hit = true;
              break;
            }
          }
        }
        if (!hit) kept.push(bolt);
      }
      b.bolts = kept;
      // Publish this frame's pose + bolts through the real wire schema.
      const power = mode === "duel" ? DUEL_BOLT_POWER : 0.25;
      const beams: SerializedBeam[] = b.bolts.map((bolt) => {
        const inv = 1 / BOLT_SPEED;
        return {
          hx: bolt.x,
          hy: bolt.y,
          tx: bolt.x - bolt.vx * inv * 14,
          ty: bolt.y - bolt.vy * inv * 14,
          tint: b.tint,
          width: 1,
          exploding: false,
          explosionRadius: 0,
          power,
        };
      });
      b.state["x"] = b.x;
      b.state["y"] = b.y;
      b.state["angle"] = b.angle;
      b.state["vx"] = vx;
      b.state["vy"] = vy;
      b.state["beams"] = beams;
    }
  };

  /** Common scene opener: baseline HUD, wipe the world, unlock the camera,
   *  and re-arm the no-unscripted-death guarantee (only the death beat clears
   *  it, and it must not leak into the shot after). */
  const stage = (): void => {
    hudBaseline();
    api.clearWorld();
    // Every shot composes its own rock field against its own frame, so the
    // previous one's must go — clearWorld() spares asteroids on purpose.
    api.clearAsteroids();
    // Peers are wiped on the way IN, not only on the way out: the reel's last
    // shot deliberately leaves its crew installed so the closing dip fades on
    // a full frame, and a ?loop=1 replay has to start clean regardless.
    clearPeers();
    staging.camPos = null;
    staging.steer = null;
    staging.fire = false;
    staging.deathless = true;
  };
  const sceneReset = (): void => {
    staging.steer = null;
    staging.fire = false;
    staging.camPos = null;
    clearPeers();
  };

  // ==== the reel ======================================================================

  // -- 1. supernova-open — COLD OPEN. The most legible single spectacle in the
  // arsenal leads: a 500ms nose charge, then the 360px solar ring deletes a
  // 26-body ring that is staged INSIDE the blast (the old cut detonated into
  // empty space). Combo pill on — 26 simultaneous kills drive it to ×5.
  /** Trigger held down to here so the 500ms windup completes at ~1150ms.
   *  The ring grows at 1100 px/s and is therefore over 330ms after it starts,
   *  so WHEN it fires decides whether the shot's middle is the blast or the
   *  blast's aftermath. Held from t=0 it landed at 520ms of 2300 and the whole
   *  second half of the opener was a debris puff at centre with the rest of
   *  the frame scattered pickups — measured, the emptiest kind of frame in the
   *  reel. The opener has to be the loudest. */
  const SUPERNOVA_HOLD = 650;
  /** Reinforcement cue: the ring caps at 360px and expires ~1510, so this is
   *  the last moment a wave can arrive OUTSIDE it and still be flashing in
   *  while the ring is on screen. */
  const SUPERNOVA_REFILL = 1400;
  let s1Reinforced = false;
  const supernovaOpen: TrailerScene = {
    id: "supernova-open",
    duration: 2300,
    setup: () => {
      stage();
      s1Reinforced = false;
      // 1.5 → 1.35 (half-frame ≈ 593 × 333). The rock belt has to sit outside
      // the blast's 360px reach or the ring deletes its own set dressing, and
      // at 1.5 the half-HEIGHT was only 300 — every slot above and below the
      // pilot was inside the blast, so the field could only form two vertical
      // bands down the sides. 333 opens the corners.
      cam.setZoom(1.35);
      show(hud.root, true);
      show(hud.left, false);
      show(hud.right, false);
      show(hud.combo, true);
      const a = anchor(-100, 0);
      const rnd = mulberry(5);
      api.setLevel(3);
      api.setPlayerPose({ x: a.x, y: a.y, angle: -Math.PI / 2, vx: 0, vy: 0 });
      api.grantWeapon("SUPERNOVA");
      // Every body inside explosion.range (360) so the ring lands ON the crowd.
      spawnOval(rnd, ["drone", "drone", "wasp"], 26, a, 290, 250, a);
      spawnOval(rnd, ["drone", "wasp"], 14, a, 180, 155, a);
      // Survivors: DRONES only, in two side arcs at 560-760px. The 360px reach
      // is not the whole story — the crowd closes during the 1.2s charge, and a
      // wasp covers 283px of that. Measured on the previous cut, a mixed wave
      // staged at 390-520 was inside the blast by the time it landed and 62 of
      // 62 bodies died: the shot's entire second half was a debris puff at
      // centre with scattered pickups around it, which is exactly the frame
      // this pass exists to kill. Drones close at 70 px/s, so these are still
      // outside when the ring goes off and are marching in through it.
      for (const face of [0, Math.PI]) {
        spawnRing(rnd, ["drone"], 11, a, 560, 760, a, {
          from: face - 1.0,
          to: face + 1.0,
        });
      }
      // Rocks just OUTSIDE the blast's reach: the ring expands into something,
      // and once the crowd is gone the aftermath frame still has bodies with
      // real size in it. Banked down ONE side rather than ringed — a lopsided
      // frame with a cropped mass on the far edge reads as a place; a ring
      // reads as a target, which is the one thing this shot already has.
      dressRocks(rnd, {
        at: a,
        layout: { kind: "arc", from: -1.2, to: 1.2, inner: 0.58, outer: 1.4 },
        count: 76,
        rMin: 50,
        keepOut: [{ x: a.x, y: a.y, r: 375 }],
      });
      boulder(rnd, a, -0.98, 0.45, { count: 9, spread: 96 });
    },
    run: (t) => {
      steer(-Math.PI / 2 + t * 0.0002, 0.02); // slow pivot; nose glow readable
      staging.fire = t >= SUPERNOVA_HOLD; // real windup → blast at ~1180ms
      // Reinforcements warp in on the blast's tail (real spawn path, so they
      // arrive on the game's own grace-flash). A 360px ring that clears the
      // screen is only a power fantasy if the screen fills again: without this
      // the shot cannot help ending on the field the ring just emptied, and
      // WHERE the sampled frame lands in that 330ms of ring stops mattering.
      if (!s1Reinforced && t >= SUPERNOVA_REFILL) {
        s1Reinforced = true;
        const p = api.player();
        // Side arcs at 380-520: past the ring's 360px cap (so the blast cannot
        // eat its own reinforcements) and inside the 533 × 300 half-frame,
        // which the top and bottom of a full oval are not.
        const rr = mulberry(55);
        for (const face of [0, Math.PI]) {
          spawnRing(rr, ["drone", "wasp", "drone"], 13, p, 380, 520, p, {
            from: face - 1.1,
            to: face + 1.1,
          });
        }
      }
      floorShield(130);
    },
    teardown: sceneReset,
  };

  // -- 2. calm-open — the baseline breath after the bang: Lv1 bare dart, the
  // 1-pellet white BEAM, a ten-body picket. THE PORTRAIT SHOT: this is the one
  // frame in the reel whose only job is "here is the thing you fly", so it is
  // now the tightest in the reel at 2.5.
  //
  // 1.7 → 2.5 by the boss-kill recipe, i.e. BOTH halves: the zoom goes up ×1.47
  // and every staged offset, spawn box and camera lead is divided by 1.47. The
  // half-frame shrinks from 470 × 265 to 320 × 180 world px, so the identical
  // bodies sit in the identical places in the FRAME and each draws 47% bigger.
  // Raising the zoom alone (which an earlier pass did) just walks the picket off
  // the edges and changes nothing about the subject's size on screen.
  /** calm-open re-feeds its picket here. See the run() note on dead space. */
  const CALM_REFILL = 820;
  let s2Refilled = false;
  const calmOpen: TrailerScene = {
    id: "calm-open",
    duration: 2000,
    setup: () => {
      stage();
      s2Refilled = false;
      cam.setZoom(2.5); // half-frame ≈ 320 × 180
      const a = anchor(-800, -200);
      const rnd = mulberry(1);
      api.setLevel(1);
      api.setPlayerPose({ x: a.x, y: a.y, angle: 0, vx: 250, vy: 0 });
      // A picket ahead-right, sized to the 2.5 frame: the whole fight is on
      // screen and the ship is already flying into it. The box is the old one
      // divided by 1.47 — same picket, same place in frame, 47% bigger drones.
      // 20 → 26 → 32, and the box is stretched to the frame's full right half
      // (96 → 326, i.e. out to +0.93 half-frames of the new lead): the pilot's
      // beam sweeps a box this narrow clean, and the old one both emptied AND
      // sat entirely inside the middle third.
      for (let i = 0; i < 32; i++) {
        api.spawnEnemy("drone", a.x + 96 + rnd() * 230, a.y - 102 + rnd() * 204, a);
      }
      api.spawnEnemy("drone", a.x + 170, a.y - 133, a);
      api.spawnEnemy("drone", a.x + 204, a.y + 126, a);
      api.spawnEnemy("wasp", a.x + 139, a.y + 71, a);
      api.spawnEnemy("wasp", a.x + 218, a.y - 61, a);
      api.spawnEnemy("wasp", a.x + 282, a.y + 27, a);
      api.spawnEnemy("wasp", a.x + 302, a.y - 82, a);
      // One of the reel's deliberately sparse frames — the dressed shots stop
      // landing if every shot is dressed. All it carries is a floor: a shallow
      // drift lane across the bottom third and a single mass out ahead that the
      // ship flies toward. The whole middle and top stay black for the picket.
      //
      // Rock radii step DOWN with the zoom, the same way boss-kill's floor does:
      // a rock draws bigger as the frame tightens, and the one thing this shot
      // must not do is let its floor out-read the 40px hull it exists to show.
      // rMin stays above 25, the radius a Lv1 BEAM (power .25) destroys outright
      // — a burst rock rolls an item that would rewrite the bare Lv1 loadout.
      const frame = { x: a.x + 204, y: a.y - 20 };
      dressRocks(rnd, {
        at: frame,
        layout: { kind: "band", angle: 0.18, offset: 0.76, halfWidth: 0.42, length: 1.85 },
        rMin: 33,
        rMax: 52,
        keepOut: corridor(a, { x: a.x + 435, y: a.y }),
      });
      boulder(rnd, frame, 0.85, -0.8, { count: 6, spread: 60, rMin: 34, rMax: 48 });
    },
    run: (t) => {
      const p = api.player();
      // Lead space: ship a touch left of centre, the picket filling the right.
      // 116 → 70 → 28. The lead is the one measurement that does NOT survive
      // dividing by the zoom ratio: it is empty frame by definition, and at 2.5
      // even 70px is 175 screen px of black bought at the cost of pushing the
      // whole fight into the left third — which is exactly how the last cut
      // read. 28 sits the hull one twelfth of a half-frame off centre, which is
      // all the lead a 320px half-frame can pay for.
      staging.camPos = { x: p.x + 28, y: p.y - 20 };
      // The picket is CONSUMED, and it converges on the hull while it dies, so
      // the right of frame empties twice over — once by attrition and once
      // because the survivors walk inward. A second file staged on the pilot's
      // own position mid-shot puts bodies back at the right edge for the whole
      // back half, through the same spawn path as the first.
      if (!s2Refilled && t >= CALM_REFILL) {
        s2Refilled = true;
        const rr = mulberry(13);
        for (let i = 0; i < 14; i++) {
          api.spawnEnemy("drone", p.x + 130 + rr() * 210, p.y - 150 + rr() * 300, p);
        }
        for (let i = 0; i < 4; i++) {
          api.spawnEnemy("wasp", p.x + 190 + rr() * 150, p.y - 120 + rr() * 240, p);
        }
      }
      engage(610, 0.34, 0);
      // Clearing this picket earns ~95 XP against a 70 threshold — measured,
      // the old cut hit LV2 at 1.25s and LV3 on the last frame. Both fire the
      // level-up ring, which is scene 4's named beat, and both break this
      // shot's own promise of the Lv1 dart. No XP bar is on screen here, so
      // holding it is invisible; the level-ups were not.
      api.setXp(0);
      floorShield();
    },
    teardown: sceneReset,
  };

  // -- 3. pickup — the loop the whole economy runs on, which the old cut never
  // showed: a crystal on the deck, the ship crosses it, the real 14-spark burst
  // + chirp fire, the HUD weapon line flips BEAM → LASER with a full 20s bar,
  // and the payoff is immediate — a 220px cyan pierce skewering a drone file.
  let s3 = { crystal: { x: 0, y: 0 }, picked: false };
  const pickup: TrailerScene = {
    id: "pickup",
    duration: 3000,
    setup: () => {
      stage();
      // 1.3 → 1.6, staging divided by 1.23: same frame, 23% bigger crystal,
      // hull and drone file (the crystal is the smallest named subject in the
      // reel and at 1.3 it was a ~12px glyph).
      cam.setZoom(1.6); // half-frame ≈ 500 × 281
      show(hud.root, true);
      show(hud.right, false); // "solo · offline" line stays out of frame
      const a = anchor(-200, -640);
      api.setLevel(1);
      api.setPlayerPose({ x: a.x, y: a.y, angle: 0, vx: 200, vy: 0 });
      s3 = { crystal: { x: a.x + 142, y: a.y - 4 }, picked: false };
      api.spawnItem("weapon", "LASER", s3.crystal.x, s3.crystal.y);
      // The payoff: a file receding to frame-right, close to collinear so one
      // pierce lance takes three of them.
      for (let i = 0; i < 8; i++) {
        api.spawnEnemy("drone", a.x + 268 + i * 34, a.y - 49 + i * 14, a);
      }
      // A second file offset below it — the lance skewers one and the frame
      // still reads as a formation rather than a line of dots.
      for (let i = 0; i < 7; i++) {
        api.spawnEnemy("drone", a.x + 300 + i * 34, a.y + 78 + i * 12, a);
      }
      api.spawnEnemy("drone", a.x + 325, a.y + 122, a);
      api.spawnEnemy("drone", a.x + 382, a.y - 130, a);
      api.spawnEnemy("wasp", a.x + 382, a.y - 203, a);
      api.spawnEnemy("wasp", a.x + 439, a.y + 179, a);
      api.spawnEnemy("wasp", a.x + 325, a.y + 215, a);
      api.spawnEnemy("wasp", a.x + 466, a.y - 66, a);
      // Hung from the TOP, with the bottom of frame left black. The shot before
      // this one is a bottom horizon and two consecutive frames with the same
      // silhouette is exactly the repetition this pass exists to kill, so this
      // one is its mirror: rock overhead, the crystal and the pierce lance in
      // clean black beneath it. The approach is 140px long — nothing solid may
      // sit on that line.
      //
      // The ceiling is FEW rocks and SMALL ones. Uncapped at rMin 44 it came out
      // as 69 near-max bodies whose outlines fused into a white tangle that was
      // the largest, brightest, highest-contrast thing in the frame — measured
      // on the contact sheet the eye lands on the rock before it finds the
      // crystal, which inverts what the shot is for. Dressing gives the frame a
      // top edge; it does not get to out-read the subject. rMin stays above 29:
      // LASER at Lv1 (power .3) destroys anything smaller in one hit, and the
      // drop that rolls would rewrite the loadout this shot exists to show.
      const frame = { x: a.x + 260, y: a.y - 20 };
      dressRocks(mulberry(31), {
        at: frame,
        layout: { kind: "arc", from: -2.85, to: -0.35, inner: 0.66, outer: 1.2 },
        count: 24,
        rMin: 32,
        rMax: 56,
        keepOut: corridor(a, { x: a.x + 560, y: a.y }, 90),
      });
      boulder(mulberry(32), frame, 0.82, 0.96, { count: 4, spread: 64, rMin: 38, rMax: 54 });
    },
    run: () => {
      const p = api.player();
      staging.camPos = { x: p.x + 122, y: p.y - 20 };
      // The gate is the LOADOUT, not the distance. Proximity said "picked" one
      // pixel outside ITEM_PICKUP_RADIUS (15, measured centre-to-centre with
      // no hull padding), the director handed over to engage(), and the shot
      // played its whole payoff with the Lv1 beam: measured, LASER never once
      // reached the HUD. Now the approach only ends when the weapon changes.
      if (!s3.picked) s3.picked = p.weapon === "LASER";
      if (!s3.picked) {
        steer(angleTo(p, s3.crystal), Math.min(0.9, dist(p, s3.crystal) / 120));
        staging.fire = false;
      } else {
        // Fodder drops are a weighted roll and this shot flies straight through
        // the file it is clearing, so a second crystal can land under the hull
        // and silently rewrite the loadout the shot exists to demonstrate
        // (measured on a capture: the HUD read PLASMA CONE from ~1.6s of 3.1s).
        // Re-assert the staged weapon through the real grant path.
        if (p.weapon !== "LASER") api.grantWeapon("LASER");
        engage(900, 0.16, 0);
      }
      // Eight drones with a pierce lance crosses the Lv1 threshold at ~2.4s —
      // same reason as calm-open: the level-up ring belongs to scene 4.
      api.setXp(0);
      floorShield();
    },
    teardown: sceneReset,
  };

  // -- 4. level-up — orbs vacuum in, threshold crossed ON CAMERA: tinted ring +
  // 16 converge motes + the live hull rebuild (swept wings, cockpit dot) + the
  // pitched cue. The crossing is CUED rather than raced (see LEVEL_CUE) so the
  // FX lands on the shot's last frames instead of expiring mid-shot.
  /** Fire the level-up at 84% of the shot. Its FX are short — the ring lives
   *  450ms, the converge motes 320ms — so a crossing driven by whichever orb
   *  happens to arrive first can, and did, expire entirely inside the gap
   *  between two sampled frames, leaving the shot's tail on an empty field.
   *  Cueing it here puts the ring, the motes and the LV2 hull ON the cut. */
  const LEVEL_CUE = 1680;
  /** Fresh orb ring every 300ms. Measured on a capture: a 14-orb ring staged at
   *  200px is stripped in under 400ms (MAGNET pulls shards at 320 px/s and
   *  accelerates them in), so three staggered rings still left only 4-5 orbs in
   *  any sampled frame. A drip on this cadence holds ~20 in flight. */
  const ORB_DRIP_MS = 300;
  const ORB_RING_R = 245; // just inside MAGNET_RANGE (260) — all of them come
  let s4Rings = 0;
  let s4Leveled = false;
  let s4Rnd = mulberry(22);
  const levelUp: TrailerScene = {
    id: "level-up",
    // 2000, not 2200: the beat is vacuum → pop, and the old tail spent 500ms
    // past the pop on a field the magnet had already emptied.
    duration: 2000,
    setup: () => {
      stage();
      s4Rings = 0;
      s4Leveled = false;
      s4Rnd = mulberry(22);
      // A portrait frame. The named beat is the HULL REBUILDING — swept wings,
      // cockpit dot — inside the 110px level-up ring, and at any wider zoom the
      // ship is a 30px dart and an XP orb is a 4px speck.
      cam.setZoom(2.0); // half-frame ≈ 400 × 225
      show(hud.root, true);
      show(hud.right, false);
      const a = anchor(600, 260);
      api.setLevel(1, 0);
      api.setPlayerPose({ x: a.x, y: a.y, angle: -Math.PI / 2, vx: 0, vy: -60 });
      api.grantBooster("magnet");
      spawnShardRing(mulberry(2), a, 22, ORB_RING_R);
      // Rocks carry this shot's whole background: a 400 × 225 world-px frame,
      // the pilot is not shooting, and the only other
      // things on screen are 4px orbs. So it gets the reel's biggest SINGLE
      // object rather than a belt — a mass cropped by the right edge that eats
      // a third of the frame — with a knot of small rocks low-left for scale
      // contrast and black everywhere else. At zoom 2 an 80px rock already
      // draws 320 screen px of outline; thirteen fused draw a cliff.
      boulder(mulberry(41), a, 0.92, -0.15, { count: 23, spread: 192 });
      boulder(mulberry(43), a, -0.28, 0.94, { count: 11, spread: 116 });
      dressRocks(mulberry(42), {
        at: a,
        layout: { kind: "clump", cx: -0.76, cy: 0.6, spread: 0.62 },
        rMin: 24,
        rMax: 60,
        keepOut: corridor(a, { x: a.x, y: a.y - 230 }, 70),
      });
    },
    run: (t) => {
      const wobble = 0.15 * Math.sin(t * 0.002);
      steer(-Math.PI / 2 + wobble, 0.12);
      staging.fire = false;
      // Keep the vacuum fed right up to the cue, so the level-up fires into a
      // field that is still streaming rather than one the magnet has emptied.
      const drip = Math.floor(t / ORB_DRIP_MS);
      if (drip > s4Rings && t < LEVEL_CUE) {
        s4Rings = drip;
        spawnShardRing(s4Rnd, api.player(), 18, ORB_RING_R);
      }
      // Hold the bar at zero while the vacuum runs (the XP bar is off screen
      // here, so holding it is invisible), then hand over exactly one level's
      // worth through the real gainXp path. The orbs still pay their pickup FX
      // and chirp; only WHEN the threshold falls is taken off the dice.
      if (t < LEVEL_CUE) {
        api.setXp(0);
      } else if (!s4Leveled) {
        s4Leveled = true;
        api.grantXp(xpToNext(1));
      }
      floorShield();
    },
    teardown: sceneReset,
  };

  // -- 5. chain-reactor — CATEGORY: hitscan chain. The cyan web forks 6 jumps
  // through a packed pack, re-jittered every frame. intervalMs 650 over 2.4s =
  // 3-4 visible casts (the old 1.5s shot caught barely one).
  //
  // 1.35 → 1.9 → 2.15, and this pass is the one that re-runs the k-divide
  // PROPERLY. The first tighten raised the zoom and shrank the pack but left
  // the lead and the lane where they were, and the result measured worse than
  // the frame it replaced: hull at u ≈ -0.13, pack at +0.26 → +0.63, the rock
  // lane stacked on the pack's far edge at +0.52, and therefore a left half and
  // an outer right sixth with nothing in either. Density is not the same thing
  // as coverage.
  //
  // So the shot is re-composed rather than re-zoomed. The pilot goes to the
  // frame's left third and the pack is pushed out to spend the middle and right
  // (still inside the 440px fire gate, which is the game's own reach and does
  // not divide), the drift lane moves BEHIND the pack where the web can still
  // fork into it, and the left edge — the pilot's own side — gets the cropped
  // mass instead of the top corner.
  /** Ship one third in from frame left: 0 − 156/372 half-frames. */
  const CHAIN_LEAD = 156;
  /** Fresh rank into the frame's right third. Even at 36 bodies a 650ms cast
   *  that forks six times strips the pack to loot by ~2s of 2.4s, and a web
   *  with nothing left to jump to is the one thing this shot cannot show. */
  const CHAIN_REFILL = 1150;
  let s5Refilled = false;
  const chainReactor: TrailerScene = {
    id: "chain-reactor",
    duration: 2400,
    setup: () => {
      stage();
      s5Refilled = false;
      cam.setZoom(2.15); // half-frame ≈ 372 × 209
      const a = anchor(-400, 250);
      const rnd = mulberry(3);
      api.setLevel(3);
      api.setPlayerPose({ x: a.x, y: a.y, angle: 0, vx: 0, vy: 0 });
      api.grantWeapon("CHAIN REACTOR");
      // Three ranks strung ACROSS the frame from +0.06 to +0.74 half-frames,
      // every one inside the 440px fire gate from frame one and packed tight
      // enough that the 320px hop range keeps forking instead of dead-ending.
      //
      // 18 → 30 → 36 bodies, and this is the one count no divide carries: a
      // pack that is tighter in WORLD px gets swept by every cast, and the shot
      // used to strip itself bare by 1.5s of 2.4s.
      for (let i = 0; i < 16; i++) {
        api.spawnEnemy("drone", a.x + 180 + rnd() * 100, a.y - 180 + rnd() * 360, a);
      }
      for (let i = 0; i < 8; i++) {
        api.spawnEnemy("wasp", a.x + 215 + rnd() * 90, a.y - 160 + rnd() * 320, a);
      }
      for (let i = 0; i < 12; i++) {
        api.spawnEnemy("drone", a.x + 300 + rnd() * 130, a.y - 150 + rnd() * 300, a);
      }
      // Rocks are legal arc targets (arcTargets includes asteroids), so this
      // field is structural rather than dressing: a near-vertical drift lane
      // standing BEHIND the pack gives the web something to fork INTO and
      // carries it further across the frame than drones alone can. Behind is
      // the operative word — parked on the pack it just competed with the web
      // for the same band of frame.
      //
      // Count and radii step down with the zoom, exactly as boss-kill's floor
      // does: the lane must stay behind the cyan web, not out-read it. rMin
      // stays above 29, the radius a CHAIN REACTOR arc (power .3) destroys
      // outright — a burst rock rolls an item that would rewrite the loadout.
      const frame = { x: a.x + CHAIN_LEAD, y: a.y - 18 };
      dressRocks(rnd, {
        at: frame,
        layout: { kind: "band", angle: Math.PI / 2, offset: -0.82, halfWidth: 0.2, length: 1.5 },
        count: 18,
        rMin: 30,
        rMax: 42,
        keepOut: corridor(a, { x: a.x + 430, y: a.y }, 60, 7),
      });
      // The pilot's own side. A mass cropped by the LEFT edge below the hull
      // closes the frame behind him — the side the web is travelling away from
      // is the side that had nothing in it at all.
      boulder(mulberry(33), frame, -1.02, 0.58, { count: 7, spread: 60, rMin: 32, rMax: 46 });
      boulder(mulberry(34), frame, -0.72, -0.94, { count: 5, spread: 48, rMin: 30, rMax: 42 });
    },
    run: (t) => {
      const p = api.player();
      staging.camPos = { x: p.x + CHAIN_LEAD, y: p.y - 18 };
      if (!s5Refilled && t >= CHAIN_REFILL) {
        s5Refilled = true;
        const rr = mulberry(35);
        for (let i = 0; i < 14; i++) {
          api.spawnEnemy("drone", p.x + 250 + rr() * 190, p.y - 190 + rr() * 380, p);
        }
        for (let i = 0; i < 5; i++) {
          api.spawnEnemy("wasp", p.x + 230 + rr() * 160, p.y - 150 + rr() * 300, p);
        }
      }
      const e = nearestEnemy(p, 900);
      if (e) steer(angleTo(p, e), 0.06);
      else steer(0, 0.1);
      // Arc is hitscan with a 460px cast range — hold fire until a target is
      // inside it so every trigger is a full web, never a fizzle.
      staging.fire = e !== null && dist(p, e) <= 440;
      floorShield();
    },
    teardown: sceneReset,
  };

  // -- 6. singularity — CATEGORY: gravity. The purple orb freezes mid-flight,
  // its event horizon shrinks, three arc shards spiral in, and rock AND hull are
  // physically dragged into one knot (hostApplyPulls drags asteroids too) before
  // the 90px pop wipes the pile. Camera locked on the knot, ship on the left.
  //
  // 1.2 → 1.9 by the k-divide recipe (zoom ×1.583) — it was the widest frame in
  // the reel outside the two shots that earn their width, and at 667 × 375 world
  // px of half-frame the hull drew ~19px and the whole collapse happened inside
  // a fifth of the picture.
  //
  // What does NOT divide here is the one thing the beat rides on: the orb
  // collapses at 216px TRAVELED and pulls over a 220px radius, both the game's
  // own numbers, so the knot's standoff from the ship is fixed and the camera
  // simply sits on the midpoint of the two. Everything staged AROUND that —
  // crowd ovals, the rocks the collapse is meant to eat, the drift lane, the
  // cropped mass — divides, so the same composition arrives 58% bigger.
  /** Second crowd, staged on the knot's RIGHT arc once the first collapse has
   *  eaten the first. The trigger is held down all shot, so the orb re-fires —
   *  without a refill the back half is an aftermath of loot with the frame's
   *  right third black, which is where the first collapse leaves it. */
  const SINGULARITY_REFILL = 1250;
  let s6 = { knot: { x: 0, y: 0 }, refilled: false };
  const singularity: TrailerScene = {
    id: "singularity",
    duration: 2400,
    setup: () => {
      stage();
      cam.setZoom(1.9); // half-frame ≈ 421 × 237
      const a = anchor(-100, 40);
      const rnd = mulberry(15);
      api.setLevel(3);
      api.setPlayerPose({ x: a.x, y: a.y, angle: 0, vx: 0, vy: 0 });
      api.grantWeapon("SINGULARITY");
      // The orb collapses at 216px traveled; the knot's leading edge sits right
      // there so the 220px pull radius swallows the whole cluster.
      const k = { x: a.x + 330, y: a.y - 20 };
      s6 = { knot: k, refilled: false };
      spawnOval(rnd, ["drone", "drone", "wasp"], 26, k, 105, 88, a);
      spawnOval(rnd, ["drone", "wasp"], 16, k, 175, 145, a);
      // Rocks inside the pull radius: the collapse drags stone and hull into the
      // same point, and chipped rocks burst into orb showers on the way in.
      // Radii step down with the zoom — at 1.9 a 52px rock already draws ~200
      // screen px, twice the crowd it is supposed to be dragged through.
      api.spawnAsteroid(k.x - 76, k.y - 60, 36);
      api.spawnAsteroid(k.x + 82, k.y + 44, 40);
      api.spawnAsteroid(k.x + 25, k.y + 88, 32);
      api.spawnAsteroid(k.x - 38, k.y + 104, 42);
      // A diagonal lane rather than a belt: the collapse then reads as a hole
      // torn in something that was drifting past, and the hole is LOCAL to the
      // knot instead of being the shape of the whole frame. Kept clear of the
      // 220px pull radius — rocks inside it get dragged in, and the four staged
      // above are the ones the collapse is supposed to eat.
      const frame = { x: k.x - 165, y: k.y + 10 };
      dressRocks(rnd, {
        at: frame,
        layout: { kind: "band", angle: -0.72, halfWidth: 0.58, length: 1.8 },
        rMin: 34,
        rMax: 52,
        keepOut: [{ x: k.x, y: k.y, r: 240 }, ...corridor(a, k, 44)],
      });
      boulder(mulberry(151), frame, -0.34, 1.02, { count: 6, spread: 53, rMin: 40, rMax: 56 });
      // Cropped by the RIGHT edge, 277px clear of the knot so the pull cannot
      // drag it in: the band runs lower-left to upper-right and the 240px
      // keep-out then carves everything the frame's right third had.
      boulder(mulberry(152), frame, 1.06, -0.32, { count: 7, spread: 62, rMin: 42, rMax: 58 });
      // Midpoint of ship and knot: the ship lands at −0.39 half-frames, the knot
      // at +0.39, and the 220px pull radius reaches to +0.92 — so the collapse
      // fills the right of frame instead of sitting in the middle of it.
      camLock.x = frame.x;
      camLock.y = frame.y;
      staging.camPos = camLock;
    },
    run: (t) => {
      const p = api.player();
      if (!s6.refilled && t >= SINGULARITY_REFILL) {
        s6.refilled = true;
        spawnRing(mulberry(153), ["drone", "wasp", "drone"], 16, s6.knot, 190, 280, s6.knot, {
          from: -1.0,
          to: 1.0,
        });
      }
      steer(angleTo(p, s6.knot), 0.04);
      staging.fire = true;
      // SINGULARITY is power 1.0 — it destroys ANY asteroid outright, so this
      // is the one shot where rock radii cannot be held above the one-shot
      // threshold. Every rock it eats rolls the 11% item chance, and a looted
      // weapon landing under the hull would silently replace the one the shot
      // is named for (the pickup and shield-mod shots re-assert for the same
      // reason). grantWeapon on the weapon already held is a no-op.
      if (p.weapon !== "SINGULARITY") api.grantWeapon("SINGULARITY");
      floorShield();
    },
    teardown: sceneReset,
  };

  // -- 7. railgun — CATEGORY: charged heavy shot. The windup glow swells on the
  // nose, then a 320px magenta lance skewers a column of drones with the real
  // 5px camera kick.
  //
  // THE FIRST OF THE REEL'S TWO UNDRESSED SHOTS. Measured on the last cut, the
  // eye landed on the pink enemy formation first, the bright white rock corner
  // second and the ship third — 2-3 seconds to find the subject. This hull is
  // a ~20px hairline outline and rock is the biggest, brightest body in the
  // game's vocabulary: it CANNOT lose to the ship, so on this shot it is simply
  // not staged. Black frame, one ship, one magenta lance, one drone column. A
  // plain frame where the mechanic reads beats a composed one where it does not.
  //
  // AND THE LANCE HAS TO BE IN IT. The other half of the same review: "the shot
  // named railgun never visibly shows a railgun". That is arithmetic, not luck —
  // at Lv3 the cycle is 965ms and the 2800 px/s bolt clears a 1.9-zoom frame in
  // ~290ms, so most of the shot is a 6px nose charge. Two fixes, both real
  // systems: OVERDRIVE (a loadout booster, not a director cheat) takes the cycle
  // to 643ms, and the ship is pinned to the lower-left corner firing up the
  // frame's own DIAGONAL — the longest line the frame has — which stretches the
  // lance's dwell to ~390ms. Together: a lance on screen ~60% of the shot, and
  // three of them across it instead of two.
  /** Firing lane: up-and-right at the 1.9 frame's diagonal, atan(237/421). */
  const RAILGUN_LANE = -0.51;
  const railgun: TrailerScene = {
    id: "railgun",
    duration: 2200,
    setup: () => {
      stage();
      cam.setZoom(1.9); // half-frame ≈ 421 × 237
      const a = anchor(300, 500);
      api.setLevel(3);
      api.setPlayerPose({ x: a.x, y: a.y, angle: RAILGUN_LANE, vx: 0, vy: 0 });
      api.grantWeapon("RAILGUN");
      api.grantBooster("overdrive");
      const cos = Math.cos(RAILGUN_LANE);
      const sin = Math.sin(RAILGUN_LANE);
      /** `d` px down the firing lane, `lat` px across it. */
      const lane = (d: number, lat: number): Vec => ({
        x: a.x + cos * d - sin * lat,
        y: a.y + sin * d + cos * lat,
      });
      // Three files strung ALONG the lane rather than across it: pierce takes a
      // whole column, so the kill reads as a line collapsing behind the lance
      // instead of one body clipped off the end of it. Every slot is inside the
      // 421 × 237 half-frame measured from the camera's lower-left hold below.
      for (let i = 0; i < 7; i++) {
        const q = lane(150 + i * 68, -34 + i * 6);
        api.spawnEnemy("drone", q.x, q.y, a);
      }
      for (let i = 0; i < 6; i++) {
        const q = lane(190 + i * 74, 74 + i * 9);
        api.spawnEnemy("drone", q.x, q.y, a);
      }
      for (let i = 0; i < 5; i++) {
        const q = lane(180 + i * 66, -105 - i * 4);
        api.spawnEnemy("drone", q.x, q.y, a);
      }
      // TWO wasps, down from four. Wasps answer with 3-bolt bursts and their
      // red is a neighbour of the lance's magenta — every extra one is confetti
      // in the subject's own hue.
      const w1 = lane(430, 215);
      const w2 = lane(520, -90);
      api.spawnEnemy("wasp", w1.x, w1.y, a);
      api.spawnEnemy("wasp", w2.x, w2.y, a);
    },
    run: () => {
      const p = api.player();
      // Hull pinned to the lower-left corner — (-0.70, +0.60) half-frames — so
      // the lane crosses the frame corner to corner.
      staging.camPos = { x: p.x + 295, y: p.y - 142 };
      // Fixed heading, NOT engage(): the lane is the composition, and a
      // nearest-target aim swings the nose — and the lance with it — off the
      // diagonal the moment the first file dies.
      steer(RAILGUN_LANE, 0.05);
      staging.fire = true; // hold: the windup only charges while held
      floorShield();
    },
    teardown: sceneReset,
  };

  // -- 8. deployables — CATEGORY: things that fight without you, the one verb
  // the old cut never showed. MINES: a diamond picket laid across the ship's
  // wake that the chase pack runs into. SENTRY: one trigger plants the turret,
  // the ship keeps drifting, and the turret keeps snapping bolts on its own.
  //
  // THE SECOND UNDRESSED SHOT, and the one the last review could not read at
  // all: "the deployables themselves are two ~10px diamond outlines; I could
  // not identify what mechanic this shot is showing", while "the floating rock
  // island upper-left is the single largest, brightest, highest-contrast object
  // in every frame; the ship is a grey smudge at 1/8th the ink of the island".
  //
  // Both halves of that are the same defect: at zoom 1.35 a mine is a 6px
  // blinking diamond, the turret a 9px tripod, and a 16-rock island is 300px of
  // fused white outline. So the island is gone and the frame is pulled to 1.9,
  // where a mine reads at ~23px, its 90px detonation ring sweeps three quarters
  // of the frame height, and the turret the ship abandons is unmistakably a
  // separate thing still shooting. Every staging radius below is the old one
  // divided by 1.4 — same composition, 40% more subject in it.
  let s8 = { sentry: false, turret: { x: 0, y: 0 }, wave: false };
  const deployables: TrailerScene = {
    id: "deployables",
    duration: 2600,
    setup: () => {
      stage();
      s8 = { sentry: false, turret: { x: 0, y: 0 }, wave: false };
      cam.setZoom(1.9); // half-frame ≈ 421 × 237
      const a = anchor(1000, 500);
      const rnd = mulberry(18);
      api.setLevel(3);
      api.setPlayerPose({ x: a.x, y: a.y, angle: 0, vx: 120, vy: 0 });
      api.grantWeapon("MINES");
      // Chase pack behind-left, close enough that the picket detonates ON
      // camera: wasps (240 px/s) run it down, drones string out behind them.
      // Drones only close at 70 px/s and MINE_TRIGGER_RADIUS is 60, so the
      // ring has to start inside ~180px or nothing reaches a mine in 2.6s.
      spawnRing(rnd, ["wasp"], 8, a, 86, 150, a, { from: Math.PI * 0.55, to: Math.PI * 1.45 });
      spawnRing(rnd, ["drone"], 12, a, 122, 214, a, { from: Math.PI * 0.5, to: Math.PI * 1.5 });
      // A pocket ahead for the turret to work once the ship has left it behind —
      // inside SENTRY_RANGE (480) of where the plant lands.
      spawnRing(rnd, ["drone", "wasp"], 7, a, 178, 257, a, { from: -0.9, to: 0.9 });
    },
    run: (t) => {
      const p = api.player();
      // 1300: MINES at Lv3 fires at 0 / 614 / 1228, so this lands right after
      // the third diamond of the picket and leaves the turret 1.3s of the shot
      // to work in. (Measured on the old 1500 swap: the residual MINES
      // cooldown ran to 1842, past the fire window, and the turret was not
      // planted until ~2050 of 2600.)
      if (!s8.sentry && t >= 1300) {
        s8.sentry = true;
        api.grantWeapon("SENTRY"); // resets the cadence — plants on this trigger
        // placeSentry seats the turret at the ship, so this IS where it lands;
        // the frame below is held on it because a 9px tripod that walks off the
        // edge is not a demonstration of anything.
        s8.turret = { x: p.x, y: p.y };
      }
      // A fresh pack ON the turret once the ship has cleared it. The mine
      // picket kills most of the chase in its first second, and a turret with
      // nothing in SENTRY_RANGE (480) is a 9px tripod doing nothing in an empty
      // frame — which is the shot failing to demonstrate its own mechanic.
      if (s8.sentry && !s8.wave && t >= 1550) {
        s8.wave = true;
        spawnRing(mulberry(181), ["wasp", "drone"], 12, s8.turret, 150, 260, s8.turret);
      }
      if (!s8.sentry) {
        // Slow lateral strafe so the three mines lay out as a picket rather
        // than a pile, and the pack closes instead of falling behind. The frame
        // sits BEHIND the hull, on the wake where the diamonds are.
        steer(0.5 + Math.sin(t * 0.0024) * 0.45, 0.2);
        staging.fire = true;
        staging.camPos = { x: p.x - 130, y: p.y - 30 };
      } else {
        // Plant, then walk away. Exactly ONE trigger: placeSentry re-seats the
        // single turret at the ship on every fire, so a second window would
        // drag it along instead of leaving it behind. 150ms is under SENTRY's
        // 246ms Lv3 interval, so the window cannot fire twice.
        //
        // The departure keeps the strafe's own heading (~0.5 rad at the plant)
        // instead of reversing to -0.6 as the old cut did. Reversing spent the
        // whole beat bleeding the existing velocity off — measured, the hull
        // ended up 89 world px from the turret after 1.1s, so "the ship leaves
        // it behind" never happened. Continuing the run opens ~280px of gap,
        // which the frame below holds both ends of.
        steer(0.42, 0.85);
        staging.fire = t < 1450;
        // PUSH IN on the plant. The turret is a 9px tripod firing 12px bolts —
        // the smallest named subject in the reel — so the one lever that makes
        // it legible is the frame closing on it while the ship pulls away. 1.9
        // → 2.25 over the beat; the ship covers ~250px in that time, which at
        // 2.25 still leaves both inside the 356px half-width.
        cam.setZoom(lerp(1.9, 2.25, ease((t - 1300) / 900)));
        // Frame biased toward the turret (0.36, not the midpoint): the ship is
        // the thing leaving, the turret is the thing the shot is about.
        staging.camPos = {
          x: s8.turret.x + (p.x - s8.turret.x) * 0.36,
          y: s8.turret.y + (p.y - s8.turret.y) * 0.36,
        };
      }
      floorShield(130);
    },
    teardown: sceneReset,
  };

  // -- 9. escalation-1 — the crowd doubles. Kiting arc: thrust away, flip, rake
  // the chasers. SEEKER SWARM's six pink missiles curve through the pack and the
  // TWIN drone orbits the hull mirroring every volley — for 20s you are two
  // ships, the cheapest "the pickups transform you" signal in the game.
  // The camera TIGHTENS as the count rises (the old cut pulled back, which made
  // the frame read emptier the fuller it got).
  let s9Reinforced = false;
  const escalation1: TrailerScene = {
    id: "escalation-1",
    duration: 2800,
    setup: () => {
      stage();
      s9Reinforced = false;
      // 1.15 → 1.32 → 1.75 (and 1.55 → 2.05 by the end), every staged radius
      // divided by the full 1.326 this time. The 1.32 pass was a nudge, not the
      // recipe: the shot stayed the reel's second-widest frame and the hull
      // still drew as a ~25px glyph inside a scatter. Same arc on screen, 33%
      // more subject in it.
      cam.setZoom(1.75); // half-frame ≈ 457 × 257
      const a = anchor(-400, 150);
      const rnd = mulberry(6);
      api.setLevel(3);
      api.setPlayerPose({ x: a.x, y: a.y, angle: 0, vx: 181, vy: 0 });
      api.grantWeapon("SEEKER SWARM");
      api.grantBooster("twin");
      // 18 → 24 and 6 → 8: a chase ring 33% tighter in world px is swept by the
      // same six missiles far faster, and bodies-per-screen is what the shot is
      // selling.
      spawnRing(rnd, ["drone"], 24, a, 197, 342, a, { from: Math.PI * 0.55, to: Math.PI * 1.45 });
      spawnRing(rnd, ["wasp"], 8, a, 164, 262, a, { from: Math.PI * 0.6, to: Math.PI * 1.4 });
      api.spawnEnemy("splitter", a.x - 243, a.y - 72, a);
      api.spawnEnemy("splitter", a.x - 262, a.y + 99, a);
      // The longest run in the reel: the kite carries the ship ~900px downrange
      // over 2.8s. A lane ALIGNED with that run — a ceiling of rock streaming
      // past above the ship, two masses cropped by the bottom edge below it —
      // makes the field the shot's motion rather than a wall the ship sits
      // inside. Composed on the middle of the run; the corridor covers all of
      // it, and the bottom of frame is left to the chase pack.
      // The run's LENGTH does not divide — it is thrust × time, i.e. the game's
      // own top speed — so the corridor and the band still cover ~980px. What
      // changes is that 980px is now 2.1 half-frames of lane instead of 1.6.
      const frame = { x: a.x + 380, y: a.y };
      dressRocks(rnd, {
        at: frame,
        layout: { kind: "band", angle: 0.15, offset: -0.55, halfWidth: 0.5, length: 2.0 },
        rMin: 30,
        rMax: 56,
        keepOut: corridor(a, { x: a.x + 980, y: a.y + 140 }, 60, 8),
      });
      boulder(mulberry(67), frame, 0.15, 1.05, { count: 6, spread: 65, rMin: 42, rMax: 58 });
      boulder(mulberry(68), frame, -0.85, 0.92, { count: 5, spread: 60, rMin: 42, rMax: 58 });
    },
    run: (t) => {
      cam.setZoom(lerp(1.75, 2.05, ease(t / 2800))); // density RISES with the count
      const p = api.player();
      if (!s9Reinforced && t >= 1400) {
        s9Reinforced = true;
        // The count visibly doubles mid-shot: a cut-off group ahead. Held at
        // 262-354 (the divided radii) so it lands at +0.6 → +0.8 half-frames,
        // i.e. it arrives in the RIGHT of frame that the shortened lead opens.
        spawnRing(mulberry(66), ["drone"], 14, p, 262, 354, p, { from: -0.9, to: 0.9 });
      }
      const dir = t * 0.00016; // heading bends gently downrange over the shot
      const cycle = t % 760;
      if (cycle < 460) {
        steer(dir, 0.8); // run — pursuers fill the frame behind
        staging.fire = false;
        // 174 → 60, re-picked by eye rather than divided. Dividing it kept the
        // hull at +0.38 half-frames while the divided chase ring collapsed to
        // −0.05 → −0.37 behind it, i.e. everything piled into the middle and
        // both edges went black. At 60 the hull sits near centre, the chase
        // spreads back to −0.62 and the mid-shot wave arrives past +0.6.
        staging.camPos = { x: p.x - 60, y: p.y };
      } else {
        const e = nearestEnemy(p, 700);
        steer(e ? angleTo(p, e) : dir + Math.PI, 0.05); // the kite flip
        staging.fire = true;
        staging.camPos = null; // frame snaps back on the turn
      }
      floorShield(130); // dense chase pack: same-frame shot stacking
    },
    teardown: sceneReset,
  };

  // -- 10. lancer-duel — the elite that reads: 8Hz hull strobe, a dashed 448px
  // locked charge vector, the 640 px/s commit, a scripted sidestep near-miss,
  // then focused fire drops it in a burst + a guaranteed elite crystal.
  //
  // 1.6 → 2.15 by the boss-kill recipe (zoom ×1.34, every staged offset ÷1.34).
  // At 1.6 the lancer's hitRadius-9 hull drew ~29px — the same mark as the
  // drones it is supposed to be distinct from, which is the whole reason this
  // shot exists. At 2.15 it is a ~39px dart with a legible nose and strobe, and
  // the composition is untouched because the standoff shrank with the frame.
  // The two world-space constants the beat rides on — the 448px charge vector
  // and the 640 px/s commit — are the GAME's, not staging, so they are left
  // alone; both simply cover more of a tighter frame, which is what makes the
  // near-miss read.
  /** Frame lead for the duel. 104 → 36: at 2.15 the old figure threw the hull
   *  224 SCREEN px left of centre and the drones converge on it as they die, so
   *  the whole fight sat in the left third with the right 45% of frame black —
   *  the single worst dead-space reading in the reel. The lead does not divide
   *  by the zoom ratio; it has to be re-picked against the frame it lands in. */
  const LANCER_LEAD = 36;
  /** Second file, staged on the pilot mid-shot. The opening 25 bodies all sit
   *  inside +283 world px of the anchor (0.76 half-frames) and are dead by ~2s,
   *  so without this the closing frames are one lancer wreck and black. */
  const LANCER_REFILL = 1200;
  let s10 = { lancerId: "", dodged: false, dodgeUntil: -1, finished: false, refilled: false };
  const lancerDuel: TrailerScene = {
    id: "lancer-duel",
    duration: 2600,
    setup: () => {
      stage();
      s10 = { lancerId: "", dodged: false, dodgeUntil: -1, finished: false, refilled: false };
      cam.setZoom(2.15); // half-frame ≈ 372 × 209
      const a = anchor(-900, 100);
      const rnd = mulberry(7);
      api.setLevel(3);
      api.setPlayerPose({ x: a.x, y: a.y, angle: 0, vx: 60, vy: 0 });
      for (let i = 0; i < 20; i++) {
        api.spawnEnemy("drone", a.x + 97 + rnd() * 186, a.y - 130 + rnd() * 260, a);
      }
      for (let i = 0; i < 5; i++) {
        api.spawnEnemy("wasp", a.x + 141 + rnd() * 156, a.y - 97 + rnd() * 193, a);
      }
      s10.lancerId = api.spawnEnemy("lancer", a.x + 238, a.y, a);
      // Level-3 stamp is ~970hp; trim it so the duel resolves inside the shot
      // with margin for the dodge and the burst.
      api.setEnemyHp(s10.lancerId, 420);
      // The second deliberately bare frame. The 8Hz hull strobe and the dashed
      // 448px charge vector are the subject; a belt of white outline around
      // them is just competition for the same colour. What it keeps is one mass
      // cropped low-left for depth and a thin scatter of SMALL rocks, which at
      // 2.15 still draw as a real belt without stealing the duel's colour.
      const frame = { x: a.x + LANCER_LEAD, y: a.y };
      dressRocks(rnd, {
        at: frame,
        layout: { kind: "arc", from: 2.5, to: 4.1, inner: 0.62, outer: 1.4 },
        count: 18,
        rMin: 24,
        rMax: 46,
        keepOut: corridor(a, { x: a.x + 149, y: a.y }, 67),
      });
      boulder(mulberry(72), frame, -0.8, 0.84, { count: 9, spread: 95, rMin: 46, rMax: 60 });
      boulder(mulberry(74), frame, 0.9, -0.62, { count: 9, spread: 89, rMin: 46, rMax: 60 });
      // The right edge, which the old lead left as pure black: one mass cropped
      // by it, at frame height rather than in a corner, so the side the duel is
      // NOT on still has a body in it.
      boulder(mulberry(76), frame, 1.04, 0.3, { count: 7, spread: 78, rMin: 44, rMax: 58 });
    },
    run: (t) => {
      const p = api.player();
      staging.camPos = { x: p.x + LANCER_LEAD, y: p.y };
      if (!s10.refilled && t >= LANCER_REFILL) {
        s10.refilled = true;
        const rr = mulberry(77);
        for (let i = 0; i < 11; i++) {
          api.spawnEnemy("drone", p.x + 150 + rr() * 210, p.y - 190 + rr() * 380, p);
        }
        for (let i = 0; i < 3; i++) {
          api.spawnEnemy("wasp", p.x + 210 + rr() * 150, p.y - 150 + rr() * 300, p);
        }
      }
      const lancer = api.enemies().find((e) => e.id === s10.lancerId && e.hp > 0);
      const charging = lancer !== undefined && Math.hypot(lancer.vx, lancer.vy) > 400;
      // Gate the dodge to the visible window — it used to resolve before the
      // first sampled frame, so the near-miss was never on camera.
      if (charging && !s10.dodged && t >= 700) {
        s10.dodged = true;
        s10.dodgeUntil = t + 380;
      }
      if (t < s10.dodgeUntil) {
        // Sidestep across the charge line — the near-miss beat.
        if (lancer) steer(angleTo(p, lancer) + Math.PI / 2, 1);
        staging.fire = false;
      } else if (lancer) {
        const opener = t < 600 ? nearestEnemy(p, 372, (e) => e.kind === "lancer") : null;
        const target = opener ?? lancer;
        steer(angleTo(p, target), 0.08);
        staging.fire = true;
        if (t > 1900 && !s10.finished) {
          s10.finished = true;
          api.damageEnemy(lancer.id, lancer.hp + 10); // burst lands at ~73% of the shot
        }
      } else {
        engage(521, 0.2, 0);
      }
      floorShield();
    },
    teardown: sceneReset,
  };

  // -- 11. elite-behaviours — the tactical texture the roster is built on, which
  // at the old wide zooms was buried inside 50-body crowds. Deliberately thin so
  // hulls read: WARDEN shrugs fire at ×0.2 behind its shield arc, lobs a mortar,
  // then VENTS for 1.4s at ×2 and the burst kills it; HIVE births two mites off
  // its expanding pulse ring; SPLITTER's death IS the attack, popping 3 drones
  // outward at frame edge.
  //
  // 1.45 → 2.0 by the boss-kill recipe (zoom ×1.38, every staged offset ÷1.38).
  // The old comment already claimed "elite hulls have to READ" and 1.45 did not
  // deliver it: a warden is hitRadius 16, so it drew ~46px — a mark, not a
  // machine. At 2.0 it is ~64px with a legible shield arc, the hive ~56px and
  // the splitter ~48px. This is the safest tighten in the reel because it is the
  // one shot whose camera never moves: camLock is set once, so nothing can walk
  // out of the crop mid-shot.
  let s11 = { wardenId: "", splitterId: "", popped: false };
  const eliteBehaviours: TrailerScene = {
    id: "elite-behaviours",
    duration: 2600,
    setup: () => {
      stage();
      s11 = { wardenId: "", splitterId: "", popped: false };
      cam.setZoom(2.0); // half-frame ≈ 400 × 225 — elite hulls have to READ
      const a = anchor(-1200, -400);
      api.setLevel(3);
      api.setPlayerPose({ x: a.x - 29, y: a.y + 44, angle: 0, vx: 0, vy: 0 });
      s11.wardenId = api.spawnEnemy("warden", a.x + 170, a.y + 15, a);
      // A fresh EnemySim has nextAttackAt 0, so the warden telegraphs its lob
      // immediately (700ms) and vents at 700-2100ms. 600hp means the shielded
      // phase visibly bounces off and the vent window visibly ends it.
      api.setEnemyHp(s11.wardenId, 600);
      api.spawnEnemy("spawner", a.x - 170, a.y - 127, a); // pulses immediately too
      s11.splitterId = api.spawnEnemy("splitter", a.x + 76, a.y + 141, a);
      const rnd = mulberry(21);
      // 10 → 24 → 32 → 44 over a box that is now the WIDTH OF THE FRAME. The
      // elites are the subject and the fodder is what makes the middle read as
      // a fight rather than as a clearing in the rock field — but at ±217 world
      // px the box only reached ±0.55 half-frames, so the outer quarter of each
      // side held nothing and the right one (which has no rock either) came out
      // as 45% black. -260 → +380 spans -0.55 → +1.05 of the shifted camLock
      // below, i.e. off both edges.
      for (let i = 0; i < 44; i++) {
        api.spawnEnemy("drone", a.x - 260 + rnd() * 640, a.y - 172 + rnd() * 344, a);
      }
      for (let i = 0; i < 13; i++) {
        api.spawnEnemy("wasp", a.x - 160 + rnd() * 430, a.y - 125 + rnd() * 250, a);
      }
      // Opposite CORNERS, with nothing across the middle: a knot low-left that
      // the elites are working out of and one mass cropped by the top-right,
      // leaving the diagonal between them to the fodder. This is the only shot
      // in the reel whose camera never moves (camLock is set once and never
      // updated), so it is the one that can take a composition this precise.
      // camLock 7 → -40: the elites work out of the LEFT of the box, so a frame
      // centred on the anchor sat the whole engagement left of centre. Shifting
      // the lock left walks the fight back into the middle third and hands the
      // right side to the widened fodder box and the mass below.
      const frame = { x: a.x - 40, y: a.y };
      dressRocks(rnd, {
        at: frame,
        layout: { kind: "clump", cx: -0.68, cy: 0.66, spread: 0.6 },
        rMin: 32,
        rMax: 54,
        keepOut: corridor({ x: a.x - 29, y: a.y + 44 }, { x: a.x + 145, y: a.y + 44 }, 58),
      });
      boulder(mulberry(211), frame, 0.95, -0.85, { count: 7, spread: 71, rMin: 44, rMax: 58 });
      // Cropped by the right edge at frame height. The corner mass above it
      // leaves the middle-right — the emptiest band in the shot — untouched,
      // and this shot's camera never moves, so a mass placed there stays there.
      boulder(mulberry(213), frame, 1.06, 0.34, { count: 6, spread: 66, rMin: 42, rMax: 56 });
      camLock.x = frame.x;
      camLock.y = frame.y;
      staging.camPos = camLock;
    },
    run: (t) => {
      const p = api.player();
      const warden = api.enemies().find((e) => e.id === s11.wardenId && e.hp > 0);
      const splitter = api.enemies().find((e) => e.id === s11.splitterId && e.hp > 0);
      const target = t < 1500 && warden ? warden : (splitter ?? warden ?? null);
      if (target) {
        steer(angleTo(p, target), 0.06);
        staging.fire = true;
      } else {
        engage(508, 0.1, 0);
      }
      if (!s11.popped && t > 2050 && splitter) {
        s11.popped = true;
        api.killEnemy(splitter.id); // guarantee the 3-drone pop before the cut
      }
      floorShield();
    },
    teardown: sceneReset,
  };

  // -- 12. shield-mods — the defensive half of the loadout, entirely absent
  // before. REFLECT: three snipers hold their 900ms strobing sight lines, fire,
  // and the spinning-triangle halo bounces the rails back down their own lines.
  // RAM: armed above 220 px/s, the frontal-arc halo lights and the ship runs a
  // line of drones and small rocks down — 60 damage + 320 px/s knockback, rocks
  // ≤28px destroyed outright. HUD left cluster on so the mod name + timer read.
  /** Heading of the RAM lane, down-right from the reflect standoff. Rocks and
   *  drones are staged ON this ray (measured: the old lane pointed 40px wide of
   *  both rocks, and asteroid contact tests against the ROCK's radius alone —
   *  24px — so the run passed clean through the gap every time). */
  const RAM_LANE_ANGLE = 0.28;
  /** ms the shot spends on REFLECT. The snipers arm at 0, aim for
   *  SNIPER_AIM_MS (900) and their 720 px/s rails need ~500ms to cross the
   *  ~380px standoff, so the bounce lands at ~1.4s: swapping before ~1.5s
   *  throws the reflect beat away. */
  const REFLECT_MS = 1600;
  let s12 = { ram: false, lane: { x: 0, y: 0 } };
  const shieldMods: TrailerScene = {
    id: "shield-mods",
    duration: 3000,
    setup: () => {
      stage();
      // 1.3 → 1.75 by the k-divide recipe (zoom ×1.346). Every STAGED distance
      // below divides; the numbers metered against the game's own physics do
      // not, and they are called out where they appear — the RAM rocks at
      // 145/200 (chosen off RAM_ARM_SPEED), the drone screen at 400-540 (chosen
      // off drone closing speed) and the snipers' own 520px kite-out.
      cam.setZoom(1.75); // half-frame ≈ 457 × 257
      show(hud.root, true);
      show(hud.right, false);
      const a = anchor(600, -300);
      const rnd = mulberry(26);
      api.setLevel(3);
      api.setPlayerPose({ x: a.x, y: a.y, angle: 0, vx: 0, vy: 0 });
      api.grantShieldMod("reflect");
      api.setShieldHp(100); // above REFLECT_MIN_SHIELD (40) — the arm is up
      const cos = Math.cos(RAM_LANE_ANGLE);
      const sin = Math.sin(RAM_LANE_ANGLE);
      const lane = (d: number): Vec => ({ x: a.x + cos * d, y: a.y + sin * d });
      s12 = { ram: false, lane: lane(700) };
      // Frame-left arc, inside SNIPER_FIRE_RANGE: all three lock and fire at
      // ~900ms, which is the whole beat. They kite out to 520 during it — a
      // game distance, and at 1.75 that is still only 1.14 half-frames from the
      // hull, so the kite stays on camera behind the shortened lead below.
      api.spawnEnemy("sniper", a.x - 245, a.y - 123, a);
      api.spawnEnemy("sniper", a.x - 279, a.y + 15, a);
      api.spawnEnemy("sniper", a.x - 234, a.y + 145, a);
      // Fodder screen so the frame is a fight, not two objects in black — and
      // so the player has something to shoot while the rails bounce. The wasps
      // are the reflect VOLUME: 3-bolt bursts every 2.2s, where each sniper
      // contributes one rail in the whole beat.
      // ALL of it stays frame-LEFT with the snipers. The reflect phase aims at
      // the nearest non-sniper (snipers are excluded on purpose — 35hp dies
      // long before its 900ms lock completes), so fodder staged to the right
      // pointed the ship's own guns down the RAM lane: measured, both staged
      // rocks were shot out at ~0.5s and ~0.9s, and the drops they left were
      // hoovered mid-run, replacing RAM with a looted OVERSHIELD at 2.0s.
      // 9 → 13 and 5 → 7: the box divides with the frame, so the same counts
      // would have read as a thinner screen than the one they replace.
      // Stretched left to −380 (from −319): the reflect frame sits at p−111, so
      // the box only reached −0.45 half-frames and the outer left quarter — the
      // side the whole beat faces — measured empty.
      for (let i = 0; i < 13; i++) {
        api.spawnEnemy("drone", a.x - 380 + rnd() * 330, a.y - 208 + rnd() * 416, a);
      }
      for (let i = 0; i < 7; i++) {
        api.spawnEnemy("wasp", a.x - 280 + rnd() * 140, a.y - 163 + rnd() * 327, a);
      }
      // The RAM lane. Distances are metered off the arm: measured, the ship
      // passes RAM_ARM_SPEED (220 px/s) ~780ms into the run having covered
      // ~90px. Rocks at 145/200 are therefore both hit ARMED — probe-confirmed
      // shatters at 2.45s and 2.70s of the 3.0s shot. RAM_ASTEROID_DESTROY_R
      // is 28, so both go outright rather than chipping.
      const rockA = lane(145);
      const rockB = lane(200);
      api.spawnAsteroid(rockA.x, rockA.y, 24);
      api.spawnAsteroid(rockB.x, rockB.y, 22);
      // Held out at 400+: drones close at 70 px/s, so staged any nearer they
      // reach the ship BEFORE it passes 220 px/s — and an unarmed hull contact
      // bounces the run to a stop instead of knocking the drone away (measured
      // at 245/300/355: the ship never re-armed).
      for (const d of [400, 470, 540]) {
        const q = lane(d);
        api.spawnEnemy("drone", q.x, q.y, a);
      }
      // Two lanes have to stay open: the RAM run (whose two staged rocks ARE
      // the beat — a third one in the way ends the run early) and the snipers'
      // sight lines, which a rock would absorb before the halo could bounce
      // them back. What is left is the top of frame, so that is all this shot
      // dresses — an arc neither lane reaches, plus a mass cropped by the
      // top-left corner. It spans the whole top on purpose: the camera walks
      // from p-(150,0) to p+(120,20) mid-shot, and a corner knot composed for
      // the opening frame is off the edge of the closing one (measured, +2.4pp).
      // rMin is held high on purpose:
      // a rock small enough for the ship's own fire to DESTROY rolls an 11% item
      // drop, and a looted OVERSHIELD landing mid-run replaces the mod this shot
      // exists to show.
      const frame = { x: a.x + 30, y: a.y };
      dressRocks(rnd, {
        at: frame,
        layout: { kind: "arc", from: -2.75, to: -0.4, inner: 0.6, outer: 1.18 },
        // Count down with the zoom (30 → 24) and rMax with it; rMin CANNOT come
        // down — 37 is the radius a Lv3 BEAM (power .40) destroys outright, and
        // a burst rock's 11% item roll replaces the mod this shot is about.
        count: 24,
        rMin: 42,
        rMax: 54,
        keepOut: [...corridor(a, lane(760), 71, 7), ...corridor({ x: a.x - 300, y: a.y }, a, 82)],
      });
      boulder(mulberry(261), frame, -0.82, -1.0, { count: 5, spread: 56, rMin: 42, rMax: 54 });
      // Cropped by the bottom-left corner. Both open lanes run above it — the
      // snipers sit at −123 → +145 of the anchor and the RAM lane leaves to the
      // lower RIGHT — so the one quadrant nothing in this shot ever crosses was
      // also the one quadrant with nothing in it.
      boulder(mulberry(265), frame, -0.95, 0.72, { count: 6, spread: 58, rMin: 42, rMax: 54 });
      // A FLOOR under the run, composed on where the frame ENDS UP.
      //
      // Two defects, one cause: the ceiling above was 94 uncapped rocks — the
      // brightest, biggest object in the shot, out-reading the hull it was meant
      // to sit behind — and it lived entirely in the top 30%, so at 88% (camera
      // at p+(120,20), the pilot ~410px down the lane) the bottom two thirds of
      // frame was the original void with one small ship in it. Thinning the
      // ceiling alone would have made that worse, so the shot gets a second,
      // LOW field instead, laid parallel to the RAM lane and anchored on the
      // closing frame rather than the anchor.
      //
      // Both lanes stay open by construction. It starts at x ≈ a.x+59, right of
      // every sniper (a.x-315 and left) and of the whole fodder screen, so no
      // sight line crosses it and the ship's own beams — held frame-LEFT for the
      // reflect beat — never point at it. Perpendicular offset 0.62 half-frames
      // (215px) with the corridor at 100 keeps it clear of the run itself, and
      // RAM only shatters rock within 28px of the hull. rMin stays above 37, the
      // radius a Lv3 BEAM (power .40) destroys outright.
      const closing = { x: a.x + 620, y: a.y + 178 }; // on the lane at that x
      dressRocks(mulberry(263), {
        at: closing,
        layout: { kind: "band", angle: RAM_LANE_ANGLE, offset: 0.62, halfWidth: 0.18, length: 1.0 },
        count: 16,
        rMin: 42,
        rMax: 52,
        keepOut: corridor(a, lane(1000), 74, 9),
      });
    },
    run: (t) => {
      const p = api.player();
      if (!s12.ram && t >= REFLECT_MS) {
        s12.ram = true;
        api.grantShieldMod("ram");
      }
      if (!s12.ram) {
        // Hold station facing frame-left so the bounce reads outbound — thrust
        // 0 aims without moving, which is also what keeps the ship on the
        // lane's origin so the staged rocks are actually in its path.
        // Targets are the fodder, never the snipers (35hp dies long before its
        // 900ms lock finishes) and never anything that has drifted right of
        // the hull: the whole point of holding the nose left is that the
        // ship's own beams must not fly down the RAM lane and shoot out the
        // rocks it is about to run into (measured — that is what killed them).
        staging.camPos = { x: p.x - 111, y: p.y };
        const e = nearestEnemy(p, 900, (en) => en.kind === "sniper" || en.x > p.x - 40);
        steer(e ? angleTo(p, e) : Math.PI, 0);
        staging.fire = e !== null;
      } else {
        // Commit: RAM only arms above RAM_ARM_SPEED (220 px/s).
        staging.camPos = { x: p.x + 89, y: p.y + 15 };
        steer(angleTo(p, s12.lane), 1);
        staging.fire = false;
        // Re-assert the mod every frame, exactly as the pickup shot re-asserts
        // its weapon. The reflect phase kills ~14 fodder and their drops lie on
        // the field the run then flies through, so a looted mod can silently
        // replace the one this shot exists to demonstrate — measured on a
        // capture, the HUD read BULWARK from ~2.6s of 3.0s. grantShieldMod only
        // rewrites kind/until, so re-granting the mod already held is a no-op.
        api.grantShieldMod("ram");
      }
      floorShield(130);
    },
    teardown: sceneReset,
  };

  // -- 13. beacon-contested — the squad holds the zone, then loses it. The old
  // cut parked all five wingmates OUTSIDE the 420px control radius so the player
  // was always sole controller and the contested state — the game's designed PvP
  // flashpoint — never fired. Here one wingmate breaks inside at ~2s: occupancy
  // hits two, the host flips contested, the gold hex strobes gold↔white at 4Hz,
  // the clash tone fires and the player's XP mote trickle cuts off mid-stream.
  let s13 = { beacon: { x: 0, y: 0 }, rusher: -1, wave2: false, wave3: false, broke: false };
  const beaconContested: TrailerScene = {
    id: "beacon-contested",
    duration: 3400,
    setup: () => {
      stage();
      const b = anchor(0, -250);
      s13 = { beacon: b, rusher: -1, wave2: false, wave3: false, broke: false };
      cam.setZoom(1.05); // half-frame ≈ 762 × 429; the 420px hex fills it
      camLock.x = b.x;
      camLock.y = b.y;
      staging.camPos = camLock;
      api.setLevel(3);
      // Me inside the zone (sole occupant → controller: motes stream my way).
      api.setPlayerPose({ x: b.x - 40, y: b.y + 150, angle: -Math.PI / 2, vx: -40, vy: 0 });
      api.spawnBeacon(b.x, b.y, 0.6, 40); // charge tail, arm flash ~600ms in
      installPeers();
      // Posts hand-placed on a 16:9 band: every one is >420 from the beacon (so
      // occupancy stays at one until the break) and inside the 762×429 frame.
      const posts: Vec[] = [
        { x: b.x - 545, y: b.y - 115 },
        { x: b.x - 480, y: b.y + 230 },
        { x: b.x + 500, y: b.y - 215 },
        { x: b.x + 560, y: b.y + 105 },
      ];
      posts.forEach((post, i) => {
        addPeer(`wing-${i + 1}`, i, post, {
          orbitR: 45,
          angVel: 2.0,
          phase0: i * 1.4,
          baseAim: angleTo(post, b),
          level: 2 + (i % 2),
          score: 150 + i * 40,
        });
      });
      // Index 2 = wing-3, PEER_COLORS[2] (green) — and the post nearest the
      // zone, so the break-in is the shortest run on screen.
      s13.rusher = 2;
      const rnd = mulberry(8);
      // Waves staged INSIDE / on the rim of the zone: the thing being defended
      // is actually threatened on camera.
      spawnRing(rnd, ["drone"], 12, b, 320, 430, b);
      spawnRing(rnd, ["drone"], 6, b, 470, 560, b);
      spawnRing(rnd, ["wasp"], 8, b, 520, 660, b);
      // The gold hexagon owns the middle, so the dressing is a HORIZON rather
      // than a ring around it: everything banked below, the top of frame left
      // black, one mass cropped by the bottom edge. Held off the zone itself —
      // a rock parked across the hex reads as damage to the beacon rather than
      // as an asteroid.
      dressRocks(rnd, {
        at: b,
        layout: { kind: "arc", from: 0.18, to: 3.15, inner: 0.66, outer: 1.4 },
        rMin: 40,
        keepOut: [{ x: b.x, y: b.y, r: 445 }],
      });
      boulder(mulberry(82), b, 0.42, 1.12, { count: 7, spread: 92 });
    },
    run: (t, dt) => {
      updateCrew(t, dt, "combat");
      if (!s13.wave2 && t >= 1400) {
        s13.wave2 = true;
        spawnRing(mulberry(88), ["wasp"], 6, s13.beacon, 470, 600, s13.beacon);
      }
      if (!s13.wave3 && t >= 2400) {
        s13.wave3 = true;
        spawnRing(mulberry(888), ["drone"], 8, s13.beacon, 300, 420, s13.beacon);
      }
      if (!s13.broke && t >= 1900) {
        s13.broke = true;
        const rusher = crew[s13.rusher];
        if (rusher) {
          // Inside BEACON_RADIUS → beaconOccupants() counts two → contested.
          rusher.postTarget = { x: s13.beacon.x + 200, y: s13.beacon.y - 80 };
          rusher.postSpeed = 300;
        }
      }
      // The locked frame travels across the zone instead of holding one wide.
      camLock.x = s13.beacon.x + lerp(-130, 130, ease(t / 3400));
      const p = api.player();
      const cycle = t % 900;
      if (cycle < 500) {
        const oa = Math.PI / 2 + t * 0.0009;
        const point = {
          x: s13.beacon.x + Math.cos(oa) * 200,
          y: s13.beacon.y + Math.sin(oa) * 200,
        };
        steer(angleTo(p, point), Math.min(0.9, dist(p, point) / 200));
        staging.fire = false;
      } else {
        engage(700, 0.05, -Math.PI / 2);
      }
      floorShield(130); // wave crossfire + wingmate bolts stack
    },
    teardown: sceneReset,
  };

  // -- 14. pvp-duel — the mode the old cut never showed: another ship as a
  // threat, not an escort. The rival's bolts are published through the real wire
  // schema, so the drain, the white 60° impact arcs at the hit angle, the shield
  // ring collapsing and the per-shooter i-frames are all the genuine PvP path.
  // Its death is real too (flipping alive fires splinterBurst + hull shatter +
  // ring through the remote-render path). The one scripted piece is the
  // arithmetic: fake peers have no sim, so the director drains the rival's
  // shield itself while the player's fire is on it.
  //
  // 1.8 → 2.4 by the boss-kill recipe (zoom ×1.33, every staged offset ÷1.33).
  // "They have to be BIG to read" was the old note and 1.8 did not get there: a
  // SHIP_RADIUS-8 hull drew ~29px, so the reel's only ship-versus-ship shot was
  // two marks 350px apart on black. At 2.4 each dart is ~38px with its shield
  // ring at ~58px, and the pair sits in the same place in frame because the
  // orbit radius and the raider's run shrank with it. The raider's SPEED is
  // divided by the same 1.33 as its distance, so the interception lands on the
  // same beat (~2.3s of 2.8s); the 26px contact test is NOT scaled — that is a
  // hull-contact constant (SHIP_RADIUS × 2 = 16 plus margin), not staging.
  let s14 = { rivalHp: 100, dead: false, rammer: -1, ramming: false, rammed: false };
  const pvpDuel: TrailerScene = {
    id: "pvp-duel",
    duration: 2800,
    setup: () => {
      stage();
      s14 = { rivalHp: 100, dead: false, rammer: -1, ramming: false, rammed: false };
      cam.setZoom(2.4); // two ships in black: they have to be BIG to read
      const a = anchor(260, 120);
      api.setLevel(3);
      api.setPlayerPose({ x: a.x, y: a.y, angle: 0, vx: 0, vy: 0 });
      api.setShieldHp(100);
      // Rocks for depth — the only neutral thing in the arena, and they keep
      // the frame from being two darts on pure black. (The third of the old
      // trio sat where the cropped mass below now goes.) Radii step down with
      // the zoom: at 2.4 a 55px rock already draws 264px across.
      api.spawnAsteroid(a.x + 199, a.y + 135, 55);
      api.spawnAsteroid(a.x + 23, a.y - 169, 34);
      installPeers();
      // The duellist: circles at close range so both hulls stay in one frame.
      addPeer(
        "rival",
        1,
        { x: a.x + 98, y: a.y - 19 },
        {
          orbitR: 86,
          angVel: 1.9,
          phase0: -0.6,
          baseAim: Math.PI,
          level: 3,
          score: 410,
          shotGapMs: 430, // paced so the drain reads as hits, not a delete
        },
      );
      // The RAM run: armed frontal-arc halo, waiting at the right edge of the
      // 333×188 half-frame. Measured, the old staging could not connect — a
      // 747px gap, 340 px/s, and a 1.0s window closed ~500px of it while the
      // victim-side RAM path needs hull contact inside SHIP_RADIUS×2 = 16px.
      // 477px at 525 px/s from t=1400 lands the hit at ~2.3s of 2.8s — the same
      // beat as the 636px-at-700 figure it replaces, both halves divided by the
      // zoom ratio so the run covers the same fraction of frame per second.
      const rammer = addPeer(
        "raider",
        4,
        { x: a.x + 450, y: a.y + 158 },
        {
          orbitR: 0,
          angVel: 0,
          phase0: 0,
          baseAim: Math.PI,
          level: 3,
          score: 260,
          shotGapMs: Infinity, // never shoots — the hull IS the weapon
          mod: "ram",
        },
      );
      rammer.postSpeed = 525;
      s14.rammer = crew.indexOf(rammer);
      // Two ships in black is the emptiest frame this reel can compose. A lane
      // the duel happens INSIDE beats a belt it happens in the middle of: the
      // band runs down-right, following the frame as it walks from the duel
      // circle onto the raider's line (the camera rides player↔rival, then
      // player↔raider, which arrives from a+(450, 158)), and one mass cropped
      // by the top-left corner gives the two darts something to be fighting
      // between. Only the duel circle is kept clear — at zoom 2.4 the
      // half-height is 188px, so any wider keep-out rejects every slot above
      // and below the pair and the field measures nothing.
      const frame = { x: a.x + 158, y: a.y + 53 };
      dressRocks(mulberry(71), {
        at: frame,
        layout: { kind: "band", angle: 0.42, halfWidth: 0.82, length: 2.4 },
        rMin: 32,
        rMax: 58,
        keepOut: [{ x: a.x + 83, y: a.y - 11, r: 131 }],
      });
      boulder(mulberry(73), frame, -0.98, -0.86, { count: 7, spread: 74, rMin: 44, rMax: 58 });
    },
    run: (t, dt) => {
      const p = api.player();
      const rival = crew[0];
      const rammer = crew[s14.rammer];
      if (rammer) {
        if (!s14.ramming && t >= 1400) s14.ramming = true;
        if (s14.ramming && !s14.rammed) {
          // Live intercept until the hulls touch, then commit to a fly-through
          // so the raider punches past instead of parking on the wreck it just
          // hit (postTarget snaps exactly onto its target once reached).
          if (dist(rammer, p) < 26) {
            s14.rammed = true;
            const away = angleTo(rammer, p);
            rammer.postTarget = {
              x: rammer.post.x + Math.cos(away) * 525,
              y: rammer.post.y + Math.sin(away) * 525,
            };
          } else {
            rammer.postTarget = { x: p.x, y: p.y };
          }
        }
      }
      updateCrew(t, dt, "duel");
      if (rival && !s14.dead) {
        // Frame on the midpoint so both ships are subjects.
        staging.camPos = { x: (p.x + rival.x) / 2, y: (p.y + rival.y) / 2 };
        steer(angleTo(p, rival), 0.35);
        staging.fire = t > 260;
        if (t > 400) {
          // Scripted arithmetic, real render: dropping shieldHp drives the peer
          // flash + spark path, and the ring arc IS its health bar. 105/s ends
          // the duel at ~1.35s, clearing the frame for the RAM run.
          s14.rivalHp = Math.max(0, s14.rivalHp - (dt / 1000) * 105);
          rival.state["shieldHp"] = s14.rivalHp;
        }
        if (s14.rivalHp <= 0 || t > 1400) {
          s14.dead = true;
          rival.state["alive"] = false; // real shatter + splinters + ring
          rival.state["beams"] = [];
        }
      } else {
        staging.camPos = rammer ? { x: (p.x + rammer.x) / 2, y: (p.y + rammer.y) / 2 } : null;
        steer(rammer ? angleTo(p, rammer) : 0, 0.5);
        staging.fire = true;
      }
      floorShield(60); // the drain has to read, so the floor sits low
    },
    teardown: sceneReset,
  };

  /** escalation-2 re-seeds the wall it is being pressed against. The run is a
   *  700px sprint SOUTH at the game's own top speed, so a crowd staged around
   *  the anchor is simply outrun — measured, by 63% the swarm had fallen to the
   *  top of frame and the bottom half was black. Both waves land ahead of the
   *  pilot, i.e. in the half of frame the sprint is entering. */
  const ESC2_WAVES: readonly number[] = [900, 1850];
  let s15Waves = 0;
  // -- 15. escalation-2 — the arena itself, finally established. The run tracks
  // SOUTH along the left energy barrier at ~520px standoff, so its breathing
  // magenta bloom, hot-cyan core and travelling scanline fill the left of frame
  // for the whole shot while ~50 hostiles press the ship against it: nowhere to
  // run. Compressed to the 1.1 frame — density is bodies-per-SCREEN.
  const escalation2: TrailerScene = {
    id: "escalation-2",
    duration: 2800,
    setup: () => {
      stage();
      s15Waves = 0;
      // 1.1 → 1.5 by the k-divide recipe (zoom ×1.364). It was the third-widest
      // frame in the reel and the only reason it read at all was the barrier's
      // own glow — the ~50 hostiles it is named for drew as a pink dust cloud.
      cam.setZoom(1.5); // half-frame ≈ 533 × 300
      // 420 → 330 standoff. The barrier is a frame EDGE, so its standoff is a
      // lead and gets re-picked rather than divided: at 330 the line still
      // lands ~19% in from frame left, exactly where it sat at 1.1, while a
      // straight ÷1.364 would have pushed the crowd's west flank outside the
      // play bounds (where the host culls it and the display sweep bursts it).
      const a = edgeAnchor(330, -350);
      const rnd = mulberry(9);
      api.setLevel(3);
      api.setPlayerPose({ x: a.x, y: a.y, angle: Math.PI / 2, vx: 0, vy: 191 });
      // Crowd centre biased EAST of the ship: the swarm presses it against the
      // wall, and nothing is staged outside the play bounds.
      const c = { x: a.x + 150, y: a.y };
      // 26/12/8 → 34/16/10: the ovals are 27% smaller in world px, and this is
      // the shot whose whole claim is "nowhere to run".
      spawnOval(rnd, ["drone"], 34, c, 345, 279, a);
      spawnOval(rnd, ["wasp"], 16, c, 293, 242, a);
      spawnOval(rnd, ["wasp"], 10, a, 154, 139, a); // already in burst range
      api.spawnEnemy("sniper", a.x + 381, a.y - 220, a);
      api.spawnEnemy("sniper", a.x + 411, a.y + 205, a);
      api.spawnEnemy("sniper", a.x + 249, a.y - 279, a);
      api.spawnEnemy("splitter", a.x + 249, a.y - 110, a);
      api.spawnEnemy("splitter", a.x - 139, a.y + 128, a);
      api.spawnEnemy("lancer", a.x + 345, a.y + 73, a);
      api.spawnEnemy("lancer", a.x - 95, a.y - 95, a);
      // The energy barrier already fills the left of frame, so every rock is
      // banked RIGHT — a second wall the swarm is pressing the ship against.
      // Dressing both sides would just redraw the wreath around a shot that
      // already has the strongest left edge in the reel. The run tracks 700px
      // south down the barrier; the field is composed on the middle of it, and
      // dressRocks' bounds check keeps anything from landing outside the play
      // area (which the host would cull, bursting it on the reveal).
      // The run's LENGTH is thrust × time — the game's own speed — so the 700px
      // it covers, and therefore where the field is composed, does not divide.
      const frame = { x: a.x + 110, y: a.y + 350 };
      dressRocks(rnd, {
        at: frame,
        layout: { kind: "band", angle: 1.42, offset: -0.62, halfWidth: 0.55, length: 2.0 },
        rMin: 40,
        rMax: 58,
        keepOut: corridor(a, { x: a.x, y: a.y + 760 }, 62, 7),
      });
      boulder(mulberry(91), frame, 0.72, -0.95, { count: 6, spread: 65, rMin: 42, rMax: 58 });
    },
    run: (t) => {
      const p = api.player();
      const due = ESC2_WAVES[s15Waves];
      if (due !== undefined && t >= due) {
        s15Waves += 1;
        // Ahead and slightly east — the pilot keeps its barrier standoff, so a
        // wave biased east fills the frame BETWEEN the wall and the rock bank
        // rather than landing on either.
        const rr = mulberry(93 + s15Waves);
        spawnOval(rr, ["drone", "wasp", "drone"], 18, { x: p.x + 90, y: p.y + 330 }, 300, 235, p);
      }
      // Serpentine SOUTH: heading stays parallel to the barrier so the standoff
      // (and therefore the barrier's place in frame) holds for the whole shot.
      const heading = Math.PI / 2 + 0.6 * Math.sin(t * 0.0036);
      const burstWindow = t % 1000;
      if (burstWindow < 520) {
        const e = nearestEnemy(p, 520);
        if (e && Math.abs(wrapAngle(angleTo(p, e) - heading)) < 1.4) {
          steer(angleTo(p, e), 0.5);
          staging.fire = true;
        } else {
          steer(heading, 0.9);
          staging.fire = false;
        }
      } else {
        steer(heading, 0.9);
        staging.fire = false;
      }
      floorShield(130); // heaviest bullet weather of the trailer
    },
    teardown: sceneReset,
  };

  // -- 16. death-beat — the honesty shot. Shield already low, boxed in at 140-
  // 230px, NITRO lit so the escape dash is a genuine 1.4× burst with the orange
  // flame trail — and it still fails. Real death: shatter + 30 splinters +
  // shockwave + white flash + 0.55 trauma. The respawn countdown is hidden for
  // this shot only: "Respawning in 2..." is a session-loop artifact that reads
  // as a caption and tells the viewer the death carries no cost.
  let s16Killed = false;
  const deathBeat: TrailerScene = {
    id: "death-beat",
    duration: 1900,
    setup: () => {
      stage();
      s16Killed = false;
      // 1.4 → 1.85 by the k-divide recipe (zoom ×1.32). The reel's one death is
      // the shot that most needs a hull you can see fail, and at 1.4 the pilot
      // drew ~25px inside a 571 × 321 half-frame with the boxing-in swarm too
      // far out to read as a box.
      cam.setZoom(1.85); // half-frame ≈ 432 × 243
      show(hud.countdown, false);
      const a = anchor(300, -100);
      const rnd = mulberry(10);
      api.setLevel(2, 30); // mid-level: the tax visibly costs progress
      api.setPlayerPose({ x: a.x, y: a.y, angle: 0.3, vx: 152, vy: -45 });
      api.setShieldHp(30); // two hits from gone
      api.grantBooster("nitro");
      // 16/10 → 22/14 over ovals 24% tighter in world px: the box has to still
      // BE a box on the frames the escape runs through.
      spawnOval(rnd, ["drone"], 22, a, 152, 125, a);
      spawnOval(rnd, ["wasp"], 14, a, 189, 155, a);
      // Boxed in, so the FRAME is boxed in: two masses cropped hard by the left
      // and right edges with the swarm caught between them, and a knot of small
      // rock overhead. A belt here would read as space around the pilot, which
      // is the opposite of what the shot says. The escape dashes out and flips
      // back, so both legs are corridored.
      boulder(rnd, a, -0.72, 0.16, { count: 17, spread: 118, rMin: 44, rMax: 60 });
      boulder(rnd, a, 1.0, -0.22, { count: 17, spread: 118, rMin: 44, rMax: 60 });
      dressRocks(rnd, {
        at: a,
        layout: { kind: "clump", cx: 0.08, cy: -0.94, spread: 0.55 },
        rMin: 26,
        rMax: 44,
        // The dash's REACH is thrust × time and does not divide, so both legs
        // are corridored to the full ~280px the ship can actually cover.
        keepOut: [
          ...corridor(a, { x: a.x + 280, y: a.y + 224 }, 61),
          ...corridor(a, { x: a.x - 280, y: a.y + 168 }, 61),
        ],
      });
      // A floor to close the box. The two masses are the walls and the knot
      // above is the lid; without this the bottom third stayed open, which is
      // the one direction a shot about having nowhere to go must not offer.
      dressRocks(mulberry(101), {
        at: a,
        layout: { kind: "clump", cx: -0.12, cy: 1.0, spread: 0.46 },
        rMin: 26,
        rMax: 44,
        keepOut: [
          ...corridor(a, { x: a.x + 280, y: a.y + 224 }, 61),
          ...corridor(a, { x: a.x - 280, y: a.y + 168 }, 61),
        ],
      });
    },
    run: (t) => {
      const p = api.player();
      if (!p.alive) {
        staging.steer = null;
        staging.fire = false;
        return;
      }
      // Escape script: dash for the gap, get cut off, flip — then the burst.
      if (t < 550) steer(0.9, 1);
      else steer(Math.PI + 0.6, 0.95);
      staging.fire = false;
      // The one scene that ends on a death still has to end on it at a chosen
      // FRAME. Left to the swarm the kill landed at 1175ms of 1900 (measured),
      // handing 38% of the shot to the settled DESTROYED plate — the exact
      // defect this shot was rebuilt to fix. `deathless` (from stage()) holds
      // the pilot through the boxing-in — real hits, real drain, the ring
      // visibly failing at 1hp — and killPlayer, which goes straight to die()
      // and so is not subject to the clamp, lands the blow at 1450, leaving
      // ~450ms of shatter before the cut.
      if (!s16Killed && t > 1450) {
        s16Killed = true;
        api.killPlayer("WASP");
      }
    },
    teardown: sceneReset,
  };

  // -- 17. boss-approach — two thirds of the boss the old cut skipped. PHASE 1:
  // the capital ship orbits at 700px, blooms its 600ms muzzle telegraph and
  // sweeps a 7-shot 60° broadside fan. PHASE 2 (HP is the phase, so setEnemyHp
  // flips it and bypasses the 8s floor): it strafes at 1.4×, snaps three
  // strobing white sight lines onto three DIFFERENT ships — the two fake
  // wingmates make the triple lock express — holds 1.1s, then fires three
  // 820 px/s lances at once. DRILL supplies the sustained-pierce category.
  //
  // THIS SHOT AND THE NEXT ONE ARE ONE CUT, AND THEY WERE ONE PICTURE. Verbatim
  // from the last review: "both frames have the red HP bar across the top, the
  // red hexagonal boss outline in the upper-middle-right at almost the same
  // screen position, a continuous white rock band along the bottom third, and
  // the same scatter of pink triangles. The cut does not register as a cut.
  // That's 9.2s of the 55s reel on one picture."
  //
  // Rock layout could never have fixed that — the shared bodies were the HUD bar
  // and the capital ship itself. So the two shots are now taken from opposite
  // ends of every camera axis there is:
  //
  //   approach (here)      kill (next)
  //   zoom 1.0, the WIDEST  zoom 1.7, the BIGGEST subject in the reel
  //   boss LOWER-LEFT, far  boss CENTRE, huge — 200+ screen px of hull
  //   frame biased 0.34     frame biased 0.50-0.70, i.e. onto the boss
  //     toward the PILOT
  //   rock CEILING          rock FLOOR
  //   a thin screen of      the reel's densest horde, packed to the edges
  //     fodder, frame-right
  //   NO boss bar           boss bar, visibly draining to the kill
  //
  // The bar is the deliberate one: a static red stripe over the establishing
  // shot is just a shared element, where over the climax it is the story. The
  // dreadnought's own red hexagon, its broadside fan and its triple lance say
  // "boss" without it.
  let s17 = { bossId: "", flipped: false, wave2: false, wave3: false };
  /** Camera bias toward the capital ship. 0.5 (the midpoint) put it 230px off
   *  centre — near enough to the next shot's framing that the two read as one
   *  held frame. 0.34 sits the frame on the PILOT'S side of the gap, which
   *  throws the capital ship out to ~0.66 of a 620px separation: lower-left,
   *  small, far, with the lances crossing the whole frame to reach us. */
  const APPROACH_BIAS = 0.34;
  const bossApproach: TrailerScene = {
    id: "boss-approach",
    // Measured: P1 fan at ~600ms, phase-2 lock arms at ~2.79s and holds its
    // 1.1s aim, three lances away at ~3.95s. At BOSS_LANCE_SHOT_SPEED (820)
    // and the ~500px the shot holds between the capital ship and its targets,
    // the lances need ~620ms to connect — at 4500 they were still crossing
    // when the cut came (probe: three rails in flight on the final frame).
    duration: 5000,
    setup: () => {
      stage();
      s17 = { bossId: "", flipped: false, wave2: false, wave3: false };
      cam.setZoom(1.0); // half-frame 800 × 450 — the widest frame in the reel
      const a = anchor(500, 0);
      const rnd = mulberry(17);
      api.setLevel(3);
      // The whole formation is staged UP AND RIGHT of the capital ship, which
      // sits down-left of it at 620px. At bias 0.34 that lands the boss around
      // (-370, +175) of the half-frame and the pilot around (+190, -90): the
      // action runs on the frame's rising diagonal, from a capital ship in the
      // lower-left to three ships spread across the upper-right.
      const start = { x: a.x + 260, y: a.y - 150, angle: Math.PI - 0.44, vx: -40, vy: 0 };
      api.setPlayerPose(start);
      api.grantWeapon("DRILL");
      installPeers();
      // Two wingmates: the phase-2 lock picks the three nearest PLAYERS, so
      // without them the "triple" lock is one line onto one ship. Spread wide
      // on the right so the three sight lines fan instead of stacking.
      addPeer(
        "wing-a",
        0,
        { x: a.x + 480, y: a.y - 330 },
        {
          orbitR: 55,
          angVel: 1.2,
          phase0: 0.4,
          baseAim: Math.PI - 0.44,
          level: 3,
          score: 380,
        },
      );
      addPeer(
        "wing-b",
        2,
        { x: a.x + 620, y: a.y + 60 },
        {
          orbitR: 55,
          angVel: -1.1,
          phase0: 2.1,
          baseAim: Math.PI - 0.44,
          level: 2,
          score: 240,
        },
      );
      s17.bossId = api.spawnEnemy("dreadnought", a.x - 300, a.y + 115, start);
      // A SCREEN of fodder, not a crowd: this is the establishing shot, and the
      // next one owns the horde. Banked frame-right and low, which is where a
      // composition that puts its rock along the top and its capital ship in
      // the lower-left corner has nothing — so the two shots' pink reads as a
      // thin sweep across an open frame here and as a wall there.
      spawnOval(rnd, ["drone", "wasp"], 20, { x: a.x + 480, y: a.y + 20 }, 330, 270, start);
      // A CEILING — the exact mirror of the arc the kill shot lays along its
      // floor, and the same kind of shape rather than a band, so the two
      // silhouettes read as opposites rather than as two unrelated ideas.
      //
      // It is an arc and not a full-width lane for one measured reason: the
      // capital ship orbits the crowd centroid at 70 px/s (98 in phase 2) and
      // over five seconds it walks ~450px, ending the shot in the frame's
      // UPPER-LEFT. Two straight-band attempts both put a red hexagon inside a
      // white rock lane by the 88% mark, which is the one reading this shot
      // cannot afford. The arc stops at -2.0 rad, leaving the upper-left corner
      // black for the capital ship to rise into, and `inner` 0.6 keeps the
      // middle — where the three lock lines cross — clear.
      //
      // `outer` runs to 1.75, well past the frame, because the CAMERA falls
      // ~300px (0.67 half-heights) across the shot as the pilot closes: an arc
      // sized to the opening frame has walked off the top edge by the 88% mark
      // and left the ceiling as two rocks in a corner. The band past 1.0 is the
      // reservoir that arrives as the frame drops.
      const frame = { x: a.x + 70, y: a.y - 60 };
      dressRocks(rnd, {
        at: frame,
        layout: { kind: "arc", from: -2.0, to: -0.35, inner: 0.6, outer: 1.75 },
        count: 80,
        rMin: 48,
        keepOut: [
          { x: a.x - 300, y: a.y + 115, r: 250 }, // the boss's own station
          ...corridor(start, { x: a.x - 300, y: a.y + 115 }, 90),
        ],
      });
      boulder(rnd, frame, 0.94, -1.02, { count: 12, spread: 114 });
      // Cropped by the RIGHT edge, at frame height rather than above it: the
      // only mass in the shot that the falling frame cannot walk off, and it
      // sits on the opposite side from the capital ship's late station.
      boulder(mulberry(173), frame, 1.08, -0.2, { count: 8, spread: 100 });
      camLock.x = frame.x;
      camLock.y = frame.y;
      staging.camPos = camLock;
    },
    run: (t, dt) => {
      updateCrew(t, dt, "combat");
      const p = api.player();
      const boss = api.enemies().find((e) => e.id === s17.bossId);
      if (boss) {
        camLock.x = p.x + (boss.x - p.x) * APPROACH_BIAS;
        camLock.y = p.y + (boss.y - p.y) * APPROACH_BIAS;
        // Phase is DERIVED from HP, so this crosses into phase 2 without
        // touching hostDamageEnemy's per-phase floor. Timed so the P2 lock
        // (next cycle + a 1.1s aim) lands inside the shot.
        if (!s17.flipped && t >= 800) {
          s17.flipped = true;
          api.setEnemyHp(boss.id, boss.maxHp * 0.5);
        }
      }
      // Reinforcements into the BOTTOM of the frame, twice. Two things need
      // this and they are the same thing: five seconds is a long time to hold a
      // wide frame on one capital ship (the opening screen is dead well before
      // the cut), and this composition banks all its rock along the top, so the
      // lower half is the half with nothing in it. Waves staged on the frame
      // centre's bottom arc fill it AND keep the shot's back half a fight.
      if (!s17.wave2 && t >= 1500) {
        s17.wave2 = true;
        spawnRing(mulberry(172), ["drone", "wasp"], 12, camLock, 260, 430, p, {
          from: 0.2,
          to: 2.9,
        });
      }
      if (!s17.wave3 && t >= 2800) {
        s17.wave3 = true;
        spawnRing(mulberry(171), ["drone", "wasp", "drone"], 14, camLock, 250, 420, p, {
          from: 0.35,
          to: 2.6,
        });
      }
      const e = nearestEnemy(p, 520, (en) => en.kind === "dreadnought");
      if (t > 2600 && boss) {
        steer(angleTo(p, boss), 0.25); // close on the capital ship for the lances
        staging.fire = true;
      } else if (e) {
        steer(angleTo(p, e), 0.2);
        staging.fire = true;
      } else {
        steer(Math.PI - 0.44, 0.35);
        staging.fire = true;
      }
      floorShield(130); // fans + lances + fodder stack in one step
    },
    teardown: sceneReset,
  };

  // -- 18. boss-kill — the CLIMAX, and the payoff the old cut had no way to
  // reach: hostDamageEnemy clamps boss damage to the phase boundary for 8s, so
  // no amount of damage can finish it in trailer time. killEnemy() runs the real
  // hostKillEnemy payout — the 30-orb XP fountain and two guaranteed crystals
  // blooming out of the wreck while the horde is left leaderless. Phase 3 up to
  // that point: planted, 700ms telegraph, 16-shot radial nova, 4 mites every
  // 1.9s, PLASMA STORM airbursts under OVERDRIVE gold, combo pill at ×5.
  //
  // THE CLOSE HALF OF THE BOSS CUT (see the block above bossApproach for the
  // whole axis-by-axis split). Everything here is the opposite end of the shot
  // before it: 1.7 instead of 1.0, the capital ship at frame CENTRE at 200+
  // screen px of hull instead of small and lower-left, a rock floor instead of a
  // ceiling, the horde packed to the edges instead of a thin screen, and the
  // boss bar — held back from the approach on purpose — draining to zero on
  // camera. Every staging radius is the old 1.25 figure divided by 1.36, so the
  // composition is unchanged and every body in it is 36% bigger.
  let s18 = { bossId: "", nextChip: 0, wave2: false, wave3: false, killed: false };
  const bossKill: TrailerScene = {
    id: "boss-kill",
    duration: 4000,
    setup: () => {
      stage();
      s18 = { bossId: "", nextChip: 600, wave2: false, wave3: false, killed: false };
      cam.setZoom(1.7); // half-frame ≈ 471 × 265 — the climax, shot CLOSE
      show(hud.boss, true);
      show(hud.combo, true);
      if (hud.boss) hud.boss.style.top = "52px";
      const a = anchor(500, 0);
      const rnd = mulberry(11);
      api.setLevel(3);
      const start = { x: a.x, y: a.y + 147, angle: -Math.PI / 2, vx: -120, vy: 0 };
      api.setPlayerPose(start);
      api.grantWeapon("PLASMA STORM");
      api.grantBooster("overdrive");
      s18.bossId = api.spawnEnemy("dreadnought", a.x, a.y - 140, start);
      api.setEnemyHp(s18.bossId, 4300); // ≤33% → phase 3 script from frame one
      // Sized to the 1.7 frame (±471 × ±265): the horde fills the SCREEN.
      spawnOval(rnd, ["drone", "wasp", "drone"], 30, a, 243, 191, start);
      spawnOval(rnd, ["wasp", "drone"], 14, a, 353, 250, start);
      api.spawnEnemy("warden", a.x - 250, a.y + 44, start);
      api.spawnEnemy("warden", a.x + 257, a.y - 22, start);
      api.spawnEnemy("spawner", a.x + 287, a.y - 107, start);
      api.spawnEnemy("sniper", a.x - 397, a.y - 88, start);
      api.spawnEnemy("sniper", a.x + 390, a.y + 110, start);
      // The horde is what fills this frame, so the rock stays out of its way and
      // does one job: a ground plane under the climax — a bank sweeping the
      // bottom of frame and one mass cropped by the right edge — instead of
      // another ring competing with 60 bodies for the same outline colour.
      // Thinned to a GROUND LINE, not a bank: uncapped it ran to the 96-rock
      // ceiling and the bottom third came out brighter and more tangled than the
      // capital ship the shot is named for. Count and radii are stepped down
      // again with the zoom (22 at r26-46, where 1.25 took 40 at r34-60) —
      // rock draws BIGGER as the frame tightens, and a floor is all this is.
      const frame = { x: a.x, y: a.y - 44 };
      dressRocks(rnd, {
        at: frame,
        layout: { kind: "arc", from: 0.36, to: 2.9, inner: 0.62, outer: 1.3 },
        count: 22,
        rMin: 26,
        rMax: 46,
        keepOut: [
          { x: a.x, y: a.y - 140, r: 170 }, // the boss hull + its nova reach
          ...corridor(start, { x: a.x, y: a.y - 103 }, 95),
        ],
      });
      boulder(mulberry(112), frame, 1.06, 0.42, { count: 5, spread: 62, rMin: 34, rMax: 48 });
      camLock.x = a.x;
      camLock.y = a.y;
      staging.camPos = camLock;
    },
    run: (t) => {
      const p = api.player();
      const boss = api.enemies().find((e) => e.id === s18.bossId);
      if (boss) {
        // Bias toward the boss: it becomes the subject rather than sharing
        // centre-frame with the player. Held to 0.70 rather than the 1.25
        // frame's 0.84 — at 1.7 the half-height is only 265 world px, and the
        // pilot's 260px orbit walks it off the bottom edge past that.
        const bias = lerp(0.5, 0.7, ease(t / 2900));
        camLock.x = p.x + (boss.x - p.x) * bias;
        camLock.y = p.y + (boss.y - p.y) * bias;
      }
      if (!s18.wave2 && t >= 1200) {
        s18.wave2 = true;
        spawnOval(mulberry(111), ["drone", "wasp"], 16, p, 309, 235, p);
      }
      if (!s18.wave3 && t >= 2200) {
        s18.wave3 = true;
        spawnOval(mulberry(1111), ["drone", "wasp"], 16, p, 324, 243, p);
      }
      const cycle = t % 1000;
      if (boss && cycle >= 650) {
        steer(angleTo(p, boss), 0.1);
      } else if (boss) {
        const oa = Math.PI / 2 + t * 0.0011;
        // 191, not 260: the orbit radius is what decides how far apart the two
        // subjects sit, and at 1.7 the half-height is 265 world px.
        const point = { x: boss.x + Math.cos(oa) * 191, y: boss.y + Math.sin(oa) * 191 };
        steer(angleTo(p, point), Math.min(0.95, Math.max(0.3, dist(p, point) / 200)));
      } else {
        engage(600, 0.35, 0);
      }
      staging.fire = true;
      // Steady chip keeps the boss bar visibly falling toward the kill.
      if (boss && t >= s18.nextChip && !s18.killed) {
        s18.nextChip = t + 500;
        api.damageEnemy(boss.id, 130);
      }
      if (boss && !s18.killed && t > 2750) {
        s18.killed = true;
        api.killEnemy(boss.id); // fountain + two crystals; 1.2s of aftermath left
      }
      floorShield(130); // boss novas + horde + snipers stack in one step
    },
    teardown: sceneReset,
  };

  // -- 19. survivors — RELEASE, read as the aftermath of that fountain: four
  // scattered survivors sweep back into a wedge on the player's wing, the spoils
  // hoover in under MAGNET, the sector tally ticks. No beacon here — the old
  // closer re-ran the mid-point's gold hexagon, so the release beat landed as
  // déjà vu.
  //
  // TWO TIMING FACTS SHAPE THIS SHOT, both measured off the last capture:
  //  1. The reel's closing 400ms dip and the 420ms wait after it fall INSIDE
  //     the last scene's measured window (the harness stamps the end when the
  //     shell reports done). A 2.0s closer therefore had its final delivered
  //     still land 122ms past the cut: peak pixel 126/255 against 255 for every
  //     other frame in the reel. 3.8s puts that sample back on picture with
  //     ~95ms of margin.
  //  2. Every other scene's teardown wipes the crew so the next one stages
  //     clean. Running that at t=duration on the LAST scene drops four ships
  //     out of frame the instant the dip starts, which is exactly what the
  //     "all four squadmates are gone" reading caught. stage() now owns the
  //     wipe, so this shot can hold its picture through the fade.
  /** Spoils of the run, strewn on the drift line — every cluster inside the
   *  260px magnet reach so the whole field hoovers in on camera. */
  const seedSpoils = (b: Vec, rnd: () => number): void => {
    // Ringed at ~200px off the drift line: inside MAGNET_RANGE (260) so they
    // all come, but far enough out that the hoover has visible travel instead
    // of being collected on the spawn frame (SHARD_PICKUP_RADIUS is 40).
    const clusters: Vec[] = [
      { x: b.x - 300, y: b.y - 60 },
      { x: b.x - 150, y: b.y + 170 },
      { x: b.x - 40, y: b.y - 190 },
      { x: b.x + 120, y: b.y + 155 },
      { x: b.x + 175, y: b.y - 120 },
    ];
    for (const c of clusters) {
      for (let i = 0; i < 7; i++) {
        api.spawnShards(1, c.x + (rnd() - 0.5) * 110, c.y + (rnd() - 0.5) * 90);
      }
    }
  };
  /** Scattered start → wedge slot, both relative to the formation centre. Each
   *  pair is on the same side of the player so nobody flies through the hull,
   *  and the two long runs come from frame-right so they overtake INTO
   *  formation rather than drifting into it. */
  const SQUAD_RUNS: ReadonlyArray<{ from: Vec; to: Vec }> = [
    { from: { x: -390, y: 250 }, to: { x: -70, y: 80 } },
    { from: { x: -400, y: -235 }, to: { x: -70, y: -80 } },
    { from: { x: 330, y: 250 }, to: { x: -190, y: 165 } },
    { from: { x: 350, y: -240 }, to: { x: -190, y: -165 } },
  ];
  const SQUAD_FORM_START = 700;
  const SQUAD_FORM_END = 3150;
  const SURVIVORS_MS = 3800;
  /** The closer's fight: the last of the horde, staged in front of the wedge so
   *  the squad forms up THROUGH it. Every body is inside the crew's 760px
   *  engage range from every slot on the run, and none of it outlives ~2.4s —
   *  four wingmates at 26 damage a bolt one-shot drone (20hp) and wasp (25hp)
   *  fodder, and the leader's Lv3 beam is three 40-damage pellets on top. */
  const seedLastWave = (
    b: Vec,
    rnd: () => number,
    aimAt: Vec,
    count: number,
    near: number,
    span: number,
    halfH: number,
  ): void => {
    for (let i = 0; i < count; i++) {
      api.spawnEnemy(
        i % 3 === 0 ? "wasp" : "drone",
        b.x + near + rnd() * span,
        b.y - halfH + rnd() * halfH * 2,
        aimAt,
      );
    }
  };
  /** Two follow-up waves. Five ships firing together delete a 17-body picket in
   *  ~1.5s, and the closer cannot spend its back half watching them coast: both
   *  are staged inside the CLOSING frame (the shot pushes to zoom 1.85,
   *  half-width 432) so a kill is still landing on the final cut. */
  const SQUAD_WAVE_2 = 1500;
  /** Late enough that it is STILL DYING on the closing frames. At 2450 the
   *  squad had cleared it by ~3.1s and the reel's last picture went back to
   *  five ships holding formation, which is the exact defect this shot was
   *  rebuilt to kill. */
  const SQUAD_WAVE_3 = 2700;
  /** Spoils are held back until the wave is dying. The shot's arc is fight →
   *  win → collect, and starting the vacuum at t=0 ran all three at once. */
  const SPOILS_START = 1050;
  let s19 = {
    b: { x: 0, y: 0 },
    seeded: -1,
    rnd: mulberry(12),
    formed: false,
    wave2: false,
    wave3: false,
  };
  const survivors: TrailerScene = {
    id: "survivors",
    duration: SURVIVORS_MS,
    setup: () => {
      stage();
      const b = anchor(0, 200);
      cam.setZoom(1.45); // half-frame ≈ 552 × 310 — the scattered start fits
      show(hud.root, true);
      show(hud.left, false);
      show(hud.players, false); // the sector tally line only
      api.setLevel(3);
      api.setShieldHp(100);
      // Barely drifting: the wedge slots are anchored to the formation centre,
      // so a leader that coasts away from it lands the shot with a 700px hole
      // between the point of the V and the rest of it (measured at 157px of
      // drift on the previous capture).
      api.setPlayerPose({ x: b.x + 50, y: b.y + 10, angle: 0, vx: 0, vy: 0 });
      api.grantBooster("magnet");
      camLock.x = b.x;
      camLock.y = b.y;
      staging.camPos = camLock;
      installPeers();
      const scores = [240, 180, 120, 88];
      for (let i = 0; i < 4; i++) {
        const run = SQUAD_RUNS[i] ?? SQUAD_RUNS[0];
        if (!run) continue;
        addPeer(
          `squad-${i + 1}`,
          i,
          { x: b.x + run.from.x, y: b.y + run.from.y },
          {
            orbitR: 22,
            angVel: 0.5,
            phase0: i * 1.6,
            baseAim: 0,
            level: 3,
            score: scores[i] ?? 100,
          },
        );
      }
      // Two parked rocks: at 1.45 a 66px rock draws ~190px of hull, and the
      // flanks want an anchor that is not itself a fused mass.
      api.spawnAsteroid(b.x - 430, b.y - 250, 66);
      api.spawnAsteroid(b.x + 380, b.y + 235, 58);
      // Dressed at the FLANKS, with the fight in the gap between them.
      //
      // The climax used to run three bottom-weighted frames back to back: ink
      // centroids (0.45,0.52) for boss-approach, (0.50,0.72) for boss-kill and
      // (0.56,0.69) here, i.e. the reel ended on the same picture three times
      // and read as one long shot. boss-kill keeps its floor because the horde
      // needs a ground plane; this one takes the opposite composition — a knot
      // cropped by the left edge, one mass cropped by the right, TOP AND BOTTOM
      // OPEN. What used to sit in that gap was nothing, which is the defect the
      // last review named: "the lowest-energy composition in the reel and it's
      // the last thing anyone sees". Now the last wave dies in it.
      //
      // dressRocks measures the frame at setup (zoom 1.45) but this shot pushes
      // to 1.85, so both flanks are composed to be crossing the edge by the
      // closing frame (|u| > 1.45/1.85 ≈ 0.78 is off it).
      dressRocks(mulberry(81), {
        at: b,
        layout: { kind: "clump", cx: -0.86, cy: 0.04, spread: 0.34 },
        count: 14,
        rMin: 34,
        rMax: 62,
        keepOut: [{ x: b.x - 60, y: b.y, r: 215 }],
      });
      boulder(mulberry(83), b, 0.72, -0.04, { count: 8, spread: 96, rMin: 46, rMax: 66 });
      const rnd = mulberry(12);
      s19 = { b, seeded: -1, rnd, formed: false, wave2: false, wave3: false };
      // The last of the horde, ahead of the wedge. The squad forms up while
      // clearing it, so the closer opens on five ships FIRING and lands on the
      // spoils of what they just killed.
      seedLastWave(b, mulberry(84), { x: b.x + 50, y: b.y + 10 }, 17, 170, 330, 235);
    },
    run: (t, dt) => {
      cam.setZoom(lerp(1.45, 1.85, ease(t / (SURVIVORS_MS - 400))));
      // Form up: every peer is given the speed that lands it on its slot at the
      // same instant, so a wedge assembles instead of four independent drifts,
      // and each one is still moving (>100 px/s, i.e. trails lit) the whole way.
      if (!s19.formed && t >= SQUAD_FORM_START) {
        s19.formed = true;
        const travelS = (SQUAD_FORM_END - SQUAD_FORM_START) / 1000;
        for (let i = 0; i < crew.length; i++) {
          const peer = crew[i];
          const run = SQUAD_RUNS[i];
          if (!peer || !run) continue;
          const target = { x: s19.b.x + run.to.x, y: s19.b.y + run.to.y };
          peer.postTarget = target;
          peer.postSpeed = dist(peer.post, target) / travelS;
        }
      }
      if (!s19.wave2 && t >= SQUAD_WAVE_2) {
        s19.wave2 = true;
        seedLastWave(s19.b, mulberry(85), api.player(), 11, 150, 205, 175);
      }
      if (!s19.wave3 && t >= SQUAD_WAVE_3) {
        s19.wave3 = true;
        seedLastWave(s19.b, mulberry(86), api.player(), 13, 130, 190, 165);
      }
      // "combat", not "idle": the wingmates aim and shoot at the wave for as
      // long as one is alive, and updateCrew degrades to the parked wedge aim
      // by itself once nothing is left — so the same call carries the fight AND
      // the formation hold that follows it.
      updateCrew(t, dt, "combat");
      // Re-scatter on a 620ms cadence so the hoover never runs dry, but only
      // once the wave is dying: the closing third is the vacuum, the opening
      // third is the kill.
      const wave = Math.floor((t - SPOILS_START) / 620);
      if (t >= SPOILS_START && wave > s19.seeded && t < SURVIVORS_MS - 500) {
        s19.seeded = wave;
        seedSpoils(s19.b, s19.rnd);
      }
      // The leader is the point of the wedge and holds station — the slots are
      // anchored to the formation centre, so a leader that chases the wave
      // leaves a hole where the V should be. It fires without leaving.
      const p = api.player();
      const target = nearestEnemy(p, 760);
      steer(target ? angleTo(p, target) : 0.06 * Math.sin(t * 0.001), 0.03);
      staging.fire = target !== null;
      floorShield(100);
    },
    // Deliberately NOT sceneReset: see fact 2 above. Nothing follows this shot,
    // and the crew has to survive into the dip.
    teardown: () => {
      staging.steer = null;
      staging.fire = false;
    },
  };

  runTrailer({
    // The game draws its own screen vignette (energy-barrier) — stacking the
    // shell's would double-darken the neon edges.
    vignette: false,
    // First real click/keypress, whenever it lands: build the audio graph so
    // the rest of the trailer has SFX (nothing plays before it — the context
    // would be born suspended).
    onGesture: () => sfx.unlock(),
    scenes: [
      supernovaOpen,
      calmOpen,
      pickup,
      levelUp,
      chainReactor,
      singularity,
      railgun,
      deployables,
      escalation1,
      lancerDuel,
      eliteBehaviours,
      shieldMods,
      beaconContested,
      pvpDuel,
      escalation2,
      deathBeat,
      bossApproach,
      bossKill,
      survivors,
    ],
  });
}
