// A kart: a chunky low-poly wedge with an underglow strip in its paint colour.
// Built facing +x from shared geometry, so a full grid costs six small groups.

import * as THREE from "three";

const BODY = new THREE.BoxGeometry(2.3, 0.42, 1.25);
const NOSE = new THREE.BoxGeometry(0.9, 0.3, 0.9);
const SEAT = new THREE.BoxGeometry(0.7, 0.55, 0.8);
const WING = new THREE.BoxGeometry(0.28, 0.1, 1.5);
const STRUT = new THREE.BoxGeometry(0.1, 0.42, 0.1);
const HELMET = new THREE.SphereGeometry(0.34, 10, 8);
const VISOR = new THREE.BoxGeometry(0.2, 0.16, 0.5);
const WHEEL = new THREE.CylinderGeometry(0.4, 0.4, 0.34, 10).rotateX(Math.PI / 2);
const GLOW = new THREE.BoxGeometry(2.5, 0.06, 1.5);
const LAMP = new THREE.BoxGeometry(0.08, 0.14, 0.3);

const DARK = new THREE.MeshStandardMaterial({
  color: "#16161d",
  flatShading: true,
  roughness: 0.6,
});
const TYRE = new THREE.MeshStandardMaterial({
  color: "#0b0b0f",
  flatShading: true,
  roughness: 0.9,
});
const VISOR_MAT = new THREE.MeshStandardMaterial({ color: "#0a0a12", roughness: 0.2 });

const WHEEL_AT: readonly (readonly [number, number, boolean])[] = [
  [0.82, 0.78, true],
  [0.82, -0.78, true],
  [-0.78, 0.82, false],
  [-0.78, -0.82, false],
];

export class KartMesh {
  readonly group = new THREE.Group();
  /** Everything that leans, hops and rolls; the group itself only places and yaws. */
  private readonly body = new THREE.Group();
  private readonly paint: THREE.MeshStandardMaterial;
  private readonly glow: THREE.MeshBasicMaterial;
  private readonly wheels: THREE.Mesh[] = [];
  private readonly steerable: THREE.Object3D[] = [];
  private lean = 0;
  private hop = 0;

  constructor(color: THREE.Color) {
    this.paint = new THREE.MeshStandardMaterial({
      color,
      emissive: color,
      emissiveIntensity: 0.1,
      flatShading: true,
      metalness: 0.2,
      roughness: 0.35,
    });
    this.glow = new THREE.MeshBasicMaterial({ color, toneMapped: false });

    const add = (geo: THREE.BufferGeometry, mat: THREE.Material, x: number, y: number, z = 0) => {
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.set(x, y, z);
      this.body.add(mesh);
      return mesh;
    };
    add(BODY, this.paint, 0, 0.5);
    add(NOSE, this.paint, 1.25, 0.44).rotation.z = -0.12;
    add(SEAT, DARK, -0.35, 0.86);
    add(WING, this.paint, -1.15, 1.18);
    add(STRUT, DARK, -1.15, 0.93, 0.5);
    add(STRUT, DARK, -1.15, 0.93, -0.5);
    add(HELMET, this.paint, -0.2, 1.34);
    add(VISOR, VISOR_MAT, 0.06, 1.36);
    add(GLOW, this.glow, 0, 0.2);
    add(LAMP, this.glow, 1.72, 0.48, 0.28);
    add(LAMP, this.glow, 1.72, 0.48, -0.28);
    for (const [x, z, steers] of WHEEL_AT) {
      const pivot = new THREE.Group();
      pivot.position.set(x, 0.4, z);
      const wheel = new THREE.Mesh(WHEEL, TYRE);
      pivot.add(wheel);
      this.body.add(pivot);
      this.wheels.push(wheel);
      if (steers) {
        this.steerable.push(pivot);
      }
    }
    this.group.add(this.body);
  }

  setColor(color: THREE.Color): void {
    this.paint.color.copy(color);
    this.paint.emissive.copy(color);
    this.glow.color.copy(color);
  }

  /** A little jump: the start of a drift. */
  kick(): void {
    this.hop = 1;
  }

  /**
   * Place the kart. `pitch` is the road's slope under it; `steer` and `drift`
   * drive the wheels and the body lean.
   */
  update(
    x: number,
    y: number,
    z: number,
    heading: number,
    pitch: number,
    steer: number,
    drift: number,
    speed: number,
    boosting: boolean,
    dt: number,
  ): void {
    this.group.position.set(x, y, z);
    // The model faces +x; heading turns +x towards +z, which is -Y rotation.
    this.group.rotation.set(0, -heading - drift * 0.38, 0);
    const lean = drift === 0 ? steer * 0.08 : drift * 0.2;
    this.lean += (lean - this.lean) * Math.min(1, dt * 10);
    this.hop = Math.max(0, this.hop - dt * 4.5);
    this.body.rotation.set(this.lean, 0, pitch);
    this.body.position.y = Math.sin(this.hop * Math.PI) * 0.45;
    for (const pivot of this.steerable) {
      pivot.rotation.y = -steer * 0.45;
    }
    for (const wheel of this.wheels) {
      wheel.rotation.z -= speed * dt * 2.4;
    }
    this.glow.color.copy(this.paint.color).multiplyScalar(boosting ? 2 : 0.8);
  }

  dispose(): void {
    this.paint.dispose();
    this.glow.dispose();
  }
}
