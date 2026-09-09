// Bridges the authoritative sim World → Three.js. Maintains one visual per
// entity, creates/removes them as the World changes, and picks each champion's
// animation clip from its unit state. Never mutates the sim.
import * as THREE from "three";
import { CHAMP_BY_ID } from "../data/champions";
import { CLIP_TIMING } from "../data/clip-timing";
import { BOSS_HEIGHT, BOSS_POS } from "../data/map";
import { destructibleProps } from "../data/props";
import type { Coin, Projectile, Unit, World } from "../sim/types";
import type { ModelLibrary } from "./models";
import { AnimatedCharacter } from "./animated-character";
import { terrainHeight } from "../data/terrain";
import type { Fx } from "./fx";
import { energyBallMaterial } from "./fx-shaders";
import type { PlateAnchor } from "./hud-readability";
import { groundFxColor } from "./telegraph";
import { teamColor } from "./palette";
import { disposeMat } from "./instance-mats";
import { PropView } from "./prop-view";
import { UnitView } from "./unit-view";
import type { ViewDef } from "./unit-view";

const CREEP_VIEW = new Map<string, ViewDef>(
  Object.entries({
    frostgolem: {
      attackDamageType: "physical",
      attackType: "melee",
      id: "frostgolem",
      model: "FrostGolem",
      rig: "large",
      scale: 1.45,
      weaponR: "FrostGolem_Axe_Large",
    },
    skmage: {
      attackDamageType: "magic",
      attackType: "ranged",
      id: "skmage",
      model: "Skeleton_Mage",
      weaponR: "Skeleton_Staff",
    },
    skminion: {
      attackDamageType: "physical",
      attackType: "melee",
      id: "skminion",
      model: "Skeleton_Minion",
    },
    skwarrior: {
      attackDamageType: "physical",
      attackType: "melee",
      id: "skwarrior",
      model: "Skeleton_Warrior",
    },
  } satisfies Record<string, ViewDef>),
);

// ── creep loot pickups (Fantasy Weapons Bits) ────────────────────────────────
// A creep drop (coin.loot) renders as a spinning weapon piece instead of a boss
// coin. The piece is picked by hashing the synced coin id, so every client
// shows the same weapon without another wire field (and no Math.random).
const LOOT_WEAPONS = [
  "sword_A",
  "sword_D",
  "axe_A",
  "hammer_B",
  "dagger_A",
  "spear_A",
  "staff_B",
  "wand_B",
];
// world units for the piece's largest dimension
const LOOT_HEIGHT = 0.9;

const hashId = (id: string): number => {
  let h = 0;
  for (let i = 0; i < id.length; i += 1) {
    // oxlint-disable-next-line no-bitwise -- uint32 wrap keeps the hash in range
    h = (h * 31 + (id.codePointAt(i) ?? 0)) >>> 0;
  }
  return h;
};

/** Build a loot pickup: the hashed weapon piece, centered, small, laid at a
 *  jaunty angle inside a pivot group (the pivot spins/bobs like a coin). */
const makeLootPickup = (lib: ModelLibrary, id: string): THREE.Group => {
  const h = hashId(id);
  const piece = lib.instance(LOOT_WEAPONS[h % LOOT_WEAPONS.length] ?? "sword_A");
  const box = new THREE.Box3().setFromObject(piece);
  const size = new THREE.Vector3();
  box.getSize(size);
  const s = LOOT_HEIGHT / Math.max(0.1, Math.max(size.x, size.y, size.z));
  piece.scale.setScalar(s);
  const center = new THREE.Vector3();
  box.getCenter(center);
  piece.position.set(-center.x * s, -center.y * s, -center.z * s);
  // jaunty display angle — leaned over like it stuck in the ground sideways
  const tilt = new THREE.Group();
  tilt.add(piece);
  tilt.rotation.z = 0.55 + (h % 3) * 0.12;
  tilt.rotation.x = 0.25;
  const pivot = new THREE.Group();
  pivot.add(tilt);
  return pivot;
};

const PROJECTILE_COLOR = new Map<string, number>([
  ["arrow", 0xff_e6_a0],
  ["bolt", 0xb0_70_ff],
  ["fireball", 0xff_7a_2c],
  ["hexbolt", 0x7f_e0_8a],
]);
const projectileColor = (kind: string): number => PROJECTILE_COLOR.get(kind) ?? 0xff_ff_ff;

