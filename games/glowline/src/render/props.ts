// The mid-ground: everything between the barriers and the skyline that makes
// the verge a place rather than a lawn. Benches, corner boards, flag lines,
// cones, marshal huts, fence runs with banners, tents, service vans, bins, a
// big screen and a pond in the infield, gravel traps on the outside of the
// bends. Plus the contact shading that sits every object on the ground.

import * as THREE from "three";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";

import { curvatureAt, pointAt } from "../sim/track";
import type { Track } from "../sim/track";
import { ribbon } from "./road";
import { at } from "./scenery";
import type { Kit, Placement } from "./scenery";
import type { Site } from "./site";
import { signTexture, softDisc } from "./textures";

const tinted = (placement: Placement, color: THREE.Color): Placement => {
  placement.color = color;
  return placement;
};

/** A dark soft-edged strip under each run of barriers, and one under the kerbs. */
export const addContactStrips = (kit: Kit, track: Track): void => {
  const soft = kit.own(
    new THREE.MeshBasicMaterial({
      color: "#000000",
      depthWrite: false,
      opacity: 0.2,
      transparent: true,
    }),
  );
  for (const side of [-1, 1]) {
    // Three nested strips of rising width read as one soft falloff.
    for (const [i, half] of [0.75, 1.3, 2.1].entries()) {
      const centre = side * (track.rail + 0.55);
      const strip = kit.mesh(ribbon(track, centre - half, centre + half, 0.012 + i * 0.004), soft);
      strip.castShadow = false;
      strip.receiveShadow = false;
      strip.renderOrder = 1;
    }
  }
};

/** Soft dark discs: the shade pooled under trees, huts, vans and tents. */
export const addShade = (kit: Kit, spots: readonly Placement[]): void => {
  const disc = kit.own(softDisc());
  const material = kit.own(
    new THREE.MeshBasicMaterial({
      color: "#000000",
      depthWrite: false,
      map: disc,
      opacity: 0.6,
      transparent: true,
    }),
  );
  const mesh = kit.instances(
    new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2),
    material,
    spots,
    false,
  );
  mesh.renderOrder = 1;
};

interface Verge {
  benches: Placement[];
  cones: Placement[];
  bins: Placement[];
  huts: Placement[];
  hutRoofs: Placement[];
  poles: Placement[];
  flags: Placement[];
  fences: Placement[];
  banners: Placement[];
  vans: Placement[];
  cabs: Placement[];
  tents: Placement[];
  shade: Placement[];
}

/** What stands at one station along the verge, cycling through the kit. */
const dressStation = (
  verge: Verge,
  track: Track,
  station: number,
  i: number,
  side: number,
  colors: readonly THREE.Color[],
): void => {
  const pick = (n: number): THREE.Color => colors[n % colors.length] ?? new THREE.Color("#ffffff");
  const near = pointAt(track, i, side * (track.rail + 3));
  const mid = pointAt(track, i, side * (track.rail + 6.5));
  const far = pointAt(track, i, side * (track.rail + 11));
  const turn = -near.a;
  switch (station % 7) {
    case 0: {
      verge.benches.push(tinted(at(near.x, 0.42, near.z, turn), pick(station)));
      verge.bins.push(
        at(
          pointAt(track, i + 2.4, side * (track.rail + 3)).x,
          0.5,
          pointAt(track, i + 2.4, side * (track.rail + 3)).z,
        ),
      );
      break;
    }
    case 1: {
      // A line of flags on poles.
      for (let k = 0; k < 4; k += 1) {
        const p = pointAt(track, i + k * 2.2, side * (track.rail + 2.6));
        verge.poles.push(at(p.x, 0, p.z));
        verge.flags.push(tinted(at(p.x, 4.9, p.z, turn), pick(station + k)));
      }
      break;
    }
    case 2: {
      verge.huts.push(tinted(at(mid.x, 0, mid.z, turn), pick(station)));
      verge.hutRoofs.push(at(mid.x, 2.5, mid.z, turn));
      verge.shade.push(at(mid.x, 0.02, mid.z, 0, 6.5, 1, 6.5));
      break;
    }
    case 3: {
      // A fence run with a sponsor banner hung on it.
      for (let k = 0; k < 4; k += 1) {
        const p = pointAt(track, i + k * 2.5, side * (track.rail + 2.2));
        verge.fences.push(at(p.x, 0.75, p.z, -p.a));
        if (k % 2 === 0) {
          verge.banners.push(tinted(at(p.x, 0.8, p.z, -p.a), pick(station + k)));
        }
      }
      break;
    }
    case 4: {
      verge.vans.push(tinted(at(far.x, 0.95, far.z, turn), pick(station)));
      verge.cabs.push(
        at(
          pointAt(track, i + 1.9, side * (track.rail + 11)).x,
          0.75,
          pointAt(track, i + 1.9, side * (track.rail + 11)).z,
          turn,
        ),
      );
      verge.shade.push(at(far.x, 0.02, far.z, 0, 8, 1, 8));
      break;
    }
    case 5: {
      verge.tents.push(tinted(at(mid.x, 0, mid.z, turn + 0.4), pick(station)));
      verge.shade.push(at(mid.x, 0.02, mid.z, 0, 8, 1, 8));
      break;
    }
    default: {
      for (let k = 0; k < 5; k += 1) {
        const p = pointAt(track, i + k * 1.6, side * (track.rail + 2.4));
        verge.cones.push(at(p.x, 0, p.z));
      }
    }
  }
};

