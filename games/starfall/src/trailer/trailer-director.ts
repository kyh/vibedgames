import type Phaser from "phaser";
import { OFFLINE_PLAYER_ID } from "@vibedgames/multiplayer";
import type { Player, PlayerMap } from "@vibedgames/multiplayer";

import { sfx } from "../audio/sfx";
import { GameScene } from "../scenes/game-scene";
import { ENEMY_SPECS, xpToNext } from "../shared/constants";
import type { EnemyKind, EnemyState, ShieldModKind, Vec } from "../shared/constants";
import { runTrailer } from "./trailer-shell";
import type { TrailerScene } from "./trailer-shell";
import type { TrailerStageApi } from "./trailer-staging";

const TAU = Math.PI * 2;

/* oxlint-disable no-bitwise -- mulberry32 is int32 hash arithmetic */
const mulberry = (seed: number) => {
  let a = seed >>> 0;

  return () => {
    a = (a + 0x6d_2b_79_f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);

    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
};
/* oxlint-enable no-bitwise */

const angleTo = (from: Vec, to: Vec) => Math.atan2(to.y - from.y, to.x - from.x);

const wrapAngle = (a: number) => {
  let r = a % TAU;

  if (r > Math.PI) {
    r -= TAU;
  }

  if (r < -Math.PI) {
    r += TAU;
  }

  return r;
};

const dist = (a: Vec, b: Vec) => Math.hypot(a.x - b.x, a.y - b.y);
const lerp = (a: number, b: number, t: number) => a + (b - a) * Math.max(0, Math.min(1, t));

const ease = (t: number) => {
  const c = Math.max(0, Math.min(1, t));

  return c * c * (3 - 2 * c);
};

interface Bolt {
  x: number;
  y: number;
  vx: number;
  vy: number;
  traveled: number;
}

type CrewMode = "idle" | "combat" | "duel";

type PeerNetState = {
  x: number;
  y: number;
  angle: number;
  vx: number;
  vy: number;
  alive: boolean;
  present: boolean;
  level: number;
  shieldHp: number;
  sectorScore: number;
  weaponName: string;
  mod?: ShieldModKind;
  modOn?: boolean;
  phased?: boolean;
};

interface FakePeer {
  player: Player;
  state: PeerNetState;
  post: Vec;
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
}

const PEER_COLORS = ["#7ae0ff", "#ff7ad1", "#8dff9e", "#c9a2ff", "#ffd166"];
const PEER_TINTS = [0x7a_e0_ff, 0xff_7a_d1, 0x8d_ff_9e, 0xc9_a2_ff, 0xff_d1_66];
const BOLT_SPEED = 560;
const BOLT_RANGE = 740;
const BOLT_DAMAGE = 26;
const DUEL_BOLT_POWER = 0.35;

const show = (node: HTMLElement | null, on: boolean) => {
  if (node) {
    node.style.display = on ? "" : "none";
  }
};

const direct = (scene: GameScene) => {
  const api: TrailerStageApi = scene.trailerStage();
  const { staging } = api;
  const cam = scene.cameras.main;

  api.forceStart();

  sfx.muted = false;

  const hud = {
    boss: document.querySelector<HTMLElement>("#bossbar"),
    combo: document.querySelector<HTMLElement>("#combo"),
    countdown: document.querySelector<HTMLElement>("#countdown"),
    left: document.querySelector<HTMLElement>("#hud > div:first-of-type"),
    players: document.querySelector<HTMLElement>("#players"),
    pulse: document.querySelector<HTMLElement>("#pulse"),
    recap: document.querySelector<HTMLElement>("#recap"),
    right: document.querySelector<HTMLElement>("#hudright"),
    root: document.querySelector<HTMLElement>("#hud"),
  };

  const hudBaseline = () => {
    show(hud.root, false);
    show(hud.boss, false);
    show(hud.combo, false);
    show(hud.pulse, false);
    show(hud.recap, false);
    show(hud.left, true);
    show(hud.right, true);
    show(hud.players, true);
    show(hud.countdown, true);

    if (hud.boss) {
      hud.boss.style.top = "";
    }
  };

  hudBaseline();

  const camLock: Vec = { x: 0, y: 0 };
  let crew: FakePeer[] = [];
  let peerMap: PlayerMap | null = null;

  const steer = (angle: number, thrust: number) => {
    staging.steer = { angle, thrust };
  };

  const anchor = (dx: number, dy: number) => {
    const { w, h } = api.worldSize();

    return { x: w / 2 + dx, y: h / 2 + dy };
  };

  const edgeAnchor = (fromLeft: number, dy: number) => {
    const { h } = api.worldSize();

    return { x: fromLeft, y: h / 2 + dy };
  };

  const floorShield = (min = 85) => {
    const p = api.player();

    if (p.alive && p.shieldHp < min) {
      api.setShieldHp(min);
    }
  };

  const nearestEnemy = (
    from: Vec,
    maxD: number,
    exclude?: (e: Readonly<EnemyState>) => boolean,
  ) => {
    let best: Readonly<EnemyState> | null = null;
    let bestD = maxD;

    for (const e of api.enemies()) {
      if (exclude?.(e) === true) {
        continue;
      }

      const d = Math.hypot(e.x - from.x, e.y - from.y);

      if (d < bestD) {
        bestD = d;
        best = e;
      }
    }

    return best;
  };

  const engage = (range: number, thrust: number, fallback: number) => {
    const p = api.player();
    const e = nearestEnemy(p, range);
    steer(e ? angleTo(p, e) : fallback, thrust);
    staging.fire = e !== null;
  };

  const spawnRing = (
    rnd: () => number,
    kinds: readonly EnemyKind[],
    count: number,
    center: Vec,
    rMin: number,
    rMax: number,
    aimAt: Vec,
    arc?: { from: number; to: number },
  ) => {
    for (let i = 0; i < count; i += 1) {
      const span = arc ? arc.to - arc.from : TAU;
      const base = arc ? arc.from : 0;
      const ang = base + (span * (i + 0.5)) / count + (rnd() - 0.5) * (span / count) * 0.8;
      const r = rMin + rnd() * (rMax - rMin);
      const kind = kinds[i % kinds.length] ?? "drone";
      api.spawnEnemy(kind, center.x + Math.cos(ang) * r, center.y + Math.sin(ang) * r, aimAt);
    }
  };

  const spawnOval = (
    rnd: () => number,
    kinds: readonly EnemyKind[],
    count: number,
    center: Vec,
    rx: number,
    ry: number,
    aimAt: Vec,
  ) => {
    for (let i = 0; i < count; i += 1) {
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

  const halfFrame = () => ({ hh: 450 / cam.zoom, hw: 800 / cam.zoom });

  interface Keepout {
    x: number;
    y: number;
    r: number;
  }

  interface UV {
    u: number;
    v: number;
  }

  interface RockPlan {
    coverage: number;
    sample: (i: number, count: number) => UV;
  }

  type RockLayout =
    | { kind: "arc"; from: number; to: number; inner?: number; outer?: number }
    | { kind: "band"; angle: number; halfWidth?: number; length?: number; offset?: number }
    | { kind: "clump"; cx: number; cy: number; spread: number };

  interface RockField {
    at: Vec;
    layout: RockLayout;
    count?: number;
    rMin?: number;
    rMax?: number;
    keepOut?: readonly Keepout[];
  }

  const ROCK_AREA = 4300;

  const ROCK_COUNT_MAX = 96;

  const inPlayBounds = (x: number, y: number, r: number) => {
    const { w, h } = api.worldSize();

    return x > r + 40 && y > r + 40 && x < w - r - 40 && y < h - r - 40;
  };

  const dressRocks = (rnd: () => number, f: RockField) => {
    const { hw, hh } = halfFrame();
    const { layout } = f;

    const plan = (() => {
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
          } satisfies RockPlan;
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
          } satisfies RockPlan;
        }

        case "clump": {
          const { cx, cy, spread } = layout;

          return {
            coverage: Math.PI * spread * spread,
            sample: () => {
              const r = spread * Math.sqrt(rnd());
              const a = rnd() * TAU;

              return { u: cx + Math.cos(a) * r, v: cy + Math.sin(a) * r };
            },
          } satisfies RockPlan;
        }

        default: {
          return { coverage: 0, sample: () => ({ u: 0, v: 0 }) } satisfies RockPlan;
        }
      }
    })();

    const count =
      f.count ?? Math.min(ROCK_COUNT_MAX, Math.round((plan.coverage * hw * hh) / ROCK_AREA));

    const rMin = f.rMin ?? 50;
    const rMax = f.rMax ?? 80;
    const zones = f.keepOut ?? [];

    for (let i = 0; i < count; i += 1) {
      for (let attempt = 0; attempt < 4; attempt += 1) {
        const { u, v } = plan.sample(i, count);
        const radius = rMin + rnd() * (rMax - rMin);
        const x = f.at.x + u * hw;
        const y = f.at.y + v * hh;

        if (!inPlayBounds(x, y, radius)) {
          continue;
        }

        if (zones.some((z) => Math.hypot(z.x - x, z.y - y) < z.r + radius)) {
          continue;
        }

        api.spawnAsteroid(x, y, radius);
        break;
      }
    }
  };

  const boulder = (
    rnd: () => number,
    at: Vec,
    u: number,
    v: number,
    opts: { count?: number; spread?: number; rMin?: number; rMax?: number } = {},
  ) => {
    const { hw, hh } = halfFrame();
    const count = opts.count ?? 6;
    const spread = opts.spread ?? 78;
    const rMin = opts.rMin ?? 62;
    const rMax = opts.rMax ?? 80;
    const cx = at.x + u * hw;
    const cy = at.y + v * hh;

    for (let i = 0; i < count; i += 1) {
      const ang = i * 2.399963 + rnd() * 0.6;
      const r = spread * Math.sqrt((i + 0.35) / count);
      const radius = rMin + rnd() * (rMax - rMin);
      const x = cx + Math.cos(ang) * r;
      const y = cy + Math.sin(ang) * r;

      if (!inPlayBounds(x, y, radius)) {
        continue;
      }

      api.spawnAsteroid(x, y, radius);
    }
  };

  const corridor = (from: Vec, to: Vec, r = 60, steps = 5) => {
    const zones: Keepout[] = [];

    for (let i = 0; i <= steps; i += 1) {
      const f = i / steps;
      zones.push({ r, x: from.x + (to.x - from.x) * f, y: from.y + (to.y - from.y) * f });
    }

    return zones;
  };

  const spawnShardRing = (rnd: () => number, center: Vec, count: number, rMax: number) => {
    for (let i = 0; i < count; i += 1) {
      const ang = (TAU * (i + 0.5)) / count + (rnd() - 0.5) * 0.5;
      const r = rMax * (0.7 + 0.3 * rnd());
      api.spawnShards(1, center.x + Math.cos(ang) * r, center.y + Math.sin(ang) * r * 0.62);
    }
  };

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
  ) => {
    const state: PeerNetState = {
      alive: true,
      angle: opts.baseAim,
      level: opts.level,
      present: true,
      sectorScore: opts.score,
      shieldHp: 100,
      vx: 0,
      vy: 0,
      weaponName: "BEAM",
      x: post.x,
      y: post.y,
    };

    if (opts.mod) {
      state.mod = opts.mod;
      state.modOn = true;
      state.phased = false;
    }

    const player: Player = {
      color: PEER_COLORS[colorIdx % PEER_COLORS.length] ?? "#7ae0ff",
      id,
      state,
    };

    const peer: FakePeer = {
      angVel: opts.angVel,
      angle: opts.baseAim,
      baseAim: opts.baseAim,
      bolts: [],
      nextShotAt: opts.shotGapMs === Infinity ? Infinity : 200 + colorIdx * 90,
      orbitR: opts.orbitR,
      phase0: opts.phase0,
      player,
      post,
      postSpeed: 0,
      postTarget: null,
      shotGapMs: opts.shotGapMs ?? 240,
      state,
      tint: PEER_TINTS[colorIdx % PEER_TINTS.length] ?? 0x7a_e0_ff,
      x: post.x,
      y: post.y,
    };

    crew.push(peer);

    if (peerMap) {
      peerMap[id] = player;
    }

    return peer;
  };

  const installPeers = () => {
    peerMap = { [OFFLINE_PLAYER_ID]: { id: OFFLINE_PLAYER_ID } };
    staging.peers = peerMap;
  };

  const clearPeers = () => {
    for (const peer of crew) {
      api.stagePeerBolts(peer.player.id, null);
    }

    crew = [];
    peerMap = null;
    staging.peers = null;
  };

  const updateCrew = (t: number, dt: number, mode: CrewMode) => {
    const dts = dt / 1000;
    const me = api.player();

    for (const b of crew) {
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
      let target: Vec | null = null;

      if (mode === "duel") {
        target = me.alive ? { x: me.x, y: me.y } : null;
      } else if (mode === "combat") {
        target = nearestEnemy(b, 760);
      }

      b.angle = target ? angleTo(b, target) : b.baseAim;

      if (target && t >= b.nextShotAt) {
        b.nextShotAt = t + b.shotGapMs + (b.nextShotAt % 7) * 23;
        const nose = { x: b.x + Math.cos(b.angle) * 10, y: b.y + Math.sin(b.angle) * 10 };
        b.bolts.push({
          traveled: 0,
          vx: Math.cos(b.angle) * BOLT_SPEED,
          vy: Math.sin(b.angle) * BOLT_SPEED,
          x: nose.x,
          y: nose.y,
        });
      }

      const kept: Bolt[] = [];

      for (const bolt of b.bolts) {
        bolt.x += bolt.vx * dts;
        bolt.y += bolt.vy * dts;
        bolt.traveled += BOLT_SPEED * dts;

        if (bolt.traveled > BOLT_RANGE) {
          continue;
        }

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

        if (!hit) {
          kept.push(bolt);
        }
      }

      b.bolts = kept;
      const power = mode === "duel" ? DUEL_BOLT_POWER : 0.25;
      api.stagePeerBolts(
        b.player.id,
        b.bolts.map((bolt) => ({
          power,
          tint: b.tint,
          vx: bolt.vx,
          vy: bolt.vy,
          x: bolt.x,
          y: bolt.y,
        })),
      );
      b.state.x = b.x;
      b.state.y = b.y;
      b.state.angle = b.angle;
      b.state.vx = vx;
      b.state.vy = vy;
    }
  };

  const stage = () => {
    hudBaseline();
    api.clearWorld();
    api.clearAsteroids();
    clearPeers();
    staging.camPos = null;
    staging.steer = null;
    staging.fire = false;
    staging.deathless = true;
  };

  const sceneReset = () => {
    staging.steer = null;
    staging.fire = false;
    staging.camPos = null;
    clearPeers();
  };

  const SUPERNOVA_HOLD = 650;
  const SUPERNOVA_REFILL = 1400;
  let s1Reinforced = false;

  const supernovaOpen: TrailerScene = {
    duration: 2300,
    id: "supernova-open",
    run: (t) => {
      steer(-Math.PI / 2 + t * 0.0002, 0.02);
      staging.fire = t >= SUPERNOVA_HOLD;

      if (!s1Reinforced && t >= SUPERNOVA_REFILL) {
        s1Reinforced = true;
        const p = api.player();
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
    setup: () => {
      stage();
      s1Reinforced = false;
      cam.setZoom(1.35);
      show(hud.root, true);
      show(hud.left, false);
      show(hud.right, false);
      show(hud.combo, true);
      const a = anchor(-100, 0);
      const rnd = mulberry(5);
      api.setLevel(3);
      api.setPlayerPose({ angle: -Math.PI / 2, vx: 0, vy: 0, x: a.x, y: a.y });
      api.grantWeapon("SUPERNOVA");
      spawnOval(rnd, ["drone", "drone", "wasp"], 26, a, 290, 250, a);
      spawnOval(rnd, ["drone", "wasp"], 14, a, 180, 155, a);

      for (const face of [0, Math.PI]) {
        spawnRing(rnd, ["drone"], 11, a, 560, 760, a, {
          from: face - 1,
          to: face + 1,
        });
      }

      dressRocks(rnd, {
        at: a,
        count: 76,
        keepOut: [{ r: 375, x: a.x, y: a.y }],
        layout: { from: -1.2, inner: 0.58, kind: "arc", outer: 1.4, to: 1.2 },
        rMin: 50,
      });
      boulder(rnd, a, -0.98, 0.45, { count: 9, spread: 96 });
    },
    teardown: sceneReset,
  };

  const CALM_REFILL = 820;
  let s2Refilled = false;

  const calmOpen: TrailerScene = {
    duration: 2000,
    id: "calm-open",
    run: (t) => {
      const p = api.player();
      staging.camPos = { x: p.x + 28, y: p.y - 20 };

      if (!s2Refilled && t >= CALM_REFILL) {
        s2Refilled = true;
        const rr = mulberry(13);

        for (let i = 0; i < 14; i += 1) {
          api.spawnEnemy("drone", p.x + 130 + rr() * 210, p.y - 150 + rr() * 300, p);
        }

        for (let i = 0; i < 4; i += 1) {
          api.spawnEnemy("wasp", p.x + 190 + rr() * 150, p.y - 120 + rr() * 240, p);
        }
      }

      engage(610, 0.34, 0);
      api.setXp(0);
      floorShield();
    },
    setup: () => {
      stage();
      s2Refilled = false;
      cam.setZoom(2.5);
      const a = anchor(-800, -200);
      const rnd = mulberry(1);
      api.setLevel(1);
      api.setPlayerPose({ angle: 0, vx: 250, vy: 0, x: a.x, y: a.y });

      for (let i = 0; i < 32; i += 1) {
        api.spawnEnemy("drone", a.x + 96 + rnd() * 230, a.y - 102 + rnd() * 204, a);
      }

      api.spawnEnemy("drone", a.x + 170, a.y - 133, a);
      api.spawnEnemy("drone", a.x + 204, a.y + 126, a);
      api.spawnEnemy("wasp", a.x + 139, a.y + 71, a);
      api.spawnEnemy("wasp", a.x + 218, a.y - 61, a);
      api.spawnEnemy("wasp", a.x + 282, a.y + 27, a);
      api.spawnEnemy("wasp", a.x + 302, a.y - 82, a);
      const frame = { x: a.x + 204, y: a.y - 20 };
      dressRocks(rnd, {
        at: frame,
        keepOut: corridor(a, { x: a.x + 435, y: a.y }),
        layout: { angle: 0.18, halfWidth: 0.42, kind: "band", length: 1.85, offset: 0.76 },
        rMax: 52,
        rMin: 33,
      });
      boulder(rnd, frame, 0.85, -0.8, { count: 6, rMax: 48, rMin: 34, spread: 60 });
    },
    teardown: sceneReset,
  };

  let s3 = { crystal: { x: 0, y: 0 }, picked: false };

  const pickup: TrailerScene = {
    duration: 3000,
    id: "pickup",
    run: () => {
      const p = api.player();
      staging.camPos = { x: p.x + 122, y: p.y - 20 };

      if (!s3.picked) {
        s3.picked = p.weapon === "LASER";
      }

      if (s3.picked) {
        if (p.weapon !== "LASER") {
          api.grantWeapon("LASER");
        }

        engage(900, 0.16, 0);
      } else {
        steer(angleTo(p, s3.crystal), Math.min(0.9, dist(p, s3.crystal) / 120));
        staging.fire = false;
      }

      api.setXp(0);
      floorShield();
    },
    setup: () => {
      stage();
      cam.setZoom(1.6);
      show(hud.root, true);
      show(hud.right, false);
      const a = anchor(-200, -640);
      api.setLevel(1);
      api.setPlayerPose({ angle: 0, vx: 200, vy: 0, x: a.x, y: a.y });
      s3 = { crystal: { x: a.x + 142, y: a.y - 4 }, picked: false };
      api.spawnItem("weapon", "LASER", s3.crystal.x, s3.crystal.y);

      for (let i = 0; i < 8; i += 1) {
        api.spawnEnemy("drone", a.x + 268 + i * 34, a.y - 49 + i * 14, a);
      }

      for (let i = 0; i < 7; i += 1) {
        api.spawnEnemy("drone", a.x + 300 + i * 34, a.y + 78 + i * 12, a);
      }

      api.spawnEnemy("drone", a.x + 325, a.y + 122, a);
      api.spawnEnemy("drone", a.x + 382, a.y - 130, a);
      api.spawnEnemy("wasp", a.x + 382, a.y - 203, a);
      api.spawnEnemy("wasp", a.x + 439, a.y + 179, a);
      api.spawnEnemy("wasp", a.x + 325, a.y + 215, a);
      api.spawnEnemy("wasp", a.x + 466, a.y - 66, a);
      const frame = { x: a.x + 260, y: a.y - 20 };
      dressRocks(mulberry(31), {
        at: frame,
        count: 24,
        keepOut: corridor(a, { x: a.x + 560, y: a.y }, 90),
        layout: { from: -2.85, inner: 0.66, kind: "arc", outer: 1.2, to: -0.35 },
        rMax: 56,
        rMin: 32,
      });
      boulder(mulberry(32), frame, 0.82, 0.96, { count: 4, rMax: 54, rMin: 38, spread: 64 });
    },
    teardown: sceneReset,
  };

  const LEVEL_CUE = 1680;
  const ORB_DRIP_MS = 300;
  const ORB_RING_R = 245;
  let s4Rings = 0;
  let s4Leveled = false;
  let s4Rnd = mulberry(22);

  const levelUp: TrailerScene = {
    duration: 2000,
    id: "level-up",
    run: (t) => {
      const wobble = 0.15 * Math.sin(t * 0.002);
      steer(-Math.PI / 2 + wobble, 0.12);
      staging.fire = false;
      const drip = Math.floor(t / ORB_DRIP_MS);

      if (drip > s4Rings && t < LEVEL_CUE) {
        s4Rings = drip;
        spawnShardRing(s4Rnd, api.player(), 18, ORB_RING_R);
      }

      if (t < LEVEL_CUE) {
        api.setXp(0);
      } else if (!s4Leveled) {
        s4Leveled = true;
        api.grantXp(xpToNext(1));
      }

      floorShield();
    },
    setup: () => {
      stage();
      s4Rings = 0;
      s4Leveled = false;
      s4Rnd = mulberry(22);
      cam.setZoom(2);
      show(hud.root, true);
      show(hud.right, false);
      const a = anchor(600, 260);
      api.setLevel(1, 0);
      api.setPlayerPose({ angle: -Math.PI / 2, vx: 0, vy: -60, x: a.x, y: a.y });
      api.grantBooster("magnet");
      spawnShardRing(mulberry(2), a, 22, ORB_RING_R);
      boulder(mulberry(41), a, 0.92, -0.15, { count: 23, spread: 192 });
      boulder(mulberry(43), a, -0.28, 0.94, { count: 11, spread: 116 });
      dressRocks(mulberry(42), {
        at: a,
        keepOut: corridor(a, { x: a.x, y: a.y - 230 }, 70),
        layout: { cx: -0.76, cy: 0.6, kind: "clump", spread: 0.62 },
        rMax: 60,
        rMin: 24,
      });
    },
    teardown: sceneReset,
  };

  const CHAIN_LEAD = 156;
  const CHAIN_REFILL = 1150;
  let s5Refilled = false;

  const chainReactor: TrailerScene = {
    duration: 2400,
    id: "chain-reactor",
    run: (t) => {
      const p = api.player();
      staging.camPos = { x: p.x + CHAIN_LEAD, y: p.y - 18 };

      if (!s5Refilled && t >= CHAIN_REFILL) {
        s5Refilled = true;
        const rr = mulberry(35);

        for (let i = 0; i < 14; i += 1) {
          api.spawnEnemy("drone", p.x + 250 + rr() * 190, p.y - 190 + rr() * 380, p);
        }

        for (let i = 0; i < 5; i += 1) {
          api.spawnEnemy("wasp", p.x + 230 + rr() * 160, p.y - 150 + rr() * 300, p);
        }
      }

      const e = nearestEnemy(p, 900);

      if (e) {
        steer(angleTo(p, e), 0.06);
      } else {
        steer(0, 0.1);
      }

      staging.fire = e !== null && dist(p, e) <= 440;
      floorShield();
    },
    setup: () => {
      stage();
      s5Refilled = false;
      cam.setZoom(2.15);
      const a = anchor(-400, 250);
      const rnd = mulberry(3);
      api.setLevel(3);
      api.setPlayerPose({ angle: 0, vx: 0, vy: 0, x: a.x, y: a.y });
      api.grantWeapon("CHAIN REACTOR");

      for (let i = 0; i < 16; i += 1) {
        api.spawnEnemy("drone", a.x + 180 + rnd() * 100, a.y - 180 + rnd() * 360, a);
      }

      for (let i = 0; i < 8; i += 1) {
        api.spawnEnemy("wasp", a.x + 215 + rnd() * 90, a.y - 160 + rnd() * 320, a);
      }

      for (let i = 0; i < 12; i += 1) {
        api.spawnEnemy("drone", a.x + 300 + rnd() * 130, a.y - 150 + rnd() * 300, a);
      }

      const frame = { x: a.x + CHAIN_LEAD, y: a.y - 18 };
      dressRocks(rnd, {
        at: frame,
        count: 18,
        keepOut: corridor(a, { x: a.x + 430, y: a.y }, 60, 7),
        layout: { angle: Math.PI / 2, halfWidth: 0.2, kind: "band", length: 1.5, offset: -0.82 },
        rMax: 42,
        rMin: 30,
      });
      boulder(mulberry(33), frame, -1.02, 0.58, { count: 7, rMax: 46, rMin: 32, spread: 60 });
      boulder(mulberry(34), frame, -0.72, -0.94, { count: 5, rMax: 42, rMin: 30, spread: 48 });
    },
    teardown: sceneReset,
  };

  const SINGULARITY_REFILL = 1250;
  let s6 = { knot: { x: 0, y: 0 }, refilled: false };

  const singularity: TrailerScene = {
    duration: 2400,
    id: "singularity",
    run: (t) => {
      const p = api.player();

      if (!s6.refilled && t >= SINGULARITY_REFILL) {
        s6.refilled = true;
        spawnRing(mulberry(153), ["drone", "wasp", "drone"], 16, s6.knot, 190, 280, s6.knot, {
          from: -1,
          to: 1,
        });
      }

      steer(angleTo(p, s6.knot), 0.04);
      staging.fire = true;

      if (p.weapon !== "SINGULARITY") {
        api.grantWeapon("SINGULARITY");
      }

      floorShield();
    },
    setup: () => {
      stage();
      cam.setZoom(1.9);
      const a = anchor(-100, 40);
      const rnd = mulberry(15);
      api.setLevel(3);
      api.setPlayerPose({ angle: 0, vx: 0, vy: 0, x: a.x, y: a.y });
      api.grantWeapon("SINGULARITY");
      const k = { x: a.x + 330, y: a.y - 20 };
      s6 = { knot: k, refilled: false };
      spawnOval(rnd, ["drone", "drone", "wasp"], 26, k, 105, 88, a);
      spawnOval(rnd, ["drone", "wasp"], 16, k, 175, 145, a);
      api.spawnAsteroid(k.x - 76, k.y - 60, 36);
      api.spawnAsteroid(k.x + 82, k.y + 44, 40);
      api.spawnAsteroid(k.x + 25, k.y + 88, 32);
      api.spawnAsteroid(k.x - 38, k.y + 104, 42);
      const frame = { x: k.x - 165, y: k.y + 10 };
      dressRocks(rnd, {
        at: frame,
        keepOut: [{ r: 240, x: k.x, y: k.y }, ...corridor(a, k, 44)],
        layout: { angle: -0.72, halfWidth: 0.58, kind: "band", length: 1.8 },
        rMax: 52,
        rMin: 34,
      });
      boulder(mulberry(151), frame, -0.34, 1.02, { count: 6, rMax: 56, rMin: 40, spread: 53 });
      boulder(mulberry(152), frame, 1.06, -0.32, { count: 7, rMax: 58, rMin: 42, spread: 62 });
      camLock.x = frame.x;
      camLock.y = frame.y;
      staging.camPos = camLock;
    },
    teardown: sceneReset,
  };

  const RAILGUN_LANE = -0.51;

  const railgun: TrailerScene = {
    duration: 2200,
    id: "railgun",
    run: () => {
      const p = api.player();
      staging.camPos = { x: p.x + 295, y: p.y - 142 };
      steer(RAILGUN_LANE, 0.05);
      staging.fire = true;
      floorShield();
    },
    setup: () => {
      stage();
      cam.setZoom(1.9);
      const a = anchor(300, 500);
      api.setLevel(3);
      api.setPlayerPose({ angle: RAILGUN_LANE, vx: 0, vy: 0, x: a.x, y: a.y });
      api.grantWeapon("RAILGUN");
      api.grantBooster("overdrive");
      const cos = Math.cos(RAILGUN_LANE);
      const sin = Math.sin(RAILGUN_LANE);

      const lane = (d: number, lat: number) => ({
        x: a.x + cos * d - sin * lat,
        y: a.y + sin * d + cos * lat,
      });

      for (let i = 0; i < 7; i += 1) {
        const q = lane(150 + i * 68, -34 + i * 6);
        api.spawnEnemy("drone", q.x, q.y, a);
      }

      for (let i = 0; i < 6; i += 1) {
        const q = lane(190 + i * 74, 74 + i * 9);
        api.spawnEnemy("drone", q.x, q.y, a);
      }

      for (let i = 0; i < 5; i += 1) {
        const q = lane(180 + i * 66, -105 - i * 4);
        api.spawnEnemy("drone", q.x, q.y, a);
      }

      const w1 = lane(430, 215);
      const w2 = lane(520, -90);
      api.spawnEnemy("wasp", w1.x, w1.y, a);
      api.spawnEnemy("wasp", w2.x, w2.y, a);
    },
    teardown: sceneReset,
  };

  let s8 = { sentry: false, turret: { x: 0, y: 0 }, wave: false };

  const deployables: TrailerScene = {
    duration: 2600,
    id: "deployables",
    run: (t) => {
      const p = api.player();

      if (!s8.sentry && t >= 1300) {
        s8.sentry = true;
        api.grantWeapon("SENTRY");
        s8.turret = { x: p.x, y: p.y };
      }

      if (s8.sentry && !s8.wave && t >= 1550) {
        s8.wave = true;
        spawnRing(mulberry(181), ["wasp", "drone"], 12, s8.turret, 150, 260, s8.turret);
      }

      if (s8.sentry) {
        steer(0.42, 0.85);
        staging.fire = t < 1450;
        cam.setZoom(lerp(1.9, 2.25, ease((t - 1300) / 900)));
        staging.camPos = {
          x: s8.turret.x + (p.x - s8.turret.x) * 0.36,
          y: s8.turret.y + (p.y - s8.turret.y) * 0.36,
        };
      } else {
        steer(0.5 + Math.sin(t * 0.0024) * 0.45, 0.2);
        staging.fire = true;
        staging.camPos = { x: p.x - 130, y: p.y - 30 };
      }

      floorShield(130);
    },
    setup: () => {
      stage();
      s8 = { sentry: false, turret: { x: 0, y: 0 }, wave: false };
      cam.setZoom(1.9);
      const a = anchor(1000, 500);
      const rnd = mulberry(18);
      api.setLevel(3);
      api.setPlayerPose({ angle: 0, vx: 120, vy: 0, x: a.x, y: a.y });
      api.grantWeapon("MINES");
      spawnRing(rnd, ["wasp"], 8, a, 86, 150, a, { from: Math.PI * 0.55, to: Math.PI * 1.45 });
      spawnRing(rnd, ["drone"], 12, a, 122, 214, a, { from: Math.PI * 0.5, to: Math.PI * 1.5 });
      spawnRing(rnd, ["drone", "wasp"], 7, a, 178, 257, a, { from: -0.9, to: 0.9 });
    },
    teardown: sceneReset,
  };

  let s9Reinforced = false;

  const escalation1: TrailerScene = {
    duration: 2800,
    id: "escalation-1",
    run: (t) => {
      cam.setZoom(lerp(1.75, 2.05, ease(t / 2800)));
      const p = api.player();

      if (!s9Reinforced && t >= 1400) {
        s9Reinforced = true;
        spawnRing(mulberry(66), ["drone"], 14, p, 262, 354, p, { from: -0.9, to: 0.9 });
      }

      const dir = t * 0.00016;
      const cycle = t % 760;

      if (cycle < 460) {
        steer(dir, 0.8);
        staging.fire = false;
        staging.camPos = { x: p.x - 60, y: p.y };
      } else {
        const e = nearestEnemy(p, 700);
        steer(e ? angleTo(p, e) : dir + Math.PI, 0.05);
        staging.fire = true;
        staging.camPos = null;
      }

      floorShield(130);
    },
    setup: () => {
      stage();
      s9Reinforced = false;
      cam.setZoom(1.75);
      const a = anchor(-400, 150);
      const rnd = mulberry(6);
      api.setLevel(3);
      api.setPlayerPose({ angle: 0, vx: 181, vy: 0, x: a.x, y: a.y });
      api.grantWeapon("SEEKER SWARM");
      api.grantBooster("twin");
      spawnRing(rnd, ["drone"], 24, a, 197, 342, a, { from: Math.PI * 0.55, to: Math.PI * 1.45 });
      spawnRing(rnd, ["wasp"], 8, a, 164, 262, a, { from: Math.PI * 0.6, to: Math.PI * 1.4 });
      api.spawnEnemy("splitter", a.x - 243, a.y - 72, a);
      api.spawnEnemy("splitter", a.x - 262, a.y + 99, a);
      const frame = { x: a.x + 380, y: a.y };
      dressRocks(rnd, {
        at: frame,
        keepOut: corridor(a, { x: a.x + 980, y: a.y + 140 }, 60, 8),
        layout: { angle: 0.15, halfWidth: 0.5, kind: "band", length: 2, offset: -0.55 },
        rMax: 56,
        rMin: 30,
      });
      boulder(mulberry(67), frame, 0.15, 1.05, { count: 6, rMax: 58, rMin: 42, spread: 65 });
      boulder(mulberry(68), frame, -0.85, 0.92, { count: 5, rMax: 58, rMin: 42, spread: 60 });
    },
    teardown: sceneReset,
  };

  const LANCER_LEAD = 36;
  const LANCER_REFILL = 1200;
  let s10 = { dodgeUntil: -1, dodged: false, finished: false, lancerId: "", refilled: false };

  const lancerDuel: TrailerScene = {
    duration: 2600,
    id: "lancer-duel",
    run: (t) => {
      const p = api.player();
      staging.camPos = { x: p.x + LANCER_LEAD, y: p.y };

      if (!s10.refilled && t >= LANCER_REFILL) {
        s10.refilled = true;
        const rr = mulberry(77);

        for (let i = 0; i < 11; i += 1) {
          api.spawnEnemy("drone", p.x + 150 + rr() * 210, p.y - 190 + rr() * 380, p);
        }

        for (let i = 0; i < 3; i += 1) {
          api.spawnEnemy("wasp", p.x + 210 + rr() * 150, p.y - 150 + rr() * 300, p);
        }
      }

      const lancer = api.enemies().find((e) => e.id === s10.lancerId && e.hp > 0);
      const charging = lancer !== undefined && Math.hypot(lancer.vx, lancer.vy) > 400;

      if (charging && !s10.dodged && t >= 700) {
        s10.dodged = true;
        s10.dodgeUntil = t + 380;
      }

      if (t < s10.dodgeUntil) {
        if (lancer) {
          steer(angleTo(p, lancer) + Math.PI / 2, 1);
        }

        staging.fire = false;
      } else if (lancer) {
        const opener = t < 600 ? nearestEnemy(p, 372, (e) => e.kind === "lancer") : null;
        const target = opener ?? lancer;
        steer(angleTo(p, target), 0.08);
        staging.fire = true;

        if (t > 1900 && !s10.finished) {
          s10.finished = true;
          api.damageEnemy(lancer.id, lancer.hp + 10);
        }
      } else {
        engage(521, 0.2, 0);
      }

      floorShield();
    },
    setup: () => {
      stage();
      s10 = { dodgeUntil: -1, dodged: false, finished: false, lancerId: "", refilled: false };
      cam.setZoom(2.15);
      const a = anchor(-900, 100);
      const rnd = mulberry(7);
      api.setLevel(3);
      api.setPlayerPose({ angle: 0, vx: 60, vy: 0, x: a.x, y: a.y });

      for (let i = 0; i < 20; i += 1) {
        api.spawnEnemy("drone", a.x + 97 + rnd() * 186, a.y - 130 + rnd() * 260, a);
      }

      for (let i = 0; i < 5; i += 1) {
        api.spawnEnemy("wasp", a.x + 141 + rnd() * 156, a.y - 97 + rnd() * 193, a);
      }

      s10.lancerId = api.spawnEnemy("lancer", a.x + 238, a.y, a);
      api.setEnemyHp(s10.lancerId, 420);
      const frame = { x: a.x + LANCER_LEAD, y: a.y };
      dressRocks(rnd, {
        at: frame,
        count: 18,
        keepOut: corridor(a, { x: a.x + 149, y: a.y }, 67),
        layout: { from: 2.5, inner: 0.62, kind: "arc", outer: 1.4, to: 4.1 },
        rMax: 46,
        rMin: 24,
      });
      boulder(mulberry(72), frame, -0.8, 0.84, { count: 9, rMax: 60, rMin: 46, spread: 95 });
      boulder(mulberry(74), frame, 0.9, -0.62, { count: 9, rMax: 60, rMin: 46, spread: 89 });
      boulder(mulberry(76), frame, 1.04, 0.3, { count: 7, rMax: 58, rMin: 44, spread: 78 });
    },
    teardown: sceneReset,
  };

  let s11 = { popped: false, splitterId: "", wardenId: "" };

  const eliteBehaviours: TrailerScene = {
    duration: 2600,
    id: "elite-behaviours",
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
        api.killEnemy(splitter.id);
      }

      floorShield();
    },
    setup: () => {
      stage();
      s11 = { popped: false, splitterId: "", wardenId: "" };
      cam.setZoom(2);
      const a = anchor(-1200, -400);
      api.setLevel(3);
      api.setPlayerPose({ angle: 0, vx: 0, vy: 0, x: a.x - 29, y: a.y + 44 });
      s11.wardenId = api.spawnEnemy("warden", a.x + 170, a.y + 15, a);
      api.setEnemyHp(s11.wardenId, 600);
      api.spawnEnemy("spawner", a.x - 170, a.y - 127, a);
      s11.splitterId = api.spawnEnemy("splitter", a.x + 76, a.y + 141, a);
      const rnd = mulberry(21);

      for (let i = 0; i < 44; i += 1) {
        api.spawnEnemy("drone", a.x - 260 + rnd() * 640, a.y - 172 + rnd() * 344, a);
      }

      for (let i = 0; i < 13; i += 1) {
        api.spawnEnemy("wasp", a.x - 160 + rnd() * 430, a.y - 125 + rnd() * 250, a);
      }

      const frame = { x: a.x - 40, y: a.y };
      dressRocks(rnd, {
        at: frame,
        keepOut: corridor({ x: a.x - 29, y: a.y + 44 }, { x: a.x + 145, y: a.y + 44 }, 58),
        layout: { cx: -0.68, cy: 0.66, kind: "clump", spread: 0.6 },
        rMax: 54,
        rMin: 32,
      });
      boulder(mulberry(211), frame, 0.95, -0.85, { count: 7, rMax: 58, rMin: 44, spread: 71 });
      boulder(mulberry(213), frame, 1.06, 0.34, { count: 6, rMax: 56, rMin: 42, spread: 66 });
      camLock.x = frame.x;
      camLock.y = frame.y;
      staging.camPos = camLock;
    },
    teardown: sceneReset,
  };

  const RAM_LANE_ANGLE = 0.28;
  const REFLECT_MS = 1600;
  let s12 = { lane: { x: 0, y: 0 }, ram: false };

  const shieldMods: TrailerScene = {
    duration: 3000,
    id: "shield-mods",
    run: (t) => {
      const p = api.player();

      if (!s12.ram && t >= REFLECT_MS) {
        s12.ram = true;
        api.grantShieldMod("ram");
      }

      if (s12.ram) {
        staging.camPos = { x: p.x + 89, y: p.y + 15 };
        steer(angleTo(p, s12.lane), 1);
        staging.fire = false;
        api.grantShieldMod("ram");
      } else {
        staging.camPos = { x: p.x - 111, y: p.y };
        const e = nearestEnemy(p, 900, (en) => en.kind === "sniper" || en.x > p.x - 40);
        steer(e ? angleTo(p, e) : Math.PI, 0);
        staging.fire = e !== null;
      }

      floorShield(130);
    },
    setup: () => {
      stage();
      cam.setZoom(1.75);
      show(hud.root, true);
      show(hud.right, false);
      const a = anchor(600, -300);
      const rnd = mulberry(26);
      api.setLevel(3);
      api.setPlayerPose({ angle: 0, vx: 0, vy: 0, x: a.x, y: a.y });
      api.grantShieldMod("reflect");
      api.setShieldHp(100);
      const cos = Math.cos(RAM_LANE_ANGLE);
      const sin = Math.sin(RAM_LANE_ANGLE);
      const lane = (d: number) => ({ x: a.x + cos * d, y: a.y + sin * d });
      s12 = { lane: lane(700), ram: false };
      api.spawnEnemy("sniper", a.x - 245, a.y - 123, a);
      api.spawnEnemy("sniper", a.x - 279, a.y + 15, a);
      api.spawnEnemy("sniper", a.x - 234, a.y + 145, a);

      for (let i = 0; i < 13; i += 1) {
        api.spawnEnemy("drone", a.x - 380 + rnd() * 330, a.y - 208 + rnd() * 416, a);
      }

      for (let i = 0; i < 7; i += 1) {
        api.spawnEnemy("wasp", a.x - 280 + rnd() * 140, a.y - 163 + rnd() * 327, a);
      }

      const rockA = lane(145);
      const rockB = lane(200);
      api.spawnAsteroid(rockA.x, rockA.y, 24);
      api.spawnAsteroid(rockB.x, rockB.y, 22);

      for (const d of [400, 470, 540]) {
        const q = lane(d);
        api.spawnEnemy("drone", q.x, q.y, a);
      }

      const frame = { x: a.x + 30, y: a.y };
      dressRocks(rnd, {
        at: frame,
        count: 24,
        keepOut: [...corridor(a, lane(760), 71, 7), ...corridor({ x: a.x - 300, y: a.y }, a, 82)],
        layout: { from: -2.75, inner: 0.6, kind: "arc", outer: 1.18, to: -0.4 },
        rMax: 54,
        rMin: 42,
      });
      boulder(mulberry(261), frame, -0.82, -1, { count: 5, rMax: 54, rMin: 42, spread: 56 });
      boulder(mulberry(265), frame, -0.95, 0.72, { count: 6, rMax: 54, rMin: 42, spread: 58 });
      const closing = { x: a.x + 620, y: a.y + 178 };
      dressRocks(mulberry(263), {
        at: closing,
        count: 16,
        keepOut: corridor(a, lane(1000), 74, 9),
        layout: { angle: RAM_LANE_ANGLE, halfWidth: 0.18, kind: "band", length: 1, offset: 0.62 },
        rMax: 52,
        rMin: 42,
      });
    },
    teardown: sceneReset,
  };

  let s13 = { beacon: { x: 0, y: 0 }, broke: false, rusher: -1, wave2: false, wave3: false };

  const beaconContested: TrailerScene = {
    duration: 3400,
    id: "beacon-contested",
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
          rusher.postTarget = { x: s13.beacon.x + 200, y: s13.beacon.y - 80 };
          rusher.postSpeed = 300;
        }
      }

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

      floorShield(130);
    },
    setup: () => {
      stage();
      const b = anchor(0, -250);
      s13 = { beacon: b, broke: false, rusher: -1, wave2: false, wave3: false };
      cam.setZoom(1.05);
      camLock.x = b.x;
      camLock.y = b.y;
      staging.camPos = camLock;
      api.setLevel(3);
      api.setPlayerPose({ angle: -Math.PI / 2, vx: -40, vy: 0, x: b.x - 40, y: b.y + 150 });
      api.spawnBeacon(b.x, b.y, 0.6, 40);
      installPeers();

      const posts: Vec[] = [
        { x: b.x - 545, y: b.y - 115 },
        { x: b.x - 480, y: b.y + 230 },
        { x: b.x + 500, y: b.y - 215 },
        { x: b.x + 560, y: b.y + 105 },
      ];

      for (const [i, post] of posts.entries()) {
        addPeer(`wing-${i + 1}`, i, post, {
          angVel: 2,
          baseAim: angleTo(post, b),
          level: 2 + (i % 2),
          orbitR: 45,
          phase0: i * 1.4,
          score: 150 + i * 40,
        });
      }

      s13.rusher = 2;
      const rnd = mulberry(8);
      spawnRing(rnd, ["drone"], 12, b, 320, 430, b);
      spawnRing(rnd, ["drone"], 6, b, 470, 560, b);
      spawnRing(rnd, ["wasp"], 8, b, 520, 660, b);
      dressRocks(rnd, {
        at: b,
        keepOut: [{ r: 445, x: b.x, y: b.y }],
        layout: { from: 0.18, inner: 0.66, kind: "arc", outer: 1.4, to: 3.15 },
        rMin: 40,
      });
      boulder(mulberry(82), b, 0.42, 1.12, { count: 7, spread: 92 });
    },
    teardown: sceneReset,
  };

  let s14 = { dead: false, rammed: false, rammer: -1, ramming: false, rivalHp: 100 };

  const pvpDuel: TrailerScene = {
    duration: 2800,
    id: "pvp-duel",
    run: (t, dt) => {
      const p = api.player();
      const [rival] = crew;
      const rammer = crew[s14.rammer];

      if (rammer) {
        if (!s14.ramming && t >= 1400) {
          s14.ramming = true;
        }

        if (s14.ramming && !s14.rammed) {
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
        staging.camPos = { x: (p.x + rival.x) / 2, y: (p.y + rival.y) / 2 };
        steer(angleTo(p, rival), 0.35);
        staging.fire = t > 260;

        if (t > 400) {
          s14.rivalHp = Math.max(0, s14.rivalHp - (dt / 1000) * 105);
          rival.state.shieldHp = s14.rivalHp;
        }

        if (s14.rivalHp <= 0 || t > 1400) {
          s14.dead = true;
          rival.state.alive = false;
          api.stagePeerBolts(rival.player.id, null);
        }
      } else {
        staging.camPos = rammer ? { x: (p.x + rammer.x) / 2, y: (p.y + rammer.y) / 2 } : null;
        steer(rammer ? angleTo(p, rammer) : 0, 0.5);
        staging.fire = true;
      }

      floorShield(60);
    },
    setup: () => {
      stage();
      s14 = { dead: false, rammed: false, rammer: -1, ramming: false, rivalHp: 100 };
      cam.setZoom(2.4);
      const a = anchor(260, 120);
      api.setLevel(3);
      api.setPlayerPose({ angle: 0, vx: 0, vy: 0, x: a.x, y: a.y });
      api.setShieldHp(100);
      api.spawnAsteroid(a.x + 199, a.y + 135, 55);
      api.spawnAsteroid(a.x + 23, a.y - 169, 34);
      installPeers();
      addPeer(
        "rival",
        1,
        { x: a.x + 98, y: a.y - 19 },
        {
          angVel: 1.9,
          baseAim: Math.PI,
          level: 3,
          orbitR: 86,
          phase0: -0.6,
          score: 410,
          shotGapMs: 430,
        },
      );

      const rammer = addPeer(
        "raider",
        4,
        { x: a.x + 450, y: a.y + 158 },
        {
          angVel: 0,
          baseAim: Math.PI,
          level: 3,
          mod: "ram",
          orbitR: 0,
          phase0: 0,
          score: 260,
          shotGapMs: Infinity,
        },
      );

      rammer.postSpeed = 525;
      s14.rammer = crew.indexOf(rammer);
      const frame = { x: a.x + 158, y: a.y + 53 };
      dressRocks(mulberry(71), {
        at: frame,
        keepOut: [{ r: 131, x: a.x + 83, y: a.y - 11 }],
        layout: { angle: 0.42, halfWidth: 0.82, kind: "band", length: 2.4 },
        rMax: 58,
        rMin: 32,
      });
      boulder(mulberry(73), frame, -0.98, -0.86, { count: 7, rMax: 58, rMin: 44, spread: 74 });
    },
    teardown: sceneReset,
  };

  const ESC2_WAVES: readonly number[] = [900, 1850];
  let s15Waves = 0;

  const escalation2: TrailerScene = {
    duration: 2800,
    id: "escalation-2",
    run: (t) => {
      const p = api.player();
      const due = ESC2_WAVES[s15Waves];

      if (due !== undefined && t >= due) {
        s15Waves += 1;
        const rr = mulberry(93 + s15Waves);
        spawnOval(rr, ["drone", "wasp", "drone"], 18, { x: p.x + 90, y: p.y + 330 }, 300, 235, p);
      }

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

      floorShield(130);
    },
    setup: () => {
      stage();
      s15Waves = 0;
      cam.setZoom(1.5);
      const a = edgeAnchor(330, -350);
      const rnd = mulberry(9);
      api.setLevel(3);
      api.setPlayerPose({ angle: Math.PI / 2, vx: 0, vy: 191, x: a.x, y: a.y });
      const c = { x: a.x + 150, y: a.y };
      spawnOval(rnd, ["drone"], 34, c, 345, 279, a);
      spawnOval(rnd, ["wasp"], 16, c, 293, 242, a);
      spawnOval(rnd, ["wasp"], 10, a, 154, 139, a);
      api.spawnEnemy("sniper", a.x + 381, a.y - 220, a);
      api.spawnEnemy("sniper", a.x + 411, a.y + 205, a);
      api.spawnEnemy("sniper", a.x + 249, a.y - 279, a);
      api.spawnEnemy("splitter", a.x + 249, a.y - 110, a);
      api.spawnEnemy("splitter", a.x - 139, a.y + 128, a);
      api.spawnEnemy("lancer", a.x + 345, a.y + 73, a);
      api.spawnEnemy("lancer", a.x - 95, a.y - 95, a);
      const frame = { x: a.x + 110, y: a.y + 350 };
      dressRocks(rnd, {
        at: frame,
        keepOut: corridor(a, { x: a.x, y: a.y + 760 }, 62, 7),
        layout: { angle: 1.42, halfWidth: 0.55, kind: "band", length: 2, offset: -0.62 },
        rMax: 58,
        rMin: 40,
      });
      boulder(mulberry(91), frame, 0.72, -0.95, { count: 6, rMax: 58, rMin: 42, spread: 65 });
    },
    teardown: sceneReset,
  };

  let s16Killed = false;

  const deathBeat: TrailerScene = {
    duration: 1900,
    id: "death-beat",
    run: (t) => {
      const p = api.player();

      if (!p.alive) {
        staging.steer = null;
        staging.fire = false;

        return;
      }

      if (t < 550) {
        steer(0.9, 1);
      } else {
        steer(Math.PI + 0.6, 0.95);
      }

      staging.fire = false;

      if (!s16Killed && t > 1450) {
        s16Killed = true;
        api.killPlayer("WASP");
      }
    },
    setup: () => {
      stage();
      s16Killed = false;
      cam.setZoom(1.85);
      show(hud.countdown, false);
      const a = anchor(300, -100);
      const rnd = mulberry(10);
      api.setLevel(2, 30);
      api.setPlayerPose({ angle: 0.3, vx: 152, vy: -45, x: a.x, y: a.y });
      api.setShieldHp(30);
      api.grantBooster("nitro");
      spawnOval(rnd, ["drone"], 22, a, 152, 125, a);
      spawnOval(rnd, ["wasp"], 14, a, 189, 155, a);
      boulder(rnd, a, -0.72, 0.16, { count: 17, rMax: 60, rMin: 44, spread: 118 });
      boulder(rnd, a, 1, -0.22, { count: 17, rMax: 60, rMin: 44, spread: 118 });
      dressRocks(rnd, {
        at: a,
        keepOut: [
          ...corridor(a, { x: a.x + 280, y: a.y + 224 }, 61),
          ...corridor(a, { x: a.x - 280, y: a.y + 168 }, 61),
        ],
        layout: { cx: 0.08, cy: -0.94, kind: "clump", spread: 0.55 },
        rMax: 44,
        rMin: 26,
      });
      dressRocks(mulberry(101), {
        at: a,
        keepOut: [
          ...corridor(a, { x: a.x + 280, y: a.y + 224 }, 61),
          ...corridor(a, { x: a.x - 280, y: a.y + 168 }, 61),
        ],
        layout: { cx: -0.12, cy: 1, kind: "clump", spread: 0.46 },
        rMax: 44,
        rMin: 26,
      });
    },
    teardown: sceneReset,
  };

  let s17 = { bossId: "", flipped: false, wave2: false, wave3: false };
  const APPROACH_BIAS = 0.34;

  const bossApproach: TrailerScene = {
    duration: 5000,
    id: "boss-approach",
    run: (t, dt) => {
      updateCrew(t, dt, "combat");
      const p = api.player();
      const boss = api.enemies().find((e) => e.id === s17.bossId);

      if (boss) {
        camLock.x = p.x + (boss.x - p.x) * APPROACH_BIAS;
        camLock.y = p.y + (boss.y - p.y) * APPROACH_BIAS;

        if (!s17.flipped && t >= 800) {
          s17.flipped = true;
          api.setEnemyHp(boss.id, boss.maxHp * 0.5);
        }
      }

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
        steer(angleTo(p, boss), 0.25);
      } else if (e) {
        steer(angleTo(p, e), 0.2);
      } else {
        steer(Math.PI - 0.44, 0.35);
      }

      staging.fire = true;
      floorShield(130);
    },
    setup: () => {
      stage();
      s17 = { bossId: "", flipped: false, wave2: false, wave3: false };
      cam.setZoom(1);
      const a = anchor(500, 0);
      const rnd = mulberry(17);
      api.setLevel(3);
      const start = { angle: Math.PI - 0.44, vx: -40, vy: 0, x: a.x + 260, y: a.y - 150 };
      api.setPlayerPose(start);
      api.grantWeapon("DRILL");
      installPeers();
      addPeer(
        "wing-a",
        0,
        { x: a.x + 480, y: a.y - 330 },
        {
          angVel: 1.2,
          baseAim: Math.PI - 0.44,
          level: 3,
          orbitR: 55,
          phase0: 0.4,
          score: 380,
        },
      );
      addPeer(
        "wing-b",
        2,
        { x: a.x + 620, y: a.y + 60 },
        {
          angVel: -1.1,
          baseAim: Math.PI - 0.44,
          level: 2,
          orbitR: 55,
          phase0: 2.1,
          score: 240,
        },
      );
      s17.bossId = api.spawnEnemy("dreadnought", a.x - 300, a.y + 115, start);
      spawnOval(rnd, ["drone", "wasp"], 20, { x: a.x + 480, y: a.y + 20 }, 330, 270, start);
      const frame = { x: a.x + 70, y: a.y - 60 };
      dressRocks(rnd, {
        at: frame,
        count: 80,
        keepOut: [
          { r: 250, x: a.x - 300, y: a.y + 115 },
          ...corridor(start, { x: a.x - 300, y: a.y + 115 }, 90),
        ],
        layout: { from: -2, inner: 0.6, kind: "arc", outer: 1.75, to: -0.35 },
        rMin: 48,
      });
      boulder(rnd, frame, 0.94, -1.02, { count: 12, spread: 114 });
      boulder(mulberry(173), frame, 1.08, -0.2, { count: 8, spread: 100 });
      camLock.x = frame.x;
      camLock.y = frame.y;
      staging.camPos = camLock;
    },
    teardown: sceneReset,
  };

  let s18 = { bossId: "", killed: false, nextChip: 0, wave2: false, wave3: false };

  const bossKill: TrailerScene = {
    duration: 4000,
    id: "boss-kill",
    run: (t) => {
      const p = api.player();
      const boss = api.enemies().find((e) => e.id === s18.bossId);

      if (boss) {
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
        const point = { x: boss.x + Math.cos(oa) * 191, y: boss.y + Math.sin(oa) * 191 };
        steer(angleTo(p, point), Math.min(0.95, Math.max(0.3, dist(p, point) / 200)));
      } else {
        engage(600, 0.35, 0);
      }

      staging.fire = true;

      if (boss && t >= s18.nextChip && !s18.killed) {
        s18.nextChip = t + 500;
        api.damageEnemy(boss.id, 130);
      }

      if (boss && !s18.killed && t > 2750) {
        s18.killed = true;
        api.killEnemy(boss.id);
      }

      floorShield(130);
    },
    setup: () => {
      stage();
      s18 = { bossId: "", killed: false, nextChip: 600, wave2: false, wave3: false };
      cam.setZoom(1.7);
      show(hud.boss, true);
      show(hud.combo, true);

      if (hud.boss) {
        hud.boss.style.top = "52px";
      }

      const a = anchor(500, 0);
      const rnd = mulberry(11);
      api.setLevel(3);
      const start = { angle: -Math.PI / 2, vx: -120, vy: 0, x: a.x, y: a.y + 147 };
      api.setPlayerPose(start);
      api.grantWeapon("PLASMA STORM");
      api.grantBooster("overdrive");
      s18.bossId = api.spawnEnemy("dreadnought", a.x, a.y - 140, start);
      api.setEnemyHp(s18.bossId, 4300);
      spawnOval(rnd, ["drone", "wasp", "drone"], 30, a, 243, 191, start);
      spawnOval(rnd, ["wasp", "drone"], 14, a, 353, 250, start);
      api.spawnEnemy("warden", a.x - 250, a.y + 44, start);
      api.spawnEnemy("warden", a.x + 257, a.y - 22, start);
      api.spawnEnemy("spawner", a.x + 287, a.y - 107, start);
      api.spawnEnemy("sniper", a.x - 397, a.y - 88, start);
      api.spawnEnemy("sniper", a.x + 390, a.y + 110, start);
      const frame = { x: a.x, y: a.y - 44 };
      dressRocks(rnd, {
        at: frame,
        count: 22,
        keepOut: [
          { r: 170, x: a.x, y: a.y - 140 },
          ...corridor(start, { x: a.x, y: a.y - 103 }, 95),
        ],
        layout: { from: 0.36, inner: 0.62, kind: "arc", outer: 1.3, to: 2.9 },
        rMax: 46,
        rMin: 26,
      });
      boulder(mulberry(112), frame, 1.06, 0.42, { count: 5, rMax: 48, rMin: 34, spread: 62 });
      camLock.x = a.x;
      camLock.y = a.y;
      staging.camPos = camLock;
    },
    teardown: sceneReset,
  };

  const seedSpoils = (b: Vec, rnd: () => number) => {
    const clusters: Vec[] = [
      { x: b.x - 300, y: b.y - 60 },
      { x: b.x - 150, y: b.y + 170 },
      { x: b.x - 40, y: b.y - 190 },
      { x: b.x + 120, y: b.y + 155 },
      { x: b.x + 175, y: b.y - 120 },
    ];

    for (const c of clusters) {
      for (let i = 0; i < 7; i += 1) {
        api.spawnShards(1, c.x + (rnd() - 0.5) * 110, c.y + (rnd() - 0.5) * 90);
      }
    }
  };

  const SQUAD_RUNS: readonly { from: Vec; to: Vec }[] = [
    { from: { x: -390, y: 250 }, to: { x: -70, y: 80 } },
    { from: { x: -400, y: -235 }, to: { x: -70, y: -80 } },
    { from: { x: 330, y: 250 }, to: { x: -190, y: 165 } },
    { from: { x: 350, y: -240 }, to: { x: -190, y: -165 } },
  ];

  const SQUAD_FORM_START = 700;
  const SQUAD_FORM_END = 3150;
  const SURVIVORS_MS = 3800;

  const seedLastWave = (
    b: Vec,
    rnd: () => number,
    aimAt: Vec,
    count: number,
    near: number,
    span: number,
    halfH: number,
  ) => {
    for (let i = 0; i < count; i += 1) {
      api.spawnEnemy(
        i % 3 === 0 ? "wasp" : "drone",
        b.x + near + rnd() * span,
        b.y - halfH + rnd() * halfH * 2,
        aimAt,
      );
    }
  };

  const SQUAD_WAVE_2 = 1500;
  const SQUAD_WAVE_3 = 2700;
  const SPOILS_START = 1050;

  let s19 = {
    b: { x: 0, y: 0 },
    formed: false,
    rnd: mulberry(12),
    seeded: -1,
    wave2: false,
    wave3: false,
  };

  const survivors: TrailerScene = {
    duration: SURVIVORS_MS,
    id: "survivors",
    run: (t, dt) => {
      cam.setZoom(lerp(1.45, 1.85, ease(t / (SURVIVORS_MS - 400))));

      if (!s19.formed && t >= SQUAD_FORM_START) {
        s19.formed = true;
        const travelS = (SQUAD_FORM_END - SQUAD_FORM_START) / 1000;

        for (let i = 0; i < crew.length; i += 1) {
          const peer = crew[i];
          const run = SQUAD_RUNS[i];

          if (!peer || !run) {
            continue;
          }

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

      updateCrew(t, dt, "combat");
      const wave = Math.floor((t - SPOILS_START) / 620);

      if (t >= SPOILS_START && wave > s19.seeded && t < SURVIVORS_MS - 500) {
        s19.seeded = wave;
        seedSpoils(s19.b, s19.rnd);
      }

      const p = api.player();
      const target = nearestEnemy(p, 760);
      steer(target ? angleTo(p, target) : 0.06 * Math.sin(t * 0.001), 0.03);
      staging.fire = target !== null;
      floorShield(100);
    },
    setup: () => {
      stage();
      const b = anchor(0, 200);
      cam.setZoom(1.45);
      show(hud.root, true);
      show(hud.left, false);
      show(hud.players, false);
      api.setLevel(3);
      api.setShieldHp(100);
      api.setPlayerPose({ angle: 0, vx: 0, vy: 0, x: b.x + 50, y: b.y + 10 });
      api.grantBooster("magnet");
      camLock.x = b.x;
      camLock.y = b.y;
      staging.camPos = camLock;
      installPeers();
      const scores = [240, 180, 120, 88];

      for (let i = 0; i < 4; i += 1) {
        const run = SQUAD_RUNS[i] ?? SQUAD_RUNS[0];

        if (!run) {
          continue;
        }

        addPeer(
          `squad-${i + 1}`,
          i,
          { x: b.x + run.from.x, y: b.y + run.from.y },
          {
            angVel: 0.5,
            baseAim: 0,
            level: 3,
            orbitR: 22,
            phase0: i * 1.6,
            score: scores[i] ?? 100,
          },
        );
      }

      api.spawnAsteroid(b.x - 430, b.y - 250, 66);
      api.spawnAsteroid(b.x + 380, b.y + 235, 58);
      dressRocks(mulberry(81), {
        at: b,
        count: 14,
        keepOut: [{ r: 215, x: b.x - 60, y: b.y }],
        layout: { cx: -0.86, cy: 0.04, kind: "clump", spread: 0.34 },
        rMax: 62,
        rMin: 34,
      });
      boulder(mulberry(83), b, 0.72, -0.04, { count: 8, rMax: 66, rMin: 46, spread: 96 });
      const rnd = mulberry(12);
      s19 = { b, formed: false, rnd, seeded: -1, wave2: false, wave3: false };
      seedLastWave(b, mulberry(84), { x: b.x + 50, y: b.y + 10 }, 17, 170, 330, 235);
    },
    teardown: () => {
      staging.steer = null;
      staging.fire = false;
    },
  };

  let pending: (() => void) | null = null;
  staging.frame = () => {
    const body = pending;
    pending = null;
    body?.();
  };

  const inGameLoop = (s: TrailerScene) => {
    const body = s.run;
    const { setup } = s;

    const wrapped: TrailerScene = {
      ...s,
      setup: async () => {
        pending = null;

        await setup();
      },
    };

    if (body) {
      wrapped.run = (t: number, dt: number) => {
        pending = () => {
          body(t, dt);
        };
      };
    }

    return wrapped;
  };

  runTrailer({
    onGesture: () => {
      sfx.unlock();
    },
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
    ].map(inGameLoop),
    vignette: false,
  });
};

export const bootTrailerDirector = (game: Phaser.Game) => {
  const tryBoot = () => {
    const scene = game.scene.getScene("Game");

    if (scene instanceof GameScene && game.scene.isActive("Game")) {
      direct(scene);

      return;
    }

    window.setTimeout(tryBoot, 60);
  };

  tryBoot();
};