// Projectile geometry/materials are SHARED per kind (projectiles churn fast —
// per-instance allocations leaked GPU buffers since nothing disposed them).
const PROJ_GEO = {
  shaft: new THREE.CylinderGeometry(0.05, 0.05, 1, 6),
  shard: new THREE.ConeGeometry(0.16, 1.1, 6),
  sphere: new THREE.SphereGeometry(1, 12, 12),
};

const projMatCache = new Map<string, THREE.MeshBasicMaterial>();

const projMat = (key: string, make: () => THREE.MeshBasicMaterial): THREE.MeshBasicMaterial => {
  let m = projMatCache.get(key);
  if (!m) {
    m = make();
    projMatCache.set(key, m);
  }
  return m;
};

const haloMat = (color: number, opacity: number): THREE.MeshBasicMaterial =>
  projMat(
    `halo:${color}:${opacity}`,
    () =>
      new THREE.MeshBasicMaterial({
        blending: THREE.AdditiveBlending,
        color,
        depthWrite: false,
        opacity,
        transparent: true,
      }),
  );

const makeProjectileMesh = (p: Projectile): THREE.Object3D => {
  const color = projectileColor(p.kind);
  const g = new THREE.Group();

  if (p.kind === "arrow") {
    const shaft = new THREE.Mesh(
      PROJ_GEO.shaft,
      projMat("shaft", () => new THREE.MeshBasicMaterial({ color: 0xcf_a1_5a })),
    );
    shaft.rotation.x = Math.PI / 2;
    const tip = new THREE.Mesh(PROJ_GEO.sphere, haloMat(color, 1));
    tip.scale.setScalar(0.13);
    tip.position.z = 0.5;
    g.add(shaft, tip);
  } else if (p.kind === "bolt") {
    // bone spear — an elongated glowing shard along its travel direction
    const shard = new THREE.Mesh(PROJ_GEO.shard, haloMat(color, 0.95));
    // point along +z (velocity)
    shard.rotation.x = Math.PI / 2;
    const glow = new THREE.Mesh(PROJ_GEO.sphere, haloMat(color, 0.3));
    glow.scale.setScalar(0.28);
    g.add(shard, glow);
  } else {
    // boiling energy core (fbm shader surface, HDR — blooms) + additive halo
    const coreR = p.kind === "fireball" ? 0.38 : 0.2;
    const core = new THREE.Mesh(PROJ_GEO.sphere, energyBallMaterial(color));
    core.scale.setScalar(coreR);
    const halo = new THREE.Mesh(PROJ_GEO.sphere, haloMat(color, 0.35));
    halo.scale.setScalar(coreR * 1.9);
    g.add(core, halo);
  }
  return g;
};

/** An aerial volley's shots LEAVE from the apex and descend to the normal
 *  projectile plane over their first few units of flight. The hexbolt wobbles
 *  drunkenly across its travel line (render-only — the sim path stays
 *  straight); everything else flies true. */
const placeProjectile = (p: Projectile, mesh: THREE.Object3D, now: number): void => {
  const drop = p.launchH * Math.max(0, 1 - p.traveled / 5);
  mesh.position.set(p.x, 1.1 + drop, p.y);
  mesh.rotation.y = Math.atan2(p.vx, p.vy);
  if (p.kind === "hexbolt") {
    const spd = Math.hypot(p.vx, p.vy) || 1;
    const wob = Math.sin(now * 0.02 + hashId(p.id) * 0.7) * 0.22;
    mesh.position.x += (-p.vy / spd) * wob;
    mesh.position.z += (p.vx / spd) * wob;
    mesh.position.y += Math.sin(now * 0.013 + hashId(p.id)) * 0.12;
  }
};

const viewDefFor = (u: Unit, isCreep: boolean): ViewDef => {
  const def = (isCreep ? CREEP_VIEW.get(u.champId) : CHAMP_BY_ID[u.champId]) ?? CHAMP_BY_ID.knight;
  if (!def) {
    throw new Error(`no view def for ${u.champId}`);
  }
  return def;
};

interface DeliveryView {
  group: THREE.Group;
  crate: THREE.Mesh;
  beam: THREE.Mesh;
}