/** Dress both verges, a station every dozen metres, alternating sides. */
export const addVerge = (kit: Kit, track: Track): void => {
  const { palette } = track.def;
  const colors = [palette.accent, palette.accent2, "#f4f1ea", "#ffd23f", "#3d6bff", "#e8503a"].map(
    (style) => new THREE.Color(style),
  );
  const verge: Verge = {
    banners: [],
    benches: [],
    bins: [],
    cabs: [],
    cones: [],
    fences: [],
    flags: [],
    hutRoofs: [],
    huts: [],
    poles: [],
    shade: [],
    tents: [],
    vans: [],
  };
  let station = 0;
  for (let i = 40; i < track.n - 20; i += 11) {
    // The start straight has its stand and pits; leave it to them.
    if (i > 52 || i < 8) {
      for (const side of [-1, 1]) {
        dressStation(verge, track, station, i + (side > 0 ? 5 : 0), side, colors);
        station += 1;
      }
    }
  }
  const wood = kit.own(new THREE.MeshStandardMaterial({ roughness: 0.8 }));
  const steel = kit.own(new THREE.MeshStandardMaterial({ color: "#3b3d4a", roughness: 0.5 }));
  const white = kit.own(new THREE.MeshStandardMaterial({ color: "#f1eee6", roughness: 0.7 }));
  const cloth = kit.own(new THREE.MeshStandardMaterial({ roughness: 0.9, side: THREE.DoubleSide }));
  const orange = kit.own(new THREE.MeshStandardMaterial({ color: "#ff6a1f", roughness: 0.6 }));
  kit.instances(new RoundedBoxGeometry(2.4, 0.5, 0.7, 2, 0.08), wood, verge.benches);
  kit.instances(new THREE.CylinderGeometry(0.34, 0.28, 1, 10), steel, verge.bins);
  kit.instances(
    new THREE.CylinderGeometry(0.05, 0.07, 5.6, 6).translate(0, 2.8, 0),
    steel,
    verge.poles,
  );
  kit.instances(new THREE.PlaneGeometry(1.5, 0.9).translate(0.8, 0, 0), cloth, verge.flags);
  kit.instances(new THREE.BoxGeometry(2.6, 2.4, 2.6).translate(0, 1.2, 0), wood, verge.huts);
  kit.instances(
    new THREE.ConeGeometry(2.4, 1.3, 4).rotateY(Math.PI / 4).translate(0, 0.65, 0),
    steel,
    verge.hutRoofs,
  );
  kit.instances(new THREE.BoxGeometry(2.4, 1.5, 0.08), steel, verge.fences);
  kit.instances(new THREE.PlaneGeometry(2.3, 1).translate(0, 0, 0.06), cloth, verge.banners, false);
  kit.instances(new RoundedBoxGeometry(4.2, 1.9, 1.9, 2, 0.15), white, verge.vans);
  kit.instances(new RoundedBoxGeometry(1.5, 1.5, 1.8, 2, 0.2), wood, verge.cabs);
  kit.instances(new THREE.ConeGeometry(3, 3.2, 6).translate(0, 1.6, 0), cloth, verge.tents);
  kit.instances(new THREE.ConeGeometry(0.28, 0.75, 10).translate(0, 0.375, 0), orange, verge.cones);
  addShade(kit, verge.shade);
};

