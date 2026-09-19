import * as THREE from "three";
import type { BlastAttack, LobAttack, ProjectileAttack } from "../config";
import { TILE, TUNING } from "../config";
import type { Brawler } from "../entities/brawler";
import type { Game } from "../game";
import { clamp, lerp } from "../utils";
import { MAX_BULLETS, advanceBullet, drawBullet, lightBullet } from "./bullets";
import { stepBomb } from "./bombs";
import { buildLootBoxTextures } from "./textures";
import type { LootBoxTextures } from "./textures";

export interface Bullet {
  a: ProjectileAttack;
  alive: boolean;
  color: THREE.Color;
  damage: number;
  dx: number;
  dz: number;
  isSuper: boolean;
  melee: boolean;
  owner: Brawler;
  radius: number;
  range: number;
  speed: number;
  trail: number;
  travel: number;
  x: number;
  z: number;
}

type FlatMesh<G extends THREE.BufferGeometry> = THREE.Mesh<G, THREE.MeshBasicMaterial>;

/** One pooled bomb body plus its landing marker, reused across throws. */
export interface BombSlot {
  busy: boolean;
  fillDisc: FlatMesh<THREE.CircleGeometry>;
  group: THREE.Group;
  ring: FlatMesh<THREE.RingGeometry>;
  spark: FlatMesh<THREE.SphereGeometry>;
}

export interface Bomb {
  a: LobAttack;
  color: THREE.Color;
  damage: number;
  done: boolean;
  fuse: number;
  isSuper: boolean;
  landed: boolean;
  owner: Brawler;
  slot: BombSlot;
  sx: number;
  sy: number;
  sz: number;
  t: number;
  tx: number;
  tz: number;
}

export interface LootBox {
  alive: boolean;
  hp: number;
  isBox: true;
  mat: THREE.MeshStandardMaterial;
  maxHp: number;
  mesh: THREE.Mesh<THREE.BoxGeometry, THREE.MeshStandardMaterial>;
  shake: number;
  // id of the bot that gave up reaching this box, so it stops re-targeting it
  skipBy?: number;
  tx: number;
  ty: number;
  x: number;
  z: number;
}

export interface Cube {
  alive: boolean;
  mesh: THREE.Mesh<THREE.BoxGeometry, THREE.MeshStandardMaterial>;
  phase: number;
  sx: number;
  sz: number;
  t: number;
  x: number;
  z: number;
}

const BOMB_POOL_SIZE = 14;
const MARKER_COLOR = 0xff_40_30;
const SUPER_MARKER_COLOR = 0xff_c2_3a;
// Debris tint per breakable prop style: stone, crate, barrel, cactus.
const RUBBLE_COLORS = [0xb9_a5_8c, 0xb0_7a_3c, 0x9a_5f_2e, 0x4f_9a_4a];

const buildBombSlot = (
  scene: THREE.Scene,
  bodyGeo: THREE.SphereGeometry,
  bodyMat: THREE.MeshStandardMaterial,
  sparkGeo: THREE.SphereGeometry,
): BombSlot => {
  const group = new THREE.Group();
  const body = new THREE.Mesh(bodyGeo, bodyMat);
  body.castShadow = true;
  const spark = new THREE.Mesh(
    sparkGeo,
    new THREE.MeshBasicMaterial({ color: new THREE.Color(6, 2.4, 0.5) }),
  );
  spark.position.set(0, 0.24, 0);
  spark.userData.noAO = true;
  group.add(body, spark);
  group.visible = false;
  scene.add(group);
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(0.93, 1, 56).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({
      color: MARKER_COLOR,
      depthWrite: false,
      opacity: 0,
      transparent: true,
    }),
  );
  const fillDisc = new THREE.Mesh(
    new THREE.CircleGeometry(0.93, 48).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({
      color: MARKER_COLOR,
      depthWrite: false,
      opacity: 0,
      transparent: true,
    }),
  );
  ring.add(fillDisc);
  ring.position.y = 0.05;
  ring.visible = false;
  ring.userData.noAO = true;
  ring.renderOrder = 2;
  scene.add(ring);
  return { busy: false, fillDisc, group, ring, spark };
};

