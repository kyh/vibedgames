// Guest-side mirror of the host's sim: puppets per snapshot row, the world
// rebuilt when the seed changes, loot boxes and cubes as real combat objects
// so Combat.present animates them exactly as on the host, bullets and bombs
// as render-only pools extrapolated between snapshots, and the HUD banners
// the local client derives from phase and roster edges.
import * as THREE from "three";
import { conformGroundGeometry } from "../world/terrain";
import { BULLET_Y, drawProjectile, finishProjectileMesh } from "../combat/bullets";
import type { ProjectileStyle } from "../config";
import type { Cube, LootBox } from "../combat/combat";
import { setBombAppearance } from "../combat/combat";
import type { Brawler } from "../entities/brawler";
import type { Game } from "../game";
import { setSpectateCopy } from "../hud-lobby";
import { GRID } from "../world/grid";
import { spawnFromNet } from "./host";
import { applyNetState } from "./interpolation";
import { seatId } from "./protocol";
import type { NetBomb, NetBullet, NetPhase, Snapshot } from "./snapshot";

const SPECTATE_LIVE = "SPECTATING · next brawl after this one";
const SPECTATE_ENDED = "SPECTATING · next brawl starting soon";
const MARKER_COLOR = 0xff_40_30;
const SUPER_MARKER_COLOR = 0xff_c2_3a;
/** How eagerly a bomb body chases the host's position (per second). */
const BOMB_LAMBDA = 18;

/** A bullet between snapshots: the host's last pose, flown forward locally. */
interface GuestBullet {
  style: ProjectileStyle;
  color: THREE.Color;
  dx: number;
  dz: number;
  left: number;
  radius: number;
  speed: number;
  isSuper: boolean;
  trail: number;
  x: number;
  z: number;
}

interface GuestBomb {
  target: NetBomb;
  rotX: number;
  rotZ: number;
  x: number;
  y: number;
  z: number;
}

const scratchColor = new THREE.Color();

const cubeKey = (x: number, z: number): string => `${x},${z}`;

const toGuestBullet = (n: NetBullet): GuestBullet => ({
  color: new THREE.Color(n.c),
  dx: n.dx,
  dz: n.dz,
  isSuper: n.s,
  left: n.l,
  radius: n.r,
  speed: n.v,
  style: n.style,
  trail: 0,
  x: n.x,
  z: n.z,
});

export class GuestView {
  private readonly game: Game;
  private readonly puppets = new Map<string, Brawler>();
  private readonly boxes = new Map<number, LootBox>();
  private readonly cubes = new Map<string, Cube[]>();
  private bullets: GuestBullet[] = [];
  private bombs: GuestBomb[] = [];
  private brokenApplied = 0;
  private gen = -1;
  private lastPhase: NetPhase | null = null;
  private lastGasActive = false;
  private lastAliveCount = -1;
  private ownAlive = true;
  private ownHp = 0;
  private ownReady = false;
  /** Sequence of the last snapshot folded in. */
  seq = -1;

  constructor(game: Game) {
    this.game = game;
  }

  get hasWorld(): boolean {
    return this.gen >= 0;
  }

  /** Fold a snapshot in; a new generation or seed rebuilds everything first. */
  apply(snap: Snapshot): void {
    const { game } = this;
    if (snap.gen !== this.gen || snap.seed !== game.world.seed) {
      this.beginGeneration(snap);
    }
    this.seq = snap.seq;
    game.winner = snap.winner;
    game.matchTime = snap.matchTime;
    this.syncPhase(snap);
    this.syncBrawlers(snap);
    this.syncBroken(snap.broken);
    this.syncBoxes(snap);
    this.syncCubes(snap);
    this.bullets = snap.bullets.map(toGuestBullet);
    this.syncBombs(snap.bombs);
    if (game.autoTime) {
      game.lighting.setTime(snap.hour);
    }
    this.syncAliveCount();
  }