const makeDeliveryView = (): DeliveryView => {
  const group = new THREE.Group();
  const crate = new THREE.Mesh(
    new THREE.BoxGeometry(1.1, 1.1, 1.1),
    new THREE.MeshStandardMaterial({
      color: 0x66_ff_cc,
      emissive: 0x22_cc_88,
      emissiveIntensity: 0.5,
      roughness: 0.6,
    }),
  );
  // no castShadow — static shadow map
  crate.position.y = 0.7;
  const beam = new THREE.Mesh(
    new THREE.CylinderGeometry(0.7, 1.3, 9, 16, 1, true),
    new THREE.MeshBasicMaterial({
      color: 0x66_ff_cc,
      depthWrite: false,
      opacity: 0.14,
      side: THREE.DoubleSide,
      transparent: true,
    }),
  );
  beam.position.y = 4.5;
  group.add(crate, beam);
  return { beam, crate, group };
};

const makeCoinMesh = (): THREE.Mesh =>
  new THREE.Mesh(
    new THREE.CylinderGeometry(0.45, 0.45, 0.14, 18),
    new THREE.MeshStandardMaterial({
      color: 0xff_d2_4a,
      emissive: 0xff_aa_20,
      emissiveIntensity: 1,
      metalness: 0.4,
      roughness: 0.4,
    }),
  );

export class WorldView {
  private units = new Map<string, UnitView>();
  private props = new Map<string, PropView>();
  // slot-indexed placement lookup
  private propSpecs = destructibleProps();
  private projectiles = new Map<string, THREE.Object3D>();
  private coins = new Map<string, THREE.Object3D>();
  private ownedCoins = new Set<THREE.Mesh>();
  private deliveries = new Map<string, DeliveryView>();
  private boss: AnimatedCharacter | null = null;
  private seenCoins = new Set<string>();
  private flyingCoins = new Set<string>();
  private coinTrailAt = new Map<string, number>();
  private coinSparkleAt = new Map<string, number>();
  private deliveryEmitAt = new Map<string, number>();
  // unit id → next zone-ember ms
  private emberNext = new Map<string, number>();
  // unit ids owning a live whirlwind zone
  private spinners = new Set<string>();
  private bossReturnAt = 0;
  private bossNextTaunt = 6000;
  private lastBossLaunchAt = -Infinity;
  private fireballFlip = false;
  // set by the scene, for projectile trails
  fx: Fx | null = null;
  localId = "";

  private scene: THREE.Scene;
  private lib: ModelLibrary;

  constructor(scene: THREE.Scene, lib: ModelLibrary) {
    this.scene = scene;
    this.lib = lib;
  }

  plateAnchor(id: string): PlateAnchor | null {
    return this.units.get(id)?.plateAnchor() ?? null;
  }

  setupBoss(): void {
    // the throne golem is a Rig_Large body — bind the Large clip set (the
    // Medium clips squash its proportions)
    this.boss = new AnimatedCharacter(this.lib, "Skeleton_Golem", "Large/");
    this.boss.root.position.set(
      BOSS_POS.x,
      terrainHeight(BOSS_POS.x, BOSS_POS.y) + BOSS_HEIGHT,
      BOSS_POS.y,
    );
    this.boss.root.scale.setScalar(1.5);
    this.scene.add(this.boss.root);
    this.boss.play("Idle_B", { fade: 0 });
  }

  /** Explicit match replacement reuses this view. Retained IDs cannot inherit
   * old character poses, pickup flights or decoration emission clocks. */
  resetCharacters(): void {
    for (const view of this.units.values()) {
      view.dispose(this.scene);
    }
    this.units.clear();
    for (const prop of this.props.values()) {
      prop.dispose(this.scene);
    }
    this.props.clear();
    // Projectile geometry and materials are shared caches, not per-shot owns.
    for (const projectile of this.projectiles.values()) {
      this.scene.remove(projectile);
    }
    this.projectiles.clear();
    for (const coin of this.coins.values()) {
      this.removeCoin(coin);
    }
    this.coins.clear();
    for (const delivery of this.deliveries.values()) {
      this.removeDelivery(delivery.group);
    }
    this.deliveries.clear();
    this.seenCoins.clear();
    this.flyingCoins.clear();
    this.coinTrailAt.clear();
    this.coinSparkleAt.clear();
    this.deliveryEmitAt.clear();
    this.emberNext.clear();
    this.spinners.clear();
    this.fireballFlip = false;
    this.bossReturnAt = 0;
    this.bossNextTaunt = 6000;
    this.lastBossLaunchAt = -Infinity;
    this.boss?.play("Idle_B", { fade: 0 });
  }

