// A soldier, built from primitives in code like the rest of the dock: the game
// downloads nothing. Two kits share one body — `operator` (coyote, the colour
// every deathmatch fighter wears) and `garrison` (urban grey camo, a red
// armband: the dock's crew in Mission and Holdout).
//
// Each limb is one merged mesh with baked vertex colours, so a soldier is ten
// draw calls; fabric carries a `camo` weight the material turns into a
// blotch pattern. Geometry is built once per kit and shared. Two invisible
// hitboxes — head and body — follow every pose. Faces -Z at yaw 0, like the
// camera, so `rotation.y = yaw` turns it with the player.
import { BoxGeometry, Group, Mesh, MeshBasicMaterial } from "three";
import type { BufferGeometry, Vector3 } from "three";

import { HIP_Y, KNEE_DROP, MUZZLE, NECK_Y, SHOULDER_Y, kitAssets } from "./soldier-kit";
import type { Kit } from "./soldier-kit";

export type { Kit } from "./soldier-kit";

const HITBOX = new MeshBasicMaterial();

export interface SoldierPose {
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
  /** 0 standing, 1 crouched. */
  crouch: number;
  alive: boolean;
}

export class SoldierModel {
  readonly root = new Group();
  /** Invisible boxes shots are tested against; `userData.part` is "head" or "body". */
  readonly hitboxes: Mesh[] = [];
  private readonly body = new Group();
  private readonly torso = new Group();
  private readonly head = new Group();
  private readonly arms = new Group();
  private readonly hips: Group[] = [];
  private readonly knees: Group[] = [];
  private stride = 0;
  private lastX = Number.NaN;
  private lastZ = 0;
  private speed = 0;
  private down = 0;
  private crouch = 0;
  private flinchT = 0;
  private flinchSide = 1;

  constructor(kit: Kit, name: string) {
    const { geometry, material } = kitAssets(kit);
    const mesh = (g: BufferGeometry): Mesh => {
      const m = new Mesh(g, material);
      m.castShadow = true;
      return m;
    };
    this.body.add(mesh(geometry.pelvis));
    this.torso.add(mesh(geometry.torso));
    this.head.position.y = NECK_Y;
    this.head.add(mesh(geometry.head));
    this.arms.position.y = SHOULDER_Y;
    this.arms.add(mesh(geometry.arms));
    this.torso.add(this.head, this.arms);
    // The torso bends at the waist, so flinches and aim lean read from there.
    this.torso.position.y = HIP_Y + 0.08;
    for (const child of this.torso.children) {
      child.position.y -= HIP_Y + 0.08;
    }
    this.body.add(this.torso);

    for (const side of [-1, 1]) {
      const hip = new Group();
      hip.position.set(side * 0.1, HIP_Y, 0);
      hip.add(mesh(geometry.thigh));
      const knee = new Group();
      knee.position.y = -KNEE_DROP;
      knee.add(mesh(geometry.shin));
      hip.add(knee);
      this.hips.push(hip);
      this.knees.push(knee);
      this.body.add(hip);
    }

    // Raycasts ignore `visible`, so hidden boxes still take hits.
    const headBox = new Mesh(new BoxGeometry(0.32, 0.32, 0.32), HITBOX);
    headBox.position.y = 1.63;
    headBox.userData.part = "head";
    const chest = new Mesh(new BoxGeometry(0.56, 1.42, 0.44), HITBOX);
    chest.position.y = 0.72;
    chest.userData.part = "body";
    for (const hitbox of [headBox, chest]) {
      hitbox.visible = false;
      this.hitboxes.push(hitbox);
      this.body.add(hitbox);
    }

    this.root.add(this.body);
    this.root.name = `soldier:${name}`;
  }

  /** A hit from `side` (-1 left, 1 right): the torso snaps away from it. */
  flinch(side: number): void {
    this.flinchT = 1;
    this.flinchSide = side < 0 ? -1 : 1;
  }

  /** Where the carbine's muzzle is in the world. */
  muzzle(out: Vector3): Vector3 {
    this.root.updateMatrixWorld(true);
    return this.arms.localToWorld(out.copy(MUZZLE));
  }

  update(pose: SoldierPose, dt: number): void {
    const { root } = this;
    root.position.set(pose.x, pose.y, pose.z);
    root.rotation.y = pose.yaw;
    if (Number.isNaN(this.lastX)) {
      this.lastX = pose.x;
      this.lastZ = pose.z;
    }
    const moved = Math.hypot(pose.x - this.lastX, pose.z - this.lastZ);
    this.lastX = pose.x;
    this.lastZ = pose.z;
    const k = 1 - Math.exp(-10 * dt);
    this.speed += ((dt > 0 ? Math.min(8, moved / dt) : 0) - this.speed) * k;
    this.crouch += (pose.crouch - this.crouch) * k;
    this.down += ((pose.alive ? 0 : 1) - this.down) * (1 - Math.exp(-6 * dt));
    this.flinchT = Math.max(0, this.flinchT - dt * 5);
    this.stride += this.speed * dt * 2.3;

    const gait = Math.min(1, this.speed / 3.5);
    const swing = Math.sin(this.stride) * gait * 0.7;
    for (const [i, hip] of this.hips.entries()) {
      const s = i === 0 ? swing : -swing;
      // Positive X rotation swings a limb forward (-Z).
      hip.rotation.x = s + this.crouch * 1.2;
      const knee = this.knees[i];
      if (knee) {
        // The trailing leg folds; a crouch folds both.
        knee.rotation.x = Math.min(0, s) * 1.3 * gait - this.crouch * 2;
      }
    }
    const bob = Math.abs(Math.cos(this.stride)) * 0.035 * gait;
    this.body.position.y = -this.crouch * 0.42 + bob - 0.035 * gait;
    this.torso.rotation.x = -0.12 * gait - this.crouch * 0.2;
    this.torso.rotation.y = this.flinchT * 0.35 * this.flinchSide;
    this.torso.rotation.z = this.flinchT * 0.12 * this.flinchSide;
    this.arms.rotation.x = pose.pitch;
    this.head.rotation.x = pose.pitch * 0.6;

    // Down: fall onto the back.
    this.body.rotation.x = this.down * (Math.PI / 2 - 0.1);
    this.body.position.z = this.down * 0.8;
  }

  /** Leave the scene. Geometry and material are the kit's, shared. */
  dispose(): void {
    this.root.removeFromParent();
  }
}