  /** Per frame: fly bullets, chase bombs, animate loot. */
  update(dt: number): void {
    this.updateBullets(dt);
    this.updateBombs(dt);
    this.game.combat.present(dt);
  }

  /** Drop everything guest-owned (leaving, promotion, demotion). */
  reset(): void {
    const { game } = this;
    for (const b of this.puppets.values()) {
      game.removeBrawler(b, false);
    }
    this.puppets.clear();
    for (const box of this.boxes.values()) {
      game.combat.removeBox(box);
    }
    this.boxes.clear();
    for (const list of this.cubes.values()) {
      for (const cube of list) {
        game.combat.removeCube(cube);
      }
    }
    this.cubes.clear();
    this.bullets = [];
    game.combat.bulletMesh.count = 0;
    game.combat.thornMesh.count = 0;
    this.bombs = [];
    this.hideBombSlots(0);
    this.brokenApplied = 0;
    this.gen = -1;
    this.lastPhase = null;
    this.lastAliveCount = -1;
    setSpectateCopy(null);
  }

  private beginGeneration(snap: Snapshot): void {
    const { game } = this;
    this.reset();
    if (game.world.seed !== snap.seed) {
      game.rebuildWorld(snap.seed);
    }
    game.clearEntities();
    game.world.broken = [];
    game.hud.hideResult();
    game.pendingResult = null;
    game.spectate = null;
    game.generation = snap.gen;
    game.shakeAmp = 0;
    this.gen = snap.gen;
    this.lastGasActive = snap.gas.active;
    this.ownAlive = true;
    game.lastCount = snap.phase === "countdown" ? 4 : 0;
    game.world.aoDirty = true;
    game.world.aoTimer = 0;
  }

  private syncPhase(snap: Snapshot): void {
    const { game } = this;
    const previous = this.lastPhase;
    this.lastPhase = snap.phase;
    game.state = snap.phase;
    game.countdownT = snap.countdownT;
    if (snap.phase === "countdown") {
      game.announceCount();
    } else if (previous === "countdown") {
      game.announceGo();
    }
    if (snap.gas.active && !this.lastGasActive) {
      game.announceGas();
    }
    this.lastGasActive = snap.gas.active;
    if (snap.phase === "ended" && previous !== null && previous !== "ended" && this.ownAlive) {
      const own = game.player;
      if (own?.alive) {
        game.localWin();
      }
    }
  }

  private syncOwn(b: Brawler, hp: number, charge: number, alive: boolean, rank: number): void {
    const { game } = this;
    if (hp < this.ownHp && alive) {
      const lost = this.ownHp - hp;
      game.onPlayerHurt(lost);
      if (game.gas.active && game.gas.depthAt(b.x, b.z) > 0.35) {
        game.audio.play("gas");
      }
    }
    this.ownHp = hp;
    const ready = charge >= 1;
    if (ready && !this.ownReady) {
      game.audio.play("ready");
    }
    this.ownReady = ready;
    if (this.ownAlive && !alive) {
      game.localDown(rank, null);
    }
    this.ownAlive = alive;
  }

  private syncBrawlers(snap: Snapshot): void {
    const { game } = this;
    const mine = game.session?.playerId;
    const ownId = mine ? seatId(mine) : null;
    const seen = new Set<string>();
    for (const n of snap.brawlers) {
      seen.add(n.id);
      const own = n.id === ownId;
      let b = this.puppets.get(n.id);
      if (b) {
        applyNetState(b, n);
      } else {
        b = spawnFromNet(game, n, own ? "predict" : "puppet", own);
        applyNetState(b, n);
        this.puppets.set(n.id, b);
        game.addBrawler(b, false);
        if (own) {
          game.adoptLocalSeat(b);
          this.ownHp = n.hp;
          this.ownAlive = n.alive;
          this.ownReady = n.charge >= 1;
        }
      }
      if (own) {
        this.syncOwn(b, n.hp, n.charge, n.alive, n.rank);
      }
    }
    for (const [id, b] of this.puppets) {
      if (!seen.has(id)) {
        game.removeBrawler(b, false);
        this.puppets.delete(id);
      }
    }
    this.syncSpectateCopy(ownId !== null && seen.has(ownId));
  }

