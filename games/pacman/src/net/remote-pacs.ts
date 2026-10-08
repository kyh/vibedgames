// Renders the other players' pac-blobs in the shared maze. They're simple
// colored plush spheres (not the full mouth-animated hero rig) — enough to see
// rivals racing for pellets. Each one plays back its sender's 20 Hz reports
// through its own PacTrack (./pac-track), whose clock learns that rival's route.

import * as THREE from "three";

import type { PlayerMap } from "@vibedgames/multiplayer";

import { PacTrack, readPacSample } from "./pac-track";

interface RemotePac {
  group: THREE.Group;
  mat: THREE.MeshStandardMaterial;
  track: PacTrack;
  /** The update() pass that last listed it as a rival; an older one has left the round. */
  seen: number;
}

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
  private pass = 0;

  constructor(scene: THREE.Scene) {
    scene.add(this.group);
  }

  /**
   * Every frame: feed each rival's latest report (a repeat costs nothing) and
   * draw it where its track says. The scene decides who counts as a rival.
   */
  update(players: PlayerMap, rivalIds: readonly string[], t: number): void {
    this.pass += 1;
    for (const id of rivalIds) {
      const sample = readPacSample(players[id]?.state);
      if (!sample) {
        continue;
      }
      const pac = this.pacs.get(id) ?? this.spawn(id);
      pac.seen = this.pass;
      pac.track.push(sample);
      const pose = pac.track.sample();
      if (pose) {
        pac.group.position.set(pose.x, BODY_Y + Math.sin(t * 3 + pose.x) * 0.03, pose.z);
      }
    }
    for (const [id, pac] of this.pacs) {
      if (pac.seen !== this.pass) {
        this.group.remove(pac.group);
        pac.mat.dispose();
        this.pacs.delete(id);
      }
    }
  }

  private spawn(id: string): RemotePac {
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
    const pac: RemotePac = { group, mat, seen: this.pass, track: new PacTrack() };
    this.pacs.set(id, pac);
    return pac;
  }
}
