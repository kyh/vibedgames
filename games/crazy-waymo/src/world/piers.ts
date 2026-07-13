import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";

import { prismGeometry, prismSpec } from "./sf-prisms";
import { SF_DOCKS, SF_PIERS } from "./sf-piers";
import type { Terrain } from "./terrain";

// The waterfront: real Embarcadero/wharf pier decks + marina dock floats.
// Visual only (no solids — the water already ends the drivable world);
// built main-side like the landmarks and freeways.

const MAT_DECK = new THREE.MeshStandardMaterial({ color: 0xc0b49e, roughness: 1 });
const MAT_WOOD = new THREE.MeshStandardMaterial({
  color: 0xc2a578,
  roughness: 1,
  side: THREE.DoubleSide,
});
const MAT_SHED = new THREE.MeshStandardMaterial({ color: 0xe3dac8, roughness: 1 });
const MAT_ROOF = new THREE.MeshStandardMaterial({ color: 0x9a6a52, roughness: 1 });
const MAT_PILE = new THREE.MeshStandardMaterial({ color: 0x6f6152, roughness: 1 });

const PILE_GEO = new THREE.BoxGeometry(0.5, 1, 0.5);
const SHED_GEO = new THREE.BoxGeometry(1, 1, 1);

export function buildPiers(terrain: Terrain): THREE.Group {
  const group = new THREE.Group();
  // One merged mesh per material — a thousand individual pilings would be a
  // thousand draw calls on an unbatched main-side group.
  const pileGeos: THREE.BufferGeometry[] = [];

  for (const pier of SF_PIERS) {
    const spec = prismSpec([0.7, ...pier.p]);
    if (!spec) continue;
    const { cx, cz, rel } = spec;
    // Deck sits just above the water, meeting the seawall height shoreside.
    let hi = -Infinity;
    for (let i = 0; i < rel.length; i += 2) {
      hi = Math.max(hi, terrain.heightAt(cx + (rel[i] ?? 0), cz + (rel[i + 1] ?? 0)));
    }
    const deckY = Math.min(Math.max(hi + 0.35, 1.2), 4.2);
    const deck = new THREE.Mesh(prismGeometry(spec), MAT_DECK);
    deck.position.set(cx, deckY - 0.7, cz);
    deck.receiveShadow = true;
    group.add(deck);

    // Pilings along the outline down into the bay.
    const n = rel.length / 2;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const ax = cx + (rel[i * 2] ?? 0);
      const az = cz + (rel[i * 2 + 1] ?? 0);
      const bx = cx + (rel[j * 2] ?? 0);
      const bz = cz + (rel[j * 2 + 1] ?? 0);
      const len = Math.hypot(bx - ax, bz - az);
      const steps = Math.max(1, Math.floor(len / 9));
      for (let k = 0; k <= steps; k++) {
        const t = k / steps;
        const px = ax + (bx - ax) * t;
        const pz = az + (bz - az) * t;
        const top = deckY - 0.55;
        const bot = -1.3;
        const g = PILE_GEO.clone();
        g.scale(1, top - bot, 1);
        g.translate(px, (top + bot) / 2, pz);
        pileGeos.push(g);
      }
    }

    // Bulkhead shed on the big finger piers: an OBB fitted to the longest
    // edge, inset from the deck rim — the classic Embarcadero warehouse mass.
    if (pier.area >= 450) {
      let bestLen = 0;
      let ex = 1;
      let ez = 0;
      for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        const dx = (rel[j * 2] ?? 0) - (rel[i * 2] ?? 0);
        const dz = (rel[j * 2 + 1] ?? 0) - (rel[i * 2 + 1] ?? 0);
        const len = Math.hypot(dx, dz);
        if (len > bestLen) {
          bestLen = len;
          ex = dx / len;
          ez = dz / len;
        }
      }
      // Ring extents in the edge-aligned frame.
      let minA = Infinity;
      let maxA = -Infinity;
      let minB = Infinity;
      let maxB = -Infinity;
      for (let i = 0; i < n; i++) {
        const dx = rel[i * 2] ?? 0;
        const dz = rel[i * 2 + 1] ?? 0;
        const a = dx * ex + dz * ez;
        const b = -dx * ez + dz * ex;
        minA = Math.min(minA, a);
        maxA = Math.max(maxA, a);
        minB = Math.min(minB, b);
        maxB = Math.max(maxB, b);
      }
      // Cap the shed: mega-decks (Piers 30-32 is ~2600u²) otherwise grow a
      // roof plane that swallows the whole deck — a warehouse ON a deck is
      // the look, not a deck-sized roof.
      const lenA = Math.min((maxA - minA) * 0.78, 44);
      const lenB = Math.min((maxB - minB) * 0.62, 20);
      if (lenA > 8 && lenB > 4) {
        const wallH = 3.4;
        const yaw = Math.atan2(-ez, ex);
        const shed = new THREE.Mesh(SHED_GEO, MAT_SHED);
        shed.scale.set(lenA, wallH, lenB);
        shed.position.set(cx, deckY + wallH / 2, cz);
        shed.rotation.y = yaw;
        shed.castShadow = true;
        group.add(shed);
        const roof = new THREE.Mesh(SHED_GEO, MAT_ROOF);
        roof.scale.set(lenA + 0.8, 0.5, lenB + 0.8);
        roof.position.set(cx, deckY + wallH + 0.25, cz);
        roof.rotation.y = yaw;
        group.add(roof);
      }
    }
  }

  // Marina dock floats: shallow BOXES riding the water — the old flat
  // single-plane planks had no lit sides and read as black combs against
  // the bright bay from any distance.
  const pos: number[] = [];
  const nor: number[] = [];
  const quad = (
    a: readonly [number, number, number],
    b: readonly [number, number, number],
    c: readonly [number, number, number],
    d: readonly [number, number, number],
    n: readonly [number, number, number],
  ): void => {
    pos.push(...a, ...b, ...c, ...a, ...c, ...d);
    for (let k = 0; k < 6; k++) nor.push(...n);
  };
  const TOP = 0.72;
  const BOT = 0.3;
  for (const dock of SF_DOCKS) {
    for (let i = 0; i + 3 < dock.length; i += 2) {
      const ax = dock[i] ?? 0;
      const az = dock[i + 1] ?? 0;
      const bx = dock[i + 2] ?? 0;
      const bz = dock[i + 3] ?? 0;
      const len = Math.hypot(bx - ax, bz - az) || 1;
      const nx = (-(bz - az) / len) * 0.8;
      const nz = ((bx - ax) / len) * 0.8;
      const sn: [number, number, number] = [nx / 0.8, 0, nz / 0.8];
      quad(
        [ax - nx, TOP, az - nz],
        [bx - nx, TOP, bz - nz],
        [bx + nx, TOP, bz + nz],
        [ax + nx, TOP, az + nz],
        [0, 1, 0],
      );
      quad(
        [ax + nx, TOP, az + nz],
        [bx + nx, TOP, bz + nz],
        [bx + nx, BOT, bz + nz],
        [ax + nx, BOT, az + nz],
        sn,
      );
      quad(
        [ax - nx, BOT, az - nz],
        [bx - nx, BOT, bz - nz],
        [bx - nx, TOP, bz - nz],
        [ax - nx, TOP, az - nz],
        [-sn[0], 0, -sn[2]],
      );
    }
  }
  if (pos.length > 0) {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(pos), 3));
    geo.setAttribute("normal", new THREE.BufferAttribute(new Float32Array(nor), 3));
    geo.setAttribute("uv", new THREE.BufferAttribute(new Float32Array((pos.length / 3) * 2), 2));
    group.add(new THREE.Mesh(geo, MAT_WOOD));
  }
  if (pileGeos.length > 0) {
    const merged = mergeGeometries(pileGeos);
    if (merged) group.add(new THREE.Mesh(merged, MAT_PILE));
  }

  return group;
}