/** Chevron boards on the outside of every real bend, pointing the way round. */
export const addCornerBoards = (kit: Kit, track: Track): void => {
  const { palette } = track.def;
  const boards: Placement[] = [];
  const legs: Placement[] = [];
  let last = -100;
  for (let i = 0; i < track.n; i += 3) {
    const bend = curvatureAt(track, i);
    if (Math.abs(bend) > 0.036 && i - last >= 6) {
      last = i;
      const p = pointAt(track, i, -Math.sign(bend) * (track.rail + 1.9));
      boards.push(at(p.x, 1.9, p.z, -p.a + (bend > 0 ? 0 : Math.PI)));
      legs.push(at(p.x, 0, p.z));
    }
  }
  const map = kit.own(signTexture(">>>", palette.accent2, "#ffffff"));
  const face = kit.own(
    new THREE.MeshStandardMaterial({ map, roughness: 0.6, side: THREE.DoubleSide }),
  );
  const steel = kit.own(new THREE.MeshStandardMaterial({ color: "#3b3d4a", roughness: 0.5 }));
  kit.instances(new THREE.PlaneGeometry(3.4, 1.06), face, boards);
  kit.instances(new THREE.BoxGeometry(0.14, 1.5, 0.14).translate(0, 0.75, 0), steel, legs);
};

/** The infield's landmarks: a pond, and a big screen facing the grandstand. */
export const addInfield = (kit: Kit, site: Site): void => {
  const { track } = site;
  const { palette } = track.def;
  // Walk outwards from the centroid of the loop until there is room for a pond.
  let cx = 0;
  let cz = 0;
  for (let i = 0; i < track.n; i += 1) {
    cx += (track.xs[i] ?? 0) / track.n;
    cz += (track.zs[i] ?? 0) / track.n;
  }
  let best = { gap: 0, x: cx, z: cz };
  for (let k = 0; k < 60; k += 1) {
    const x = cx + (kit.random() - 0.5) * 120;
    const z = cz + (kit.random() - 0.5) * 120;
    const gap = site.distance(x, z) - track.rail;
    if (site.inside(x, z) && gap > best.gap) {
      best = { gap, x, z };
    }
  }
  if (best.gap > 16) {
    const size = Math.min(22, best.gap - 6);
    const water = kit.mesh(
      new THREE.CircleGeometry(1, 28).rotateX(-Math.PI / 2),
      kit.own(
        new THREE.MeshStandardMaterial({ color: "#2f7fb8", metalness: 0.3, roughness: 0.06 }),
      ),
    );
    water.scale.set(size, 1, size * 0.7);
    water.position.set(best.x, 0.02, best.z);
    water.castShadow = false;
    const bank = kit.mesh(
      new THREE.RingGeometry(1, 1.12, 28).rotateX(-Math.PI / 2),
      kit.own(new THREE.MeshStandardMaterial({ color: "#d8c9a0", roughness: 1 })),
    );
    bank.scale.set(size, 1, size * 0.7);
    bank.position.set(best.x, 0.03, best.z);
    bank.castShadow = false;
  }

  // The big screen: on the infield side of the first bend after the line.
  const p = pointAt(track, 70, track.rail + 12);
  const screen = new THREE.Group();
  screen.position.set(p.x, 0, p.z);
  screen.rotation.y = -p.a + Math.PI;
  const steel = kit.own(new THREE.MeshStandardMaterial({ color: "#2f313c", roughness: 0.5 }));
  const frame = new THREE.Mesh(kit.own(new THREE.BoxGeometry(15, 8.6, 0.8)), steel);
  frame.position.y = 9;
  frame.castShadow = true;
  const picture = kit.own(signTexture("LAP 1 / 3", palette.accent, "#101018"));
  const face = new THREE.Mesh(
    kit.own(new THREE.PlaneGeometry(14, 7.6)),
    kit.own(new THREE.MeshBasicMaterial({ color: "#cfcfcf", map: picture, toneMapped: false })),
  );
  face.position.set(0, 9, 0.42);
  screen.add(frame, face);
  const leg = kit.own(new THREE.BoxGeometry(0.6, 5, 0.6));
  for (const x of [-5, 5]) {
    const post = new THREE.Mesh(leg, steel);
    post.position.set(x, 2.5, 0);
    post.castShadow = true;
    screen.add(post);
  }
  kit.group.add(screen);
};