  sync(w: World, dt: number): void {
    const { now } = w;

    // units owning a live whirlwind loop their spin clip (knight R keeps
    // spinning visually for the zone's whole duration, not just the cast)
    this.spinners.clear();
    for (const g of w.grounds) {
      if (g.effect === "whirlwind" && g.until > now) {
        this.spinners.add(g.ownerId);
      }
    }

    this.syncUnits(w, now, dt);
    this.syncProjectiles(w, now);

    // grounds BEFORE coins: Telegraphs.sync advances the frame stamp that the
    // coin-landing marks (telegraphs.mark) must be stamped with.
    this.syncGrounds(w, now);
    this.syncCoins(w, now);
    this.syncDeliveries(w, now);
    this.syncBoss(now, dt);
  }

  /** Heroes + neutral creeps + destructible props. */
  private syncUnits(w: World, now: number, dt: number): void {
    const seen = new Set<string>();
    const seenProps = new Set<string>();
    for (const u of w.units.values()) {
      if (u.kind === "prop") {
        seenProps.add(u.id);
        this.propView(u).update(u, now, dt, this.fx);
        continue;
      }
      if (u.kind !== "hero" && u.kind !== "creep") {
        continue;
      }
      seen.add(u.id);
      this.unitView(u).update(u, now, dt, this.fx, this.spinners.has(u.id));
    }
    for (const [id, view] of this.units) {
      if (!seen.has(id)) {
        view.dispose(this.scene);
        this.units.delete(id);
        this.emberNext.delete(id);
      }
    }
    for (const [id, pv] of this.props) {
      if (!seenProps.has(id)) {
        pv.dispose(this.scene);
        this.props.delete(id);
      }
    }
  }

  private propView(u: Unit): PropView {
    const existing = this.props.get(u.id);
    if (existing) {
      return existing;
    }
    const pv = new PropView(this.scene, this.lib, u, this.propSpecs[u.slot]);
    this.props.set(u.id, pv);
    return pv;
  }

  /** A unit whose champ/team/local-ness changed since its view was built gets
   *  a fresh view. */
  private unitView(u: Unit): UnitView {
    const isLocal = u.kind === "hero" && u.id === this.localId;
    const existing = this.units.get(u.id);
    if (existing?.matches(u, isLocal)) {
      return existing;
    }
    if (existing) {
      existing.dispose(this.scene);
      this.units.delete(u.id);
      this.emberNext.delete(u.id);
    }
    const isCreep = u.kind === "creep";
    const color = isCreep ? 0x9a_a3_b5 : teamColor(u.team);
    const view = new UnitView(
      this.scene,
      this.lib,
      viewDefFor(u, isCreep),
      color,
      isLocal,
      isCreep,
      {
        champId: u.champId,
        team: u.team,
      },
    );
    this.units.set(u.id, view);
    this.scene.add(view.group);
    return view;
  }

  private syncProjectiles(w: World, now: number): void {
    const seenP = new Set<string>();
    for (const p of w.projectiles.values()) {
      seenP.add(p.id);
      let mesh = this.projectiles.get(p.id);
      if (!mesh) {
        mesh = makeProjectileMesh(p);
        this.projectiles.set(p.id, mesh);
        this.scene.add(mesh);
      }
      placeProjectile(p, mesh, now);
      // additive trail behind the projectile
      this.fx?.trail(mesh.position.x, mesh.position.z, projectileColor(p.kind));
      // the hex bolt drags a nest of helix ribbons — one draw call, built in
      // the vertex shader off the nose and heading we hand it here
      if (p.kind === "hexbolt") {
        const spd = Math.hypot(p.vx, p.vy) || 1;
        this.fx?.ribbons.follow(
          p.id,
          mesh.position.x,
          mesh.position.y,
          mesh.position.z,
          p.vx / spd,
          p.vy / spd,
          p.traveled,
        );
      }
      // fireballs drag a smoke tracer — matter under the energy
      if (p.kind === "fireball") {
        this.fireballFlip = !this.fireballFlip;
        if (this.fireballFlip) {
          this.fx?.smokePuff(p.x, 1.1, p.y);
        }
      }
    }
    for (const [id, mesh] of this.projectiles) {
      if (!seenP.has(id)) {
        this.scene.remove(mesh);
        this.projectiles.delete(id);
      }
    }
  }

  private syncBoss(now: number, dt: number): void {
    if (!this.boss) {
      return;
    }
    this.boss.update(dt);
    if (this.bossReturnAt && now >= this.bossReturnAt) {
      this.boss.play("Idle_B", { fade: 0.2 });
      this.bossReturnAt = 0;
    } else if (!this.bossReturnAt && now >= this.bossNextTaunt) {
      this.boss.play("Skeletons_Taunt", { fade: 0.2, loop: false });
      // return to idle when the clip actually ends (don't freeze on its last frame)
      this.bossReturnAt = now + this.boss.clipDuration("Skeletons_Taunt") * 1000;
      this.bossNextTaunt = now + 13_000;
    }
  }

