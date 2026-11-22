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
  owner: Player | null;
  hit: Set<Enemy>;
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

export interface Puppet<V, P> {
  view: V;
  interp: Interpolator<P>;
  prev: P | null;
  born: number;
  seen: number;
  gone: number | null;
  hushUntil: number;
}

export interface ProjPuppet {
  spr: Phaser.GameObjects.Sprite;
  kind: ProjKind;
  interp: Interpolator<ProjPose>;
  born: number;
  seen: number;
  gone: number | null;
}

export interface SnapPlayer extends PlayerPose {
  id: string;
  hero: string;
}

export interface GuestRoomView {
  players: SnapPlayer[];
  enemyPuppets: Map<number, Puppet<Enemy, EnemyPose>>;
  bossPuppet: Puppet<Boss, BossPose> | undefined;
  proj: Map<number, ProjPuppet>;
  payoff: { room: number; cleared: boolean; clearAt: number | null } | null;
  progressT: number;
  snapT: number;
}

export interface RoomState {
  grid: Grid;
  seq: number;
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
  vsSpawns: Point[];
  deadTimers: WeakMap<Enemy, number>;
  enemyIds: WeakMap<Enemy, number>;
  nextEnemyId: number;
  nextProjId: number;
  bossAnnounced: boolean;
  sky: PixelSky | undefined;
  fogRect: Phaser.GameObjects.Rectangle | undefined;
  bossHp: Phaser.GameObjects.Rectangle | undefined;
  bossHpBg: Phaser.GameObjects.Rectangle | undefined;
  guest: GuestRoomView;
}

export const newGuestRoomView: () => GuestRoomView = () => ({
  bossPuppet: undefined,
  enemyPuppets: new Map(),
  payoff: null,
  players: [],
  progressT: -1,
  proj: new Map(),
  snapT: -1,
});

/** An enemy's wire id, allocated on first use and stable for its life. */
export const enemyId = (room: RoomState, e: Enemy) => {
  let id = room.enemyIds.get(e);

  if (id === undefined) {
    id = room.nextEnemyId;
    room.nextEnemyId += 1;
    room.enemyIds.set(e, id);
  }

  return id;
};

export const newRoomState: () => RoomState = () => ({
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