  private syncSpectateCopy(seated: boolean): void {
    if (seated) {
      setSpectateCopy(null);
      return;
    }
    setSpectateCopy(this.lastPhase === "ended" ? SPECTATE_ENDED : SPECTATE_LIVE);
  }

  private syncAliveCount(): void {
    const { game } = this;
    const alive = game.brawlers.filter((b) => b.alive).length;
    const previous = this.lastAliveCount;
    this.lastAliveCount = alive;
    if (previous > 2 && alive === 2 && game.player?.alive && game.state === "playing") {
      game.hud.banner("SHOWDOWN!", 1.5, true);
    }
  }

  private syncBroken(broken: readonly number[]): void {
    const { world } = this.game;
    if (broken.length < this.brokenApplied) {
      this.brokenApplied = 0;
    }
    for (let k = this.brokenApplied; k < broken.length; k += 1) {
      const i = broken[k];
      if (i !== undefined) {
        world.destroyTile(i % GRID, Math.floor(i / GRID));
      }
    }
    this.brokenApplied = broken.length;
  }

  private syncBoxes(snap: Snapshot): void {
    const { combat, world } = this.game;
    const seen = new Set<number>();
    for (const row of snap.boxes) {
      seen.add(row.i);
      let box = this.boxes.get(row.i);
      if (!box) {
        const spot = world.boxSpots[row.i];
        if (!spot) {
          continue;
        }
        box = combat.addBox(spot[0], spot[1]);
        this.boxes.set(row.i, box);
      }
      if (row.hp < box.hp) {
        box.shake = 1;
      }
      box.hp = row.hp;
    }
    for (const [i, box] of this.boxes) {
      if (!seen.has(i)) {
        combat.removeBox(box);
        this.boxes.delete(i);
      }
    }
  }

  private syncCubes(snap: Snapshot): void {
    const { combat } = this.game;
    const wanted = new Map<string, number>();
    for (const cube of snap.cubes) {
      const key = cubeKey(cube.x, cube.z);
      wanted.set(key, (wanted.get(key) ?? 0) + 1);
    }
    for (const [key, list] of this.cubes) {
      const keep = wanted.get(key) ?? 0;
      while (list.length > keep) {
        const cube = list.pop();
        if (cube) {
          combat.removeCube(cube);
        }
      }
      if (list.length === 0) {
        this.cubes.delete(key);
      }
    }
    for (const cube of snap.cubes) {
      const key = cubeKey(cube.x, cube.z);
      const list = this.cubes.get(key) ?? [];
      const keep = wanted.get(key) ?? 0;
      if (list.length < keep) {
        combat.spawnCube(cube.x, cube.z, cube.x, cube.z);
        const spawned = combat.cubes.at(-1);
        if (spawned) {
          list.push(spawned);
        }
      }
      this.cubes.set(key, list);
    }
  }

  private syncBombs(rows: readonly NetBomb[]): void {
    const next: GuestBomb[] = [];
    for (const [i, target] of rows.entries()) {
      const existing = this.bombs[i];
      if (existing) {
        existing.target = target;
        next.push(existing);
      } else {
        next.push({ rotX: 0, rotZ: 0, target, x: target.x, y: target.y, z: target.z });
      }
    }
    this.hideBombSlots(next.length);
    this.bombs = next;
  }

  private hideBombSlots(from: number): void {
    const { bombPool } = this.game.combat;
    for (let i = from; i < bombPool.length; i += 1) {
      const slot = bombPool[i];
      if (slot) {
        slot.busy = false;
        slot.group.visible = false;
        slot.ring.visible = false;
      }
    }
  }

