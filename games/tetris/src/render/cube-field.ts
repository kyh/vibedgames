// Turns the logical board into meshes. Three layers:
//  - locked cubes: one mesh per board id (Map), so a cube keeps its mesh and
//    lerps down when a clear shifts it; new cubes pop in, cleared cubes pop out.
//  - active slab: a fixed pool of 4 meshes (every tetromino is 4 cells),
//    snapped on spawn, lerped on move.
//  - ghost: 4 wireframe boxes at the landing footprint.
// During the game-over collapse the locked layer is `frozen` so the physics
// module can drive those meshes directly.

import {
  BoxGeometry,
  EdgesGeometry,
  Group,
  LineBasicMaterial,
  LineSegments,
  Mesh,
  type Scene,
  type ShaderMaterial,
  Vector3,
} from "three";

import type { Board } from "../game/board";
import type { Cell } from "../game/board";
import { GHOST_COLOR, PIECES } from "../shared/constants";
import { frameLerp } from "../shared/math";
import { makeActiveMaterial, makeCubeMaterial } from "./cube-material";

type LockedCube = {
  mesh: Mesh;
  material: ShaderMaterial;
  target: Vector3;
  scale: number;
  scaleTarget: number;
};

const CUBE = 0.92;
const POS_LERP = 0.32; // per-60fps-frame
const SCALE_LERP = 0.2;

export class CubeField {
  private readonly group = new Group();
  private readonly boxGeo = new BoxGeometry(CUBE, CUBE, CUBE);
  private readonly locked = new Map<number, LockedCube>();
  private readonly activeMeshes: Mesh[] = [];
  private readonly activeMaterials: ShaderMaterial[] = [];
  private readonly activeTargets: Vector3[] = [];
  private activePieceIndex = -1;
  private readonly ghostBoxes: LineSegments[] = [];
  /** When true, the locked layer isn't touched (physics owns the meshes). */
  frozen = false;

  constructor(scene: Scene) {
    scene.add(this.group);

    for (let i = 0; i < 4; i++) {
      const material = makeActiveMaterial(0xffffff);
      const mesh = new Mesh(this.boxGeo, material);
      mesh.visible = false;
      this.group.add(mesh);
      this.activeMeshes.push(mesh);
      this.activeMaterials.push(material);
      this.activeTargets.push(new Vector3());
    }

    const ghostGeo = new EdgesGeometry(new BoxGeometry(0.98, 0.98, 0.98));
    for (let i = 0; i < 4; i++) {
      const line = new LineSegments(
        ghostGeo,
        new LineBasicMaterial({ color: GHOST_COLOR, transparent: true, opacity: 0.5 }),
      );
      line.visible = false;
      this.group.add(line);
      this.ghostBoxes.push(line);
    }
  }

  /** Diff the board's locked cubes against the mesh map. */
  syncLocked(board: Board): void {
    if (this.frozen) return;
    const seen = new Set<number>();
    board.forEachCube((x, y, z, colorIndex, id) => {
      seen.add(id);
      const existing = this.locked.get(id);
      if (existing) {
        existing.target.set(x, y, z);
        existing.scaleTarget = 1;
        return;
      }
      const colorHex = PIECES[colorIndex - 1]?.color ?? 0xffffff;
      const material = makeCubeMaterial(colorHex);
      const mesh = new Mesh(this.boxGeo, material);
      mesh.position.set(x, y, z);
      mesh.scale.setScalar(0.01); // pop in
      this.group.add(mesh);
      this.locked.set(id, {
        mesh,
        material,
        target: new Vector3(x, y, z),
        scale: 0.01,
        scaleTarget: 1,
      });
    });
    // Cubes no longer present begin shrinking out.
    for (const [id, cube] of this.locked) {
      if (!seen.has(id)) cube.scaleTarget = 0;
    }
  }

  /** Position the active slab. `snap` (on spawn) sets positions immediately. */
  setActive(cells: Cell[], pieceIndex: number, snap: boolean): void {
    if (cells.length === 0 || pieceIndex < 0) {
      for (const m of this.activeMeshes) m.visible = false;
      this.activePieceIndex = -1;
      return;
    }
    if (pieceIndex !== this.activePieceIndex) {
      const colorHex = PIECES[pieceIndex]?.color ?? 0xffffff;
      for (const mat of this.activeMaterials) {
        const u = mat.uniforms.uColor;
        if (u) u.value.set(colorHex);
      }
      this.activePieceIndex = pieceIndex;
    }
    for (let i = 0; i < this.activeMeshes.length; i++) {
      const mesh = this.activeMeshes[i];
      const target = this.activeTargets[i];
      const cell = cells[i];
      if (!mesh || !target) continue;
      if (!cell) {
        mesh.visible = false;
        continue;
      }
      mesh.visible = true;
      target.set(cell.x, cell.y, cell.z);
      if (snap) mesh.position.copy(target);
    }
  }

  /** Position the landing-ghost wireframe boxes (snapped). */
  setGhost(cells: Cell[]): void {
    for (let i = 0; i < this.ghostBoxes.length; i++) {
      const line = this.ghostBoxes[i];
      const cell = cells[i];
      if (!line) continue;
      if (!cell) {
        line.visible = false;
        continue;
      }
      line.visible = true;
      line.position.set(cell.x, cell.y, cell.z);
    }
  }

  update(dt: number): void {
    const posK = frameLerp(POS_LERP, dt);
    const scaleK = frameLerp(SCALE_LERP, dt);

    // Active slab slides toward its target.
    for (let i = 0; i < this.activeMeshes.length; i++) {
      const mesh = this.activeMeshes[i];
      const target = this.activeTargets[i];
      if (mesh?.visible && target) mesh.position.lerp(target, posK);
    }

    if (this.frozen) return;
    for (const [id, cube] of this.locked) {
      cube.mesh.position.lerp(cube.target, posK);
      cube.scale += (cube.scaleTarget - cube.scale) * scaleK;
      cube.mesh.scale.setScalar(cube.scale);
      if (cube.scaleTarget === 0 && cube.scale < 0.03) {
        this.group.remove(cube.mesh);
        cube.material.dispose();
        this.locked.delete(id);
      }
    }
  }

  /** Live locked-cube meshes (for the physics collapse handoff). */
  lockedMeshes(): Mesh[] {
    return [...this.locked.values()].map((c) => c.mesh);
  }

  /** Remove every locked cube immediately (reset / after collapse). */
  clearLocked(): void {
    for (const cube of this.locked.values()) {
      this.group.remove(cube.mesh);
      cube.material.dispose();
    }
    this.locked.clear();
  }
}
