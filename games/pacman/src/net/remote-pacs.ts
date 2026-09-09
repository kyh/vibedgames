// Renders the other players' pac-blobs in the shared maze. They're simple
// colored plush spheres (not the full mouth-animated hero rig) — enough to see
// rivals racing for pellets. Positions are smoothed toward the ~15 Hz updates.

import * as THREE from "three";

import type { Player, PlayerMap } from "@vibedgames/multiplayer";

export interface RemotePacState {
  x: number;
  z: number;
}

/** One field of the wire player-state dictionary (parsed JSON). */
type PlayerStateField = NonNullable<Player["state"]>[string] | undefined;

// JSON numbers are always finite, so Number.isFinite is the exact check.
const isFiniteNumber = (v: PlayerStateField): v is number => Number.isFinite(v);

const readPacState = (state: Player["state"]): RemotePacState | null => {
  if (!state) {
    return null;
  }
  const { x } = state;
  const { z } = state;
  if (!isFiniteNumber(x) || !isFiniteNumber(z)) {
    return null;
  }
  return { x, z };
};

interface RemotePac {
  group: THREE.Group;
  mat: THREE.MeshStandardMaterial;
  cur: THREE.Vector3;
  target: THREE.Vector3;
  seeded: boolean;
}

const LERP_RATE = 12;
const BODY_Y = 0.4;

/* oxlint-disable no-bitwise, unicorn/prefer-code-point -- FNV-1a is defined over
   UTF-16 code units and 32-bit wraparound; codePointAt or Math.trunc would change
   the hash, and every peer has to derive the same color from an id. */
const colorForId = (id: string): THREE.Color => {
  let h = 2_166_136_261;
  for (let i = 0; i < id.length; i += 1) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 16_777_619);
  }
  return new THREE.Color().setHSL(((h >>> 0) % 360) / 360, 0.65, 0.6);
};
/* oxlint-enable no-bitwise, unicorn/prefer-code-point */
export class RemotePacs {
  readonly group = new THREE.Group();
  private pacs = new Map<string, RemotePac>();
  private geo = new THREE.SphereGeometry(0.42, 20, 16);

  constructor(scene: THREE.Scene) {
    scene.add(this.group);
  }

  /** Adopt the latest player snapshot (excluding me). */
  sync(players: PlayerMap, myId: string | null): void {
    const seen = new Set<string>();
    for (const [id, player] of Object.entries(players)) {
      if (id === myId) {
        continue;
      }
      const st = readPacState(player.state);
      if (!st) {
        continue;
      }
      seen.add(id);
      let pac = this.pacs.get(id);
      if (!pac) {
        pac = this.spawn(id, st);
      }
      pac.target.set(st.x, BODY_Y, st.z);
    }
    for (const [id, pac] of this.pacs) {
      if (!seen.has(id)) {
        this.group.remove(pac.group);
        pac.mat.dispose();
        this.pacs.delete(id);
      }
    }
  }

  update(dt: number, t: number): void {
    const k = 1 - Math.exp(-LERP_RATE * dt);
    for (const pac of this.pacs.values()) {
      if (pac.seeded) {
        pac.cur.copy(pac.target);
        pac.seeded = false;
      } else {
        pac.cur.lerp(pac.target, k);
      }
      pac.group.position.set(pac.cur.x, pac.cur.y + Math.sin(t * 3 + pac.cur.x) * 0.03, pac.cur.z);
    }
  }

  private spawn(id: string, st: RemotePacState): RemotePac {
    const mat = new THREE.MeshStandardMaterial({
      color: colorForId(id),
      emissive: colorForId(id),
      emissiveIntensity: 0.12,
      roughness: 0.5,
    });
    const body = new THREE.Mesh(this.geo, mat);
    body.castShadow = true;
    const group = new THREE.Group();
    group.add(body);
    this.group.add(group);
    const cur = new THREE.Vector3(st.x, BODY_Y, st.z);
    const pac: RemotePac = { cur, group, mat, seeded: true, target: cur.clone() };
    this.pacs.set(id, pac);
    return pac;
  }
}
