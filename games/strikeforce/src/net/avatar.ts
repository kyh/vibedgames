// Another player as everyone else sees them: a low-poly trooper built from
// primitives (the game itself is first person and has no body), with a visor
// in one colour and no name plate: you have to find who you are fighting. Two
// invisible hitboxes — head and body — follow every pose, and are what local
// shots are tested against (`hitboxes`). Faces -Z at yaw 0, like the camera,
// so `rotation.y = yaw` turns it with the player.
import {
  BoxGeometry,
  CylinderGeometry,
  Group,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  SphereGeometry,
} from "three";
import type { Material, Object3D } from "three";

const ARMOR = new MeshStandardMaterial({ color: 0xd9_d6_cc, metalness: 0.1, roughness: 0.62 });
const CLOTH = new MeshStandardMaterial({ color: 0x2d_33_38, metalness: 0, roughness: 0.9 });
const HITBOX = new MeshBasicMaterial();
const GUNMETAL = new MeshStandardMaterial({ color: 0x1d_21_24, metalness: 0.6, roughness: 0.45 });

const box = (w: number, h: number, d: number, material: Material): Mesh => {
  const mesh = new Mesh(new BoxGeometry(w, h, d), material);
  mesh.castShadow = true;
  return mesh;
};

/** A hip or shoulder: rotating the pivot swings what hangs from it. */
const pivot = (x: number, y: number, z: number, child: Object3D, drop: number): Group => {
  const joint = new Group();
  joint.position.set(x, y, z);
  child.position.y = -drop;
  joint.add(child);
  return joint;
};

export interface AvatarPose {
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
  crouch: number;
  alive: boolean;
}

export class Avatar {
  readonly root = new Group();
  private readonly body = new Group();
  private readonly head = new Group();
  private readonly legs: Group[] = [];
  private readonly arms = new Group();
  private readonly visor: MeshBasicMaterial;
  /** Invisible boxes local shots hit; `userData.part` is "head" or "body". */
  readonly hitboxes: Mesh[] = [];
  private stride = 0;
  private lastX = 0;
  private lastZ = 0;
  private down = 0;
  private crouch = 0;

  constructor(callsign: string, color: string) {
    this.visor = new MeshBasicMaterial({ color });
    const torso = box(0.46, 0.56, 0.28, ARMOR);
    torso.position.y = 1.2;
    const belt = box(0.44, 0.12, 0.26, CLOTH);
    belt.position.y = 0.9;
    const pack = box(0.36, 0.42, 0.16, CLOTH);
    pack.position.set(0, 1.22, 0.21);
    const stripe = box(0.47, 0.06, 0.29, this.visor);
    stripe.position.y = 1.36;
    this.body.add(torso, belt, pack, stripe);

    const helmet = new Mesh(new SphereGeometry(0.15, 14, 10), ARMOR);
    helmet.castShadow = true;
    const visor = box(0.22, 0.06, 0.06, this.visor);
    visor.position.set(0, 0, -0.13);
    this.head.add(helmet, visor);
    this.head.position.y = 1.62;
    this.body.add(this.head);

    for (const side of [-1, 1]) {
      const leg = pivot(side * 0.12, 0.86, 0, box(0.16, 0.84, 0.18, CLOTH), 0.42);
      this.legs.push(leg);
      this.body.add(leg);
    }

    // Both arms carry the rifle, so they pitch together with the aim.
    const rifle = box(0.07, 0.1, 0.78, GUNMETAL);
    rifle.position.set(0.02, -0.02, -0.4);
    const barrel = new Mesh(new CylinderGeometry(0.016, 0.016, 0.3, 6), GUNMETAL);
    barrel.rotation.x = Math.PI / 2;
    barrel.position.set(0.02, 0, -0.92);
    const armR = box(0.11, 0.11, 0.42, ARMOR);
    armR.position.set(0.16, -0.04, -0.12);
    const armL = box(0.11, 0.11, 0.46, ARMOR);
    armL.position.set(-0.12, -0.06, -0.24);
    this.arms.add(rifle, barrel, armR, armL);
    this.arms.position.set(0.04, 1.36, -0.08);
    this.body.add(this.arms);

    // Raycasts ignore `visible`, so hidden boxes still take hits.
    const head = new Mesh(new BoxGeometry(0.34, 0.34, 0.34), HITBOX);
    head.position.y = 1.62;
    head.userData.part = "head";
    const chest = new Mesh(new BoxGeometry(0.56, 1.42, 0.44), HITBOX);
    chest.position.y = 0.72;
    chest.userData.part = "body";
    for (const hitbox of [head, chest]) {
      hitbox.visible = false;
      this.hitboxes.push(hitbox);
      this.body.add(hitbox);
    }

    this.root.add(this.body);
    this.root.name = `squad:${callsign}`;
  }

  update(pose: AvatarPose, dt: number): void {
    const { root } = this;
    root.position.set(pose.x, pose.y, pose.z);
    root.rotation.y = pose.yaw;
    const moved = Math.hypot(pose.x - this.lastX, pose.z - this.lastZ);
    this.lastX = pose.x;
    this.lastZ = pose.z;
    const speed = dt > 0 ? Math.min(8, moved / dt) : 0;
    this.stride += speed * dt * 2.6;
    const swing = Math.sin(this.stride) * Math.min(1, speed / 3) * 0.6;
    this.legs[0]?.rotation.set(swing, 0, 0);
    this.legs[1]?.rotation.set(-swing, 0, 0);

    const ease = 1 - Math.exp(-10 * dt);
    this.crouch += (pose.crouch - this.crouch) * ease;
    this.down += ((pose.alive ? 0 : 1) - this.down) * (1 - Math.exp(-6 * dt));
    this.body.position.y = -this.crouch * 0.45;
    this.arms.rotation.x = pose.pitch;
    this.head.rotation.x = pose.pitch * 0.6;
    // Down: fall onto the back.
    this.body.rotation.x = this.down * (Math.PI / 2 - 0.1);
    this.body.position.z = this.down * 0.8;
  }

  dispose(): void {
    this.root.removeFromParent();
    this.root.traverse((node) => {
      if (node instanceof Mesh) {
        node.geometry.dispose();
      }
    });
    this.visor.dispose();
  }
}