// Blast damage and knockback on every brawler inside the radius. Knockback
// tapers with distance so a near miss still shoves but a direct hit launches.
const blastBrawlers = (
  brawlers: Brawler[],
  x: number,
  z: number,
  attack: BlastAttack,
  owner: Brawler,
  damage: number,
): void => {
  const { blast } = attack;
  for (const target of brawlers) {
    if (!target.alive || target === owner || target.airborne) {
      continue;
    }
    const d = Math.hypot(target.x - x, target.z - z);
    if (d > blast + 0.24) {
      continue;
    }
    target.takeDamage(damage, owner);
    if (attack.knockback) {
      const force = attack.knockback * (1 - (d / (blast + 0.5)) * 0.5);
      const nx = d > 0.01 ? (target.x - x) / d : 1;
      const nz = d > 0.01 ? (target.z - z) / d : 0;
      target.knock.set(nx * force, nz * force);
    }
  }
};

export class Combat {
  game: Game;
  bullets: Bullet[];
  bombs: Bomb[];
  boxes: LootBox[];
  cubes: Cube[];
  bulletMesh: THREE.InstancedMesh<THREE.SphereGeometry, THREE.MeshBasicMaterial>;
  bombPool: BombSlot[];
  boxGeo: THREE.BoxGeometry;
  boxTex: LootBoxTextures;
  cubeGeo: THREE.BoxGeometry;
  cubeMat: THREE.MeshStandardMaterial;
  cubeLight: THREE.Color;
  orange: THREE.Color;

  constructor(game: Game) {
    this.game = game;
    this.bullets = [];
    this.bombs = [];
    this.boxes = [];
    this.cubes = [];
    const bulletGeo = new THREE.SphereGeometry(1, 10, 8);
    this.bulletMesh = new THREE.InstancedMesh(
      bulletGeo,
      new THREE.MeshBasicMaterial({ color: 0xff_ff_ff }),
      MAX_BULLETS,
    );
    this.bulletMesh.count = 0;
    this.bulletMesh.frustumCulled = false;
    this.bulletMesh.userData.noAO = true;
    // Touching instance colour once allocates the attribute up front.
    this.bulletMesh.setColorAt(0, new THREE.Color(1, 1, 1));
    game.scene.add(this.bulletMesh);
    this.bombPool = [];
    const bombGeo = new THREE.SphereGeometry(0.2, 16, 12);
    const bombMat = new THREE.MeshStandardMaterial({
      color: 0x1b_1b_22,
      metalness: 0.3,
      roughness: 0.35,
    });
    const sparkGeo = new THREE.SphereGeometry(0.07, 8, 6);
    for (let i = 0; i < BOMB_POOL_SIZE; i += 1) {
      this.bombPool.push(buildBombSlot(game.scene, bombGeo, bombMat, sparkGeo));
    }
    this.boxGeo = new THREE.BoxGeometry(0.92, 0.92, 0.92);
    this.boxTex = buildLootBoxTextures();
    this.cubeGeo = new THREE.BoxGeometry(0.34, 0.34, 0.34);
    this.cubeMat = new THREE.MeshStandardMaterial({
      color: 0x1c_8a_4a,
      emissive: 0x30_ff_80,
      emissiveIntensity: 2.4,
      metalness: 0.2,
      roughness: 0.25,
    });
    this.cubeLight = new THREE.Color(0x40_ff_8a);
    this.orange = new THREE.Color(0xff_8a_3a);
  }

