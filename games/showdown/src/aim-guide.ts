// The translucent ground overlay under the player that previews the current
// attack: a sector for weapon sweeps, a strip for arrows (cut short
// at the first wall), and a range line ending in a blast circle for lobs and
// leaps. Gold while a super is being aimed, white otherwise.

import * as THREE from "three";

import type { AttackDef, BrawlerDef } from "./config";
import type { Brawler } from "./entities/brawler";
import { clamp } from "./utils";
import type { World } from "./world/world";

export type GuideSlot = "attack" | "super";

const SUPER_TINT = 0xff_d2_3a;
const NORMAL_TINT = 0xff_ff_ff;

const guideMaterial = (): THREE.MeshBasicMaterial =>
  new THREE.MeshBasicMaterial({
    color: NORMAL_TINT,
    depthWrite: false,
    opacity: 0.18,
    transparent: true,
  });

type GuideMesh = THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>;

export class AimGuide {
  readonly group: THREE.Group;
  private readonly rect: GuideMesh;
  private readonly sector: GuideMesh;
  private readonly circle: GuideMesh;
  private readonly ring: GuideMesh;
  private readonly sectorGeos: Partial<Record<GuideSlot, THREE.CircleGeometry>> = {};

  constructor(scene: THREE.Scene) {
    const group = new THREE.Group();
    group.userData.noAO = true;
    group.position.y = 0.06;
    group.visible = false;
    this.rect = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1, 24, 1).rotateX(-Math.PI / 2).translate(0.5, 0, 0),
      guideMaterial(),
    );
    this.sector = new THREE.Mesh(new THREE.BufferGeometry(), guideMaterial());
    this.circle = new THREE.Mesh(
      new THREE.CircleGeometry(1, 48).rotateX(-Math.PI / 2),
      guideMaterial(),
    );
    this.ring = new THREE.Mesh(
      new THREE.RingGeometry(0.93, 1, 48).rotateX(-Math.PI / 2),
      guideMaterial(),
    );
    this.ring.material.opacity = 0.7;
    this.circle.add(this.ring);
    for (const mesh of [this.rect, this.sector, this.circle]) {
      mesh.renderOrder = 3;
      group.add(mesh);
    }
    this.group = group;
    scene.add(group);
  }

  /** Bake a cone geometry per spread attack of the chosen kit (slightly wider than the pellet fan). */
  setupFor(def: BrawlerDef): void {
    for (const slot of ["attack", "super"] as const) {
      const attack = def[slot];
      if (attack.kind !== "spread" && attack.kind !== "melee") {
        continue;
      }
      const arc = attack.kind === "melee" ? attack.arc : attack.spread + 0.14;
      this.sectorGeos[slot]?.dispose();
      this.sectorGeos[slot] = new THREE.CircleGeometry(1, 28, -arc / 2, arc).rotateX(-Math.PI / 2);
    }
  }

  hide(): void {
    this.group.visible = false;
  }

  private showSector(slot: GuideSlot, range: number, tint: number, opacity: number): void {
    const geometry = this.sectorGeos[slot];
    if (geometry) {
      this.sector.geometry = geometry;
    }
    this.sector.scale.set(range, 1, range);
    this.sector.visible = true;
    this.sector.material.color.set(tint);
    this.sector.material.opacity = opacity;
  }

  /** Arrows stop at the first wall unless the attack breaks it. */
  private showStrip(
    player: Brawler,
    world: World,
    attack: AttackDef,
    dx: number,
    dz: number,
    tint: number,
    opacity: number,
  ): void {
    let length = attack.range;
    const hit = world.raycast(
      player.x,
      player.z,
      player.x + dx * attack.range,
      player.z + dz * attack.range,
    );
    if (hit && !(attack.breaksWalls && world.isBreakable(hit.tx, hit.ty))) {
      length = Math.max(0.6, hit.dist);
    }
    const radius = attack.kind === "burst" ? attack.radius : 0;
    this.rect.scale.set(length, 1, Math.max(0.42, radius * 2.6));
    this.rect.visible = true;
    this.rect.material.color.set(tint);
    this.rect.material.opacity = opacity;
  }

  private showBlast(attack: AttackDef, aimDist: number, tint: number, opacity: number): void {
    const blast = attack.kind === "lob" || attack.kind === "leap" ? attack.blast : 0;
    const reach = clamp(aimDist, attack.kind === "leap" ? 2 : 0.5, attack.range);
    this.circle.position.set(reach, 0, 0);
    this.circle.scale.set(blast, 1, blast);
    this.circle.visible = true;
    this.circle.material.color.set(tint);
    this.circle.material.opacity = opacity * 0.8;
    this.ring.material.color.set(tint);
    this.rect.scale.set(Math.max(0.1, reach - blast), 1, 0.12);
    this.rect.visible = true;
    this.rect.material.color.set(tint);
    this.rect.material.opacity = opacity;
  }

  show(
    player: Brawler,
    world: World,
    attack: AttackDef,
    slot: GuideSlot,
    dx: number,
    dz: number,
    aimDist: number,
    isSuper: boolean,
  ): void {
    const { group } = this;
    group.visible = true;
    group.position.set(player.x, world.heightAt(player.x, player.z) + 0.06, player.z);
    group.rotation.y = Math.atan2(dx, dz) - Math.PI / 2;
    const tint = isSuper ? SUPER_TINT : NORMAL_TINT;
    const opacity = isSuper ? 0.34 : 0.17;
    this.rect.visible = false;
    this.sector.visible = false;
    this.circle.visible = false;
    if (attack.kind === "spread" || attack.kind === "melee") {
      this.showSector(slot, attack.range, tint, opacity);
    } else if (attack.kind === "burst") {
      this.showStrip(player, world, attack, dx, dz, tint, opacity);
    } else {
      this.showBlast(attack, aimDist, tint, opacity);
    }
    this.conformToGround(world);
  }

  private conformToGround(world: World): void {
    this.group.updateMatrixWorld(true);
    const point = new THREE.Vector3();
    for (const mesh of [this.rect, this.sector, this.circle, this.ring]) {
      if (!mesh.visible || (mesh === this.ring && !this.circle.visible)) {
        continue;
      }
      const positions = mesh.geometry.getAttribute("position");
      if (!positions) {
        continue;
      }
      for (let i = 0; i < positions.count; i += 1) {
        point.set(positions.getX(i), 0, positions.getZ(i));
        mesh.localToWorld(point);
        point.y = world.heightAt(point.x, point.z) + 0.06;
        mesh.worldToLocal(point);
        positions.setY(i, point.y);
      }
      positions.needsUpdate = true;
    }
  }
}