  private syncCoins(w: World, now: number): void {
    const seen = new Set<string>();
    let launched: Coin | null = null;
    for (const c of w.coins) {
      seen.add(c.id);
      // a freshly-spawned, still-flying coin = the boss just hurled it → animate;
      // a fresh loot drop (lands instantly) gets its landing pop right away
      if (!this.seenCoins.has(c.id)) {
        this.seenCoins.add(c.id);
        if (!c.loot && now < c.landAt && (!launched || c.landAt > launched.landAt)) {
          launched = c;
        } else if (c.loot) {
          this.fx?.impactRing(c.x, c.y, 0xff_d2_4a, 1);
          this.fx?.sparks(c.x, 0.6, c.y, 0, 1, 5, 0xff_f2_b0);
          this.fx?.dust(c.x, c.y, 2);
        }
      }
      const mesh = this.coinMesh(c);
      // parabolic arc while flying, then bob+spin on the ground
      if (now < c.landAt) {
        this.flyCoin(c, mesh, now);
      } else {
        this.groundCoin(c, mesh, now);
      }
      if (c.loot) {
        // weapon piece: slow showcase spin (tilt lives on the inner group)
        mesh.rotation.y = now * 0.0022 + (hashId(c.id) % 7);
      } else {
        mesh.rotation.y = now * 0.005;
        mesh.rotation.x = Math.PI / 2;
      }
    }
    if (launched) {
      this.bossThrow(launched, now);
    }
    for (const [id, mesh] of this.coins) {
      if (!seen.has(id)) {
        this.removeCoin(mesh);
        this.coins.delete(id);
        this.seenCoins.delete(id);
        this.flyingCoins.delete(id);
        this.coinTrailAt.delete(id);
        this.coinSparkleAt.delete(id);
      }
    }
  }

  private coinMesh(c: Coin): THREE.Object3D {
    const existing = this.coins.get(c.id);
    if (existing) {
      return existing;
    }
    // no castShadow on either shape: the shadow map is static (rendered
    // once) — a moving pickup would leave a stale silhouette
    const mesh = c.loot ? makeLootPickup(this.lib, c.id) : makeCoinMesh();
    this.coins.set(c.id, mesh);
    if (!c.loot && mesh instanceof THREE.Mesh) {
      this.ownedCoins.add(mesh);
    }
    this.scene.add(mesh);
    return mesh;
  }

  private flyCoin(c: Coin, mesh: THREE.Object3D, now: number): void {
    const t = 1 - (c.landAt - now) / 900;
    const x = c.fromX + (c.x - c.fromX) * t;
    const z = c.fromY + (c.y - c.fromY) * t;
    const arc = Math.sin(t * Math.PI) * 6 + BOSS_HEIGHT * (1 - t);
    mesh.position.set(x, 0.5 + arc, z);
    this.flyingCoins.add(c.id);
    if (!this.fx) {
      return;
    }
    // landing telegraph: a gold sweep races the coin down — contest signal
    this.fx.telegraphs.mark(`coin:${c.id}`, c.x, c.y, 1.2, 0xff_d2_4a, Math.min(1, Math.max(0, t)));
    const lastTrail = this.coinTrailAt.get(c.id) ?? 0;
    if (now - lastTrail > 40) {
      this.coinTrailAt.set(c.id, now);
      this.fx.trailAt(x, 0.5 + arc, z, 0xff_d2_4a, 0.35);
    }
  }

  private groundCoin(c: Coin, mesh: THREE.Object3D, now: number): void {
    if (this.flyingCoins.has(c.id)) {
      // landing frame: thump + sparks
      this.flyingCoins.delete(c.id);
      this.fx?.impactRing(c.x, c.y, 0xff_d2_4a, 1.2);
      this.fx?.sparks(c.x, 0.6, c.y, 0, 1, 6, 0xff_d2_4a);
      this.fx?.dust(c.x, c.y, 2);
    }
    mesh.position.set(c.x, terrainHeight(c.x, c.y) + 0.6 + Math.sin(now * 0.004) * 0.15, c.y);
    // grounded pickups wink — a cheap "come get me"
    const lastSparkle = this.coinSparkleAt.get(c.id) ?? 0;
    if (this.fx && now - lastSparkle > 700) {
      this.coinSparkleAt.set(c.id, now);
      this.fx.crossGlint(c.x, terrainHeight(c.x, c.y) + 0.9, c.y, 1, 0, 0xff_f2_b0, 0.5);
    }
  }