  addBox(tx: number, ty: number): LootBox {
    const { world } = this.game;
    const mat = new THREE.MeshStandardMaterial({
      emissive: 0xff_ff_ff,
      emissiveIntensity: 1.4,
      emissiveMap: this.boxTex.emissiveMap,
      map: this.boxTex.map,
      roughness: 0.7,
    });
    const mesh = new THREE.Mesh(this.boxGeo, mat);
    mesh.position.set(world.center(tx), 0.46, world.center(ty));
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    this.game.scene.add(mesh);
    world.setBlocker(tx, ty, true);
    const box: LootBox = {
      alive: true,
      hp: TUNING.boxHp,
      isBox: true,
      mat,
      maxHp: TUNING.boxHp,
      mesh,
      shake: 0,
      tx,
      ty,
      x: mesh.position.x,
      z: mesh.position.z,
    };
    this.boxes.push(box);
    return box;
  }

  boxAt(tx: number, ty: number): LootBox | null {
    for (const box of this.boxes) {
      if (box.alive && box.tx === tx && box.ty === ty) {
        return box;
      }
    }
    return null;
  }

  damageBox(box: LootBox, amount: number, attacker: Brawler | null): void {
    if (!box.alive) {
      return;
    }
    box.hp -= amount;
    box.shake = 1;
    this.game.hud.floatText(box.x, 1.2, box.z, `${Math.round(amount)}`, "dmg");
    if (attacker) {
      attacker.lastCombat = this.game.elapsed;
    }
    if (box.hp > 0) {
      return;
    }
    box.alive = false;
    this.game.scene.remove(box.mesh);
    box.mat.dispose();
    this.game.world.setBlocker(box.tx, box.ty, false);
    this.game.effects.debris(box.x, 0.5, box.z, 0x6a_54_96, 9);
    this.game.effects.burst(box.x, 0.6, box.z, this.cubeLight, 16, 4.5);
    this.game.effects.flash(box.x, 0.8, box.z, this.cubeLight, 9, 6, 0.3);
    this.game.audio.play("crate", box.x, box.z);
    this.spawnCube(box.x, box.z, box.x, box.z);
  }

  /** Drop a box without the sim's break effects: a guest mirroring the host's roster. */
  removeBox(box: LootBox): void {
    if (!box.alive) {
      return;
    }
    box.alive = false;
    this.game.scene.remove(box.mesh);
    box.mat.dispose();
    this.game.world.setBlocker(box.tx, box.ty, false);
  }

  /** Take a cube out of the world without anyone collecting it. */
  removeCube(cube: Cube): void {
    cube.alive = false;
    this.game.scene.remove(cube.mesh);
    this.cubes = this.cubes.filter((other) => other.alive);
  }

  spawnCube(sx: number, sz: number, x: number, z: number): void {
    const mesh = new THREE.Mesh(this.cubeGeo, this.cubeMat);
    mesh.castShadow = true;
    mesh.position.set(sx, 0.5, sz);
    this.game.scene.add(mesh);
    this.cubes.push({
      alive: true,
      mesh,
      phase: Math.random() * 6,
      sx,
      sz,
      t: 0,
      x,
      z,
    });
  }

  // Scatter the cubes a downed brawler carried around where they fell.
  dropCubes(x: number, z: number, count: number): void {
    const { world } = this.game;
    for (let i = 0; i < count; i += 1) {
      const angle = (i / count) * Math.PI * 2 + Math.random();
      const spread = count === 1 ? 0 : 0.7 + Math.random() * 0.5;
      const spot = world.nearestOpen(x + Math.cos(angle) * spread, z + Math.sin(angle) * spread);
      this.spawnCube(x, z, spot.x, spot.z);
    }
  }

  spawnBullet(
    owner: Brawler,
    x: number,
    z: number,
    dx: number,
    dz: number,
    attack: ProjectileAttack,
    isSuper: boolean,
    speed: number,
  ): void {
    if (this.bullets.length >= MAX_BULLETS) {
      return;
    }
    const color = owner.bulletColor(isSuper).clone();
    this.bullets.push({
      a: attack,
      alive: true,
      color,
      damage: attack.damage * owner.damageMul,
      dx,
      dz,
      isSuper,
      melee: attack.kind === "melee",
      owner,
      radius: attack.radius,
      range: attack.range,
      speed,
      trail: 0,
      travel: 0,
      x,
      z,
    });
  }

