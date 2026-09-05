import * as THREE from "three";

import { Fx } from "../src/fx/particles.ts";
import { WaterFx, type WaterSprayKind } from "../src/fx/water-fx.ts";
import { DRY_WATER_CONTACT, type WaterContact } from "../src/vehicle/water-contact.ts";

type Check = (name: string, condition: boolean, detail?: string) => void;
const STILL: WaterContact = {
  kind: "floating",
  waterY: -0.5,
  immersion: 0.5,
  entrySpeed: 0,
  entryVerticalSpeed: 0,
};
const FAST: WaterContact = { ...STILL, entrySpeed: 20, entryVerticalSpeed: 6 };

function liveParticles(fx: Fx): number {
  const life = fx.smoke.points.geometry.getAttribute("aLife");
  let live = 0;
  for (let i = 0; i < life.count; i++) if (life.getX(i) > 0) live++;
  return live;
}

function dispose(water: WaterFx): void {
  water.mesh.geometry.dispose();
  water.mesh.material.dispose();
}

/** Exercise contact transitions and the actual bounded render buffers. */
export function checkWaterFx(check: Check): void {
  const sprays: { kind: WaterSprayKind; strength: number }[] = [];
  const water = new WaterFx((_x, _y, _z, strength, _vx, _vz, kind) => {
    sprays.push({ kind, strength });
  });
  for (let i = 0; i < 120; i++) {
    water.contact(1 / 60, DRY_WATER_CONTACT, 0, 0, 0, 20, 0);
    water.update(1 / 60);
  }
  check("dry car cannot create spray or a water draw", sprays.length === 0 && !water.mesh.visible);

  water.contact(1 / 60, STILL, 0, -0.7, 0, 0, 0);
  for (let i = 0; i < 120; i++) {
    water.contact(1 / 60, STILL, 0, -0.7, 0, 0, 0);
    water.update(1 / 60);
  }
  check(
    "stationary flotation splashes once, then keeps only gentle ripples",
    sprays.length === 2 && sprays.every((spray) => spray.kind === "entry") && water.mesh.visible,
  );
  const quietStrength = sprays[0]?.strength ?? 1;
  water.contact(1 / 60, DRY_WATER_CONTACT, 0, 0, 0, 0, 0);
  water.contact(1 / 60, DRY_WATER_CONTACT, 0, 0, 0, 0, 0);
  check(
    "exit droplets fire once per wet interval",
    sprays.filter((spray) => spray.kind === "exit").length === 2,
  );
  water.contact(1 / 60, FAST, 0, -0.7, 0, 20, 0);
  const fastStrength = sprays.at(-1)?.strength ?? 0;
  check(
    "faster or falling entries make a stronger bounded splash",
    fastStrength > quietStrength * 3 && fastStrength <= 1,
  );
  const beforeTeleport = sprays.length;
  water.contact(1 / 60, DRY_WATER_CONTACT, 500, 0, 0, 0, 0);
  check(
    "respawning on land cannot move exit droplets to the spawn",
    sprays.length === beforeTeleport,
  );
  water.update(2);
  check(
    "all residual water foam hides within two seconds",
    !water.mesh.visible && water.mesh.geometry.drawRange.count === 0,
  );
  dispose(water);

  const wakeCounts: number[] = [];
  for (const hz of [30, 60, 144]) {
    let wake = 0;
    const cadence = new WaterFx((_x, _y, _z, _strength, _vx, _vz, kind) => {
      if (kind === "wake") wake++;
    });
    for (let i = 0; i < hz * 10; i++) cadence.contact(1 / hz, FAST, 0, -0.7, (i / hz) * 20, 0, 20);
    wakeCounts.push(wake);
    const beforeHitch = wake;
    cadence.contact(10, FAST, 0, -0.7, 200, 0, 20);
    cadence.contact(0, FAST, 0, -0.7, 200, 0, 20);
    check(`water hitch at ${hz}Hz emits at most one paired wake`, wake - beforeHitch <= 2);
    dispose(cadence);
  }
  check(
    "wake rate stays stable across display refresh rates",
    Math.max(...wakeCounts) - Math.min(...wakeCounts) <= 2 && Math.max(...wakeCounts) <= 120,
  );

  for (const speed of [-20, 20]) {
    const direction = new WaterFx(() => {});
    direction.contact(0, STILL, 0, -0.7, 0, 0, 0);
    direction.update(1.4); // retire entry ripple; retain wet state
    direction.contact(0.1, FAST, 0, -0.7, 0, 0, speed);
    direction.contact(0.1, FAST, 0, -0.7, 0, 0, speed);
    direction.update(0.1);
    const positions = direction.mesh.geometry.getAttribute("position");
    const indices = direction.mesh.geometry.getIndex();
    let trailsBehind = direction.mesh.visible && indices !== null;
    if (indices) {
      for (let i = 0; i < direction.mesh.geometry.drawRange.count; i++) {
        const vertex = indices.getX(i);
        trailsBehind &&= positions.getZ(vertex) * speed < 0;
        trailsBehind &&= Math.abs(positions.getY(vertex) + 0.44) < 1e-6;
      }
    }
    check(
      `${speed < 0 ? "reverse" : "forward"} wake trails actual motion on the contact water plane`,
      trailsBehind,
    );
    dispose(direction);
  }

  const fx = new Fx();
  const scene = new THREE.Scene();
  fx.addTo(scene);
  const geometry = fx.water.mesh.geometry;
  const attributes = Object.values(geometry.attributes);
  const bytes =
    attributes.reduce((total, attribute) => total + attribute.array.byteLength, 0) +
    (geometry.getIndex()?.array.byteLength ?? 0);
  let peakParticles = 0;
  let peakTriangles = 0;
  for (let frame = 0; frame < 600; frame++) {
    fx.water.contact(1 / 60, FAST, 0, -0.7, frame / 3, 0, 20);
    fx.update(1 / 60);
    peakParticles = Math.max(peakParticles, liveParticles(fx));
    peakTriangles = Math.max(peakTriangles, geometry.drawRange.count / 3);
  }
  check(
    "ten-second float reuses existing particle pool and one small normal-blend foam draw",
    peakParticles <= 48 &&
      peakTriangles <= 1000 &&
      bytes <= 64 * 1024 &&
      scene.children.length === 5 &&
      fx.water.mesh.material.blending === THREE.NormalBlending &&
      fx.water.mesh.material.forceSinglePass &&
      !fx.water.mesh.material.depthWrite &&
      Object.values(geometry.attributes).every(
        (attribute, index) => attribute === attributes[index],
      ),
    `${peakParticles} particles; ${peakTriangles} triangles; ${bytes} fixed geometry bytes`,
  );
  fx.water.contact(0, DRY_WATER_CONTACT, 0, 0, 200, 0, 0);
  fx.update(2);
  check(
    "water spray and foam fully expire after leaving water",
    liveParticles(fx) === 0 && !fx.water.mesh.visible,
  );
  scene.traverse((object) => {
    if (object instanceof THREE.Mesh || object instanceof THREE.Points) {
      object.geometry.dispose();
      if (Array.isArray(object.material))
        for (const material of object.material) material.dispose();
      else object.material.dispose();
    }
  });
}
