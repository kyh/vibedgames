import {
  BufferAttribute,
  BufferGeometry,
  Group,
  LineBasicMaterial,
  LineSegments,
  Mesh,
  MeshBasicMaterial,
  PlaneGeometry,
} from "three";
import type { Scene } from "three";

import { ENCLOSURE, GRID_LINE, WELL_DEPTH, WELL_HEIGHT, WELL_WIDTH } from "../shared/constants";

const LO = -0.5;
const X_HI = WELL_WIDTH - 0.5;
const Z_HI = WELL_DEPTH - 0.5;
const Y_HI = WELL_HEIGHT - 0.5;

const lineSegments = (points: number[], color: number, opacity: number) => {
  const geo = new BufferGeometry();
  geo.setAttribute("position", new BufferAttribute(new Float32Array(points), 3));

  return new LineSegments(geo, new LineBasicMaterial({ color, opacity, transparent: true }));
};

const wallX = (xPlane: number) => {
  const p: number[] = [];

  for (let z = -0.5; z <= Z_HI + 0.001; z += 1) {
    p.push(xPlane, LO, z, xPlane, Y_HI, z);
  }

  for (let y = -0.5; y <= Y_HI + 0.001; y += 1) {
    p.push(xPlane, y, LO, xPlane, y, Z_HI);
  }

  return lineSegments(p, GRID_LINE, 0.4);
};

const wallZ = (zPlane: number) => {
  const p: number[] = [];

  for (let x = -0.5; x <= X_HI + 0.001; x += 1) {
    p.push(x, LO, zPlane, x, Y_HI, zPlane);
  }

  for (let y = -0.5; y <= Y_HI + 0.001; y += 1) {
    p.push(LO, y, zPlane, X_HI, y, zPlane);
  }

  return lineSegments(p, GRID_LINE, 0.4);
};

export class Well {
  private readonly group = new Group();
  private readonly xLo: LineSegments;
  private readonly xHi: LineSegments;
  private readonly zLo: LineSegments;
  private readonly zHi: LineSegments;

  constructor(scene: Scene) {
    const floor = new Mesh(
      new PlaneGeometry(WELL_WIDTH, WELL_DEPTH),
      new MeshBasicMaterial({
        color: ENCLOSURE,
        polygonOffset: true,
        polygonOffsetFactor: 1,
        polygonOffsetUnits: 1,
      }),
    );

    floor.rotation.x = -Math.PI / 2;
    floor.position.set(WELL_WIDTH / 2 - 0.5, LO, WELL_DEPTH / 2 - 0.5);
    this.group.add(floor);

    const fp: number[] = [];

    for (let x = -0.5; x <= X_HI + 0.001; x += 1) {
      fp.push(x, LO + 0.001, LO, x, LO + 0.001, Z_HI);
    }

    for (let z = -0.5; z <= Z_HI + 0.001; z += 1) {
      fp.push(LO, LO + 0.001, z, X_HI, LO + 0.001, z);
    }

    this.group.add(lineSegments(fp, GRID_LINE, 0.55));

    this.xLo = wallX(LO);
    this.xHi = wallX(X_HI);
    this.zLo = wallZ(LO);
    this.zHi = wallZ(Z_HI);
    this.group.add(this.xLo, this.xHi, this.zLo, this.zHi);

    scene.add(this.group);
    this.setCorner(0);
  }

  /** Hide the two walls nearest the camera corner so nothing occludes. */
  setCorner(corner: number) {
    const c = ((corner % 4) + 4) % 4;
    this.xHi.visible = !(c === 0 || c === 3);
    this.zHi.visible = !(c === 0 || c === 1);
    this.xLo.visible = !(c === 1 || c === 2);
    this.zLo.visible = !(c === 2 || c === 3);
  }

  setAllWallsVisible(visible: boolean) {
    this.xLo.visible = visible;
    this.xHi.visible = visible;
    this.zLo.visible = visible;
    this.zHi.visible = visible;
  }
}