  spawnBomb(
    owner: Brawler,
    sx: number,
    sy: number,
    sz: number,
    tx: number,
    tz: number,
    attack: LobAttack,
    isSuper: boolean,
  ): void {
    const slot = this.bombPool.find((candidate) => !candidate.busy);
    if (!slot) {
      return;
    }
    slot.busy = true;
    slot.group.visible = true;
    slot.group.position.set(sx, sy, sz);
    slot.group.scale.setScalar(attack.big ? 1.75 : 1);
    slot.ring.visible = true;
    slot.ring.position.set(tx, 0.05, tz);
    slot.ring.scale.setScalar(attack.blast);
    const markerColor = isSuper ? SUPER_MARKER_COLOR : MARKER_COLOR;
    slot.ring.material.color.set(markerColor);
    slot.fillDisc.material.color.set(markerColor);
    this.bombs.push({
      a: attack,
      color: owner.bulletColor(isSuper).clone(),
      damage: attack.damage * owner.damageMul,
      done: false,
      fuse: attack.fuse,
      isSuper,
      landed: false,
      owner,
      slot,
      sx,
      sy,
      sz,
      t: 0,
      tx,
      tz,
    });
  }

  breakTile(tx: number, ty: number): void {
    const { game } = this;
    const broken = game.world.destroyTile(tx, ty);
    if (!broken) {
      return;
    }
    if (broken.type === TILE.BUSH) {
      game.effects.leaves(broken.x, broken.z, 14);
      return;
    }
    game.effects.debris(broken.x, 0.6, broken.z, RUBBLE_COLORS[broken.style] ?? 0xb9_a5_8c, 10);
    game.effects.dust(broken.x, broken.z, 8, 2.2);
    game.audio.play("crate", broken.x, broken.z);
  }

  // Knock out every breakable tile whose centre sits inside the blast.
  breakWallsAround(x: number, z: number, blast: number): void {
    const { world } = this.game;
    const reach = Math.ceil(blast);
    const cx = world.toTile(x);
    const cz = world.toTile(z);
    for (let oz = -reach; oz <= reach; oz += 1) {
      for (let ox = -reach; ox <= reach; ox += 1) {
        const px = world.center(cx + ox);
        const pz = world.center(cz + oz);
        if (Math.hypot(px - x, pz - z) < blast - 0.25) {
          this.breakTile(cx + ox, cz + oz);
        }
      }
    }
  }

  explode(
    x: number,
    z: number,
    attack: BlastAttack,
    owner: Brawler,
    isSuper: boolean,
    slam = false,
  ): void {
    const { game } = this;
    const { blast } = attack;
    const damage = attack.damage * owner.damageMul;
    blastBrawlers(game.brawlers, x, z, attack, owner, damage);
    for (const box of this.boxes) {
      if (box.alive && Math.hypot(box.x - x, box.z - z) < blast + 0.4) {
        this.damageBox(box, damage, owner);
      }
    }
    if (attack.breaksWalls) {
      this.breakWallsAround(x, z, blast);
    }
    const big = attack.big === true;
    if (slam) {
      game.effects.slam(x, z, blast, owner.superColor);
    } else {
      game.effects.explosion(x, z, blast, big ? owner.superColor : this.orange, big);
    }
    game.shake(big || slam ? 0.55 : 0.24, x, z);
    game.audio.play(big || slam ? "boomBig" : "boom", x, z);
  }

  update(dt: number): void {
    this.updateBullets(dt);
    this.updateBombs(dt);
    this.updateBoxes(dt);
    this.updateCubes(dt);
  }

  /** Render-only pass for a guest: boxes wobble and cubes bob, nothing is collected. */
  present(dt: number): void {
    this.updateBoxes(dt);
    this.updateCubes(dt, false);
  }