  /** Large has no Throw clip: its existing fallback is this native 2H release
   *  (measured right-hand peak at 35%). The coin has already left. */
  private bossThrow(launched: Coin, now: number): void {
    if (!this.boss) {
      return;
    }
    const launchAt = launched.landAt - 900;
    if (launchAt <= this.lastBossLaunchAt || launchAt > now) {
      return;
    }
    this.lastBossLaunchAt = launchAt;
    const timing = CLIP_TIMING.get("Melee_2H_Attack");
    const duration = this.boss.clipDuration("Melee_2H_Attack");
    const age = (now - launchAt) / 1000;
    const offset = duration * (timing?.contact ?? 0.35) + age;
    if (offset < duration) {
      this.boss.play("Melee_2H_Attack", { fade: age > 0.1 ? 0 : 0.06, loop: false, offset });
      this.bossReturnAt = now + (duration - offset) * 1000;
    }
  }

  private syncDeliveries(w: World, now: number): void {
    const seen = new Set<string>();
    for (const d of w.deliveries) {
      seen.add(d.id);
      let view = this.deliveries.get(d.id);
      if (!view) {
        view = makeDeliveryView();
        this.deliveries.set(d.id, view);
        this.scene.add(view.group);
      }
      view.group.position.set(d.x, terrainHeight(d.x, d.y), d.y);
      view.group.rotation.y = now * 0.0015;
      view.crate.position.y = 0.7 + Math.sin(now * 0.003) * 0.18;
      // beacon pulse + a double-helix of motes climbing the beam
      view.beam.scale.setScalar(1 + 0.06 * (0.5 + 0.5 * Math.sin(now * 0.004)));
      if (this.fx) {
        const last = this.deliveryEmitAt.get(d.id) ?? 0;
        if (now - last > 120) {
          this.deliveryEmitAt.set(d.id, now);
          const a = now * 0.004;
          for (const off of [0, Math.PI]) {
            this.fx.mote(
              d.x + Math.cos(a + off) * 0.9,
              0.4,
              d.y + Math.sin(a + off) * 0.9,
              0x66_ff_cc,
              2.4,
              0.7,
              0.22,
            );
          }
        }
      }
    }
    for (const [id, view] of this.deliveries) {
      if (!seen.has(id)) {
        this.removeDelivery(view.group);
        this.deliveries.delete(id);
        this.deliveryEmitAt.delete(id);
      }
    }
  }

  private removeCoin(object: THREE.Object3D): void {
    this.scene.remove(object);
    // Loot pieces use library geometry/materials. Only the procedural gold
    // cylinder owns resources here, and each removal releases them once.
    if (object instanceof THREE.Mesh && this.ownedCoins.delete(object)) {
      object.geometry.dispose();
      disposeMat(object.material);
    }
  }

  private removeDelivery(group: THREE.Group): void {
    this.scene.remove(group);
    for (const child of group.children) {
      if (!(child instanceof THREE.Mesh)) {
        continue;
      }
      child.geometry.dispose();
      disposeMat(child.material);
    }
  }

  private syncGrounds(w: World, now: number): void {
    const { fx } = this;
    if (!fx) {
      return;
    }
    const localTeam = w.units.get(this.localId)?.team ?? "";
    fx.telegraphs.sync(w.grounds, localTeam, now);
    for (const g of w.grounds) {
      fx.zoneAmbient(g, now);
      // ambient-ize silent tick damage: units standing in a hostile dps zone
      // shed embers in the zone color (throttled per unit)
      if (!g.enemyDps) {
        continue;
      }
      const r2 = g.radius * g.radius;
      for (const u of w.units.values()) {
        if (!u.alive || u.team === g.team) {
          continue;
        }
        if (u.kind !== "hero" && u.kind !== "creep") {
          continue;
        }
        if ((u.x - g.x) ** 2 + (u.y - g.y) ** 2 > r2) {
          continue;
        }
        const next = this.emberNext.get(u.id) ?? 0;
        if (now < next) {
          continue;
        }
        this.emberNext.set(u.id, now + 250);
        fx.zoneEmber(u.x, u.y, groundFxColor(g.effect));
      }
    }
  }
}
