import type Phaser from "phaser";

import type { Relic } from "../data/relics";
import type { SpecialReadiness } from "../data/special-readiness";
import type { Boss } from "../entities/boss";
import type { Door } from "../entities/door";
import type { Enemy } from "../entities/enemy";
import type { Player } from "../entities/player";
import { Reconciler } from "../net/predict";
import type { NetBoss, NetEnemy, NetPlayer } from "../net/snapshot";
import type { PixelSky } from "../render/pixel-sky";
import { Grid } from "../sys/grid";

export interface Arrow {
  spr: Phaser.GameObjects.Sprite;
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  dmg: number;
}
export interface Shot {
  spr: Phaser.GameObjects.Sprite;
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  dmg: number;
  // caster — a shot never hits its own thrower (versus)
  owner: Player | null;
  hit: Set<Enemy>;
  // versus: per-duelist hit dedup
  hitP: Set<Player>;
  hitBoss: boolean;
}
export interface Hazard {
  spr: Phaser.GameObjects.Sprite;
  x: number;
  y: number;
  vx: number;
  life: number;
  dmg: number;
  hitPlayer: boolean;
}
export interface Feature {
  x: number;
  y: number;
  used: boolean;
  g: Phaser.GameObjects.Container;
}
export interface MerchantItem {
  x: number;
  y: number;
  relic: Relic;
  bought: boolean;
  g: Phaser.GameObjects.Container;
}

export interface Point {
  x: number;
  y: number;
}

// The guest's view of the current room: puppets driven from the host's
// snapshots, the cue/payoff edge state, and the prediction of its own body.
export interface GuestRoomView {
  // latest wire players (re-lerped each frame)
  players: NetPlayer[];
  enemyPuppets: Map<number, { view: Enemy; net: NetEnemy }>;
  bossPuppet: { view: Boss; net: NetBoss } | undefined;
  // projectile puppets
  proj: Phaser.GameObjects.Sprite[];
  payoff: { room: number; t: number; cleared: boolean; bossAlive: boolean } | null;
  // the first snapshot after a room build is quiet
  cueBaseline: boolean;
  progressTick: number;
  special: SpecialReadiness;
  // last snapshot applied
  snapT: number;
  // my player's hurting flag last snapshot (edge detect)
  selfHurting: boolean;
  // Prediction: my own body runs the real fixed-step sim on local input
  // (instant response); each snapshot's authoritative copy folds back in here.
  reconciler: Reconciler;
}

// Everything one room build owns — sim entities, projectiles, props, the
// guest's puppets and the boss bar — plus the screen-pinned sky/fog plates the
// room repaints per biome. Filled by RoomBuilder.build*, emptied by its teardown.
export interface RoomState {
  grid: Grid;
  // bumped per room build, drives guest room rebuilds
  seq: number;
  // room changed since the last broadcast (host)
  dirty: boolean;
  enemies: Enemy[];
  boss: Boss | null;
  doors: Door[];
  arrows: Arrow[];
  shots: Shot[];
  hazards: Hazard[];
  feature: Feature | null;
  merchantItems: MerchantItem[];
  roomSpawn: Point;
  // versus: [host, guest] spawn points, mirrored
  vsSpawns: Point[];
  deadTimers: WeakMap<Enemy, number>;
  // stable wire id per enemy
  enemyIds: WeakMap<Enemy, number>;
  nextEnemyId: number;
  bossAnnounced: boolean;
  sky: PixelSky | undefined;
  // per-biome atmosphere wash
  fogRect: Phaser.GameObjects.Rectangle | undefined;
  bossHp: Phaser.GameObjects.Rectangle | undefined;
  bossHpBg: Phaser.GameObjects.Rectangle | undefined;
  guest: GuestRoomView;
}

export const newGuestRoomView = (): GuestRoomView => ({
  bossPuppet: undefined,
  cueBaseline: true,
  enemyPuppets: new Map(),
  payoff: null,
  players: [],
  progressTick: -1,
  proj: [],
  reconciler: new Reconciler(),
  selfHurting: false,
  snapT: -1,
  special: { kind: "unknown" },
});

export const newRoomState = (): RoomState => ({
  arrows: [],
  boss: null,
  bossAnnounced: false,
  bossHp: undefined,
  bossHpBg: undefined,
  deadTimers: new WeakMap(),
  dirty: false,
  doors: [],
  enemies: [],
  enemyIds: new WeakMap(),
  feature: null,
  fogRect: undefined,
  grid: new Grid(),
  guest: newGuestRoomView(),
  hazards: [],
  merchantItems: [],
  nextEnemyId: 1,
  roomSpawn: { x: 0, y: 0 },
  seq: 0,
  shots: [],
  sky: undefined,
  vsSpawns: [],
});