  private updateBullets(dt: number): void {
    let count = 0;
    for (const bullet of this.bullets) {
      advanceBullet(this, bullet, dt);
      if (!bullet.alive) {
        continue;
      }
      drawBullet(this.bulletMesh, count, bullet);
      count += 1;
      lightBullet(this.game, bullet, dt);
    }
    this.bullets = this.bullets.filter((bullet) => bullet.alive);
    this.bulletMesh.count = count;
    this.bulletMesh.instanceMatrix.needsUpdate = true;
    if (this.bulletMesh.instanceColor) {
      this.bulletMesh.instanceColor.needsUpdate = true;
    }
  }

  private updateBombs(dt: number): void {
    for (const bomb of this.bombs) {
      stepBomb(this, bomb, dt);
    }
    this.bombs = this.bombs.filter((bomb) => !bomb.done);
  }

  // Boxes wobble and glow brighter for a moment after each hit.
  private updateBoxes(dt: number): void {
    const { elapsed, lighting } = this.game;
    for (const box of this.boxes) {
      if (!box.alive) {
        continue;
      }
      box.shake = Math.max(0, box.shake - dt * 5);
      const { shake } = box;
      box.mesh.rotation.z = Math.sin(elapsed * 60) * 0.09 * shake;
      box.mesh.scale.setScalar(1 + shake * 0.08);
      box.mat.emissiveIntensity = 1.1 + lighting.night * 1.6 + shake * 3;
    }
  }

  // Cubes arc from where they spawned to their resting tile, then bob and spin
  // until a brawler walks over them.
  private updateCubes(dt: number, collect = true): void {
    const { elapsed, lighting } = this.game;
    for (const cube of this.cubes) {
      cube.t += dt;
      const k = clamp(cube.t / 0.45, 0, 1);
      const x = lerp(cube.sx, cube.x, k);
      const z = lerp(cube.sz, cube.z, k);
      const bob = k >= 1 ? Math.sin(elapsed * 3 + cube.phase) * 0.08 : 0;
      const y = 0.42 + Math.sin(k * Math.PI) * 1.1 + bob;
      cube.mesh.position.set(x, y, z);
      cube.mesh.rotation.set(0.6, elapsed * 1.8 + cube.phase, 0.6);
      lighting.addLight(x, y + 0.1, z, this.cubeLight, 1.6 + lighting.night * 1.6, 3.4);
      if (k >= 1 && collect) {
        this.collectCube(cube);
      }
    }
    this.cubes = this.cubes.filter((cube) => cube.alive);
  }

  private collectCube(cube: Cube): void {
    const { game } = this;
    for (const brawler of game.brawlers) {
      if (
        !brawler.alive ||
        brawler.airborne ||
        Math.hypot(brawler.x - cube.x, brawler.z - cube.z) >= 0.78
      ) {
        continue;
      }
      cube.alive = false;
      brawler.addCube();
      game.scene.remove(cube.mesh);
      game.effects.burst(cube.x, 0.7, cube.z, this.cubeLight, 12, 3.5);
      game.effects.flash(cube.x, 0.8, cube.z, this.cubeLight, 7, 5, 0.25);
      if (!brawler.hidden || brawler.isPlayer) {
        game.hud.floatText(brawler.x, 2, brawler.z, "POWER UP!", "power");
      }
      game.audio.play("pickup", cube.x, cube.z);
      return;
    }
  }

  clear(): void {
    const { scene } = this.game;
    this.bullets.length = 0;
    this.bulletMesh.count = 0;
    for (const bomb of this.bombs) {
      bomb.slot.busy = false;
      bomb.slot.group.visible = false;
      bomb.slot.ring.visible = false;
    }
    this.bombs.length = 0;
    for (const box of this.boxes) {
      if (box.alive) {
        scene.remove(box.mesh);
      }
      box.mat.dispose();
    }
    this.boxes.length = 0;
    for (const cube of this.cubes) {
      scene.remove(cube.mesh);
    }
    this.cubes.length = 0;
  }
}
