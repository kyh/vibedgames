import type Phaser from "phaser";

import type { Interpolator } from "@vibedgames/multiplayer";

import type { Relic } from "../data/relics";
import type { Boss } from "../entities/boss";
import type { Door } from "../entities/door";
import type { Enemy } from "../entities/enemy";
import type { Player } from "../entities/player";
import type { ProjPose } from "../net/interp";
import type { BossPose, EnemyPose, PlayerPose, ProjKind } from "../net/snapshot";
import type { PixelSky } from "../render/pixel-sky";
import { Grid } from "../sys/grid";

// Projectiles carry a wire id, stable for their life, so a guest can
// dead-reckon each one instead of re-placing sprites by array index.
export interface Arrow {
  id: number;
  spr: Phaser.GameObjects.Sprite;
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  dmg: number;
}
export interface Shot {
  id: number;
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
  id: number;
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

// One remote actor on a guest: its view, the host-stamped poses it renders
// behind the relay clock (net/interp.ts), the pose drawn last frame (cue
// edges), and when the host stopped reporting it.
export interface Puppet<V, P> {
  view: V;
  interp: Interpolator<P>;
  prev: P | null;
  // stamps of the first snapshot that listed it (it shows once render time
  // reaches that), of the newest, and — once one no longer does — of the
  // last: it vanishes when render time passes that
  born: number;
  seen: number;
  gone: number | null;
  // a predicted stomp already played its hit: the flash cue holds back until
  // then (performance.now ms)
  hushUntil: number;
}

// A projectile on a guest: its rows, blended at render time like any puppet,
// with the same born / seen / gone stamps.
export interface ProjPuppet {
  spr: Phaser.GameObjects.Sprite;
  kind: ProjKind;
  interp: Interpolator<ProjPose>;
  born: number;
  seen: number;
  gone: number | null;
}

// A player row of the newest snapshot, named by the cast.
export interface SnapPlayer extends PlayerPose {
  id: string;
  hero: string;
}

// The guest's view of the current room: puppets driven from the host's
// snapshots and the cue/payoff edge state. Its own body is predicted
// (scenes/guest-sync.ts), not a puppet.
export interface GuestRoomView {
  // the newest snapshot's players
  players: SnapPlayer[];
  enemyPuppets: Map<number, Puppet<Enemy, EnemyPose>>;
  bossPuppet: Puppet<Boss, BossPose> | undefined;
  proj: Map<number, ProjPuppet>;
  payoff: { room: number; cleared: boolean; bossAlive: boolean } | null;
  // stamp of the newest checkpoint applied
  progressT: number;
  // stamp of the newest snapshot applied (server time, ms)
  snapT: number;
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
  nextProjId: number;
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
  enemyPuppets: new Map(),
  payoff: null,
  players: [],
  progressT: -1,
  proj: new Map(),
  snapT: -1,
});

/** An enemy's wire id, allocated on first use and stable for its life. */
export const enemyId = (room: RoomState, e: Enemy): number => {
  let id = room.enemyIds.get(e);
  if (id === undefined) {
    id = room.nextEnemyId;
    room.nextEnemyId += 1;
    room.enemyIds.set(e, id);
  }
  return id;
};

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
  nextProjId: 1,
  roomSpawn: { x: 0, y: 0 },
  seq: 0,
  shots: [],
  sky: undefined,
  vsSpawns: [],
});