  private updateBullets(dt: number): void {
    const { combat, effects, lighting, world } = this.game;
    let arrows = 0;
    let thorns = 0;
    for (const b of this.bullets) {
      const step = b.speed * dt;
      b.x += b.dx * step;
      b.z += b.dz * step;
      b.left -= step;
      const thorn = b.style === "thorn";
      const mesh = thorn ? combat.thornMesh : combat.bulletMesh;
      const count = thorn ? thorns : arrows;
      if (b.left <= 0 || count >= mesh.instanceMatrix.count) {
        continue;
      }
      drawProjectile(mesh, count, b, b.style, b.left, world.heightAt(b.x, b.z));
      if (thorn) {
        thorns += 1;
      } else {
        arrows += 1;
      }
      const y = BULLET_Y + world.heightAt(b.x, b.z);
      if (b.isSuper) {
        lighting.addLight(b.x, y, b.z, b.color, 0.25, 2.5);
      }
      b.trail -= dt;
      if (b.trail <= 0) {
        b.trail = 0.045;
        effects.trail(b.x, y, b.z, b.color, b.isSuper ? 0.15 : 0.065);
      }
    }
    this.bullets = this.bullets.filter((b) => b.left > 0);
    finishProjectileMesh(combat.bulletMesh, arrows);
    finishProjectileMesh(combat.thornMesh, thorns);
  }

  private updateBombs(dt: number): void {
    const { combat, effects, elapsed, lighting, world } = this.game;
    const blend = 1 - Math.exp(-BOMB_LAMBDA * dt);
    for (const [i, bomb] of this.bombs.entries()) {
      const slot = combat.bombPool[i];
      if (!slot) {
        break;
      }
      const { target } = bomb;
      bomb.x += (target.x - bomb.x) * blend;
      bomb.y += (target.y - bomb.y) * blend;
      bomb.z += (target.z - bomb.z) * blend;
      if (target.u <= 0) {
        bomb.rotX += dt * 9;
        bomb.rotZ += dt * 5;
      }
      scratchColor.setHex(target.c);
      setBombAppearance(slot, target.style, scratchColor);
      slot.busy = true;
      slot.group.visible = true;
      slot.group.position.set(bomb.x, bomb.y, bomb.z);
      slot.group.rotation.set(bomb.rotX, 0, bomb.rotZ);
      slot.group.scale.setScalar(target.big ? 1.75 : 1);
      slot.ring.visible = true;
      slot.ring.position.set(target.tx, world.heightAt(target.tx, target.tz) + 0.05, target.tz);
      slot.ring.scale.set(target.r, 1, target.r);
      conformGroundGeometry(slot.ring.geometry, target.tx, target.tz, target.r);
      conformGroundGeometry(slot.fillDisc.geometry, target.tx, target.tz, target.r);
      const markerColor = target.s ? SUPER_MARKER_COLOR : MARKER_COLOR;
      slot.ring.material.color.set(markerColor);
      slot.fillDisc.material.color.set(markerColor);
      const pulse = 0.5 + 0.5 * Math.sin(elapsed * (14 + target.u * 30));
      slot.spark.scale.setScalar(0.8 + pulse * 0.9);
      slot.ring.material.opacity = 0.55 + pulse * 0.35;
      slot.fillDisc.material.opacity = 0.1 + target.u * 0.22;
      effects.trail(bomb.x, bomb.y, bomb.z, scratchColor, target.big ? 0.46 : 0.26);
      lighting.addLight(bomb.x, bomb.y + 0.3, bomb.z, scratchColor, 2.2 + pulse * 2.5, 4);
      if (Math.random() < dt * 40) {
        effects.spark(bomb.x, bomb.y + 0.25 * slot.group.scale.x, bomb.z, scratchColor);
      }
    }
  }
}
