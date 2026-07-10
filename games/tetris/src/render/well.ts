// The enclosure you look into: a solid floor + a faint cell-grid on the floor
// and four wall grids. The two walls nearest the active camera corner hide so
// the stack is always readable (the reference's floor.ts trick). Built from
// line segments (you see through the cage) over a dark floor plane.

import {
  BufferAttribute,
  BufferGeometry,
  Group,
  LineBasicMaterial,
  LineSegments,
  Mesh,
  MeshBasicMaterial,
  PlaneGeometry,
  type Scene,
} from "three";

import { ENCLOSURE, GRID_LINE, WELL_DEPTH, WELL_HEIGHT, WELL_WIDTH } from "../shared/constants";

// Cube at cell c is centred at world c, so the volume spans -0.5 .. n-0.5.
const LO = -0.5;
const X_HI = WELL_WIDTH - 0.5;
const Z_HI = WELL_DEPTH - 0.5;
const Y_HI = WELL_HEIGHT - 0.5;

function lineSegments(points: number[], color: number, opacity: number): LineSegments {
  const geo = new BufferGeometry();
  geo.setAttribute("position", new BufferAttribute(new Float32Array(points), 3));
  return new LineSegments(geo, new LineBasicMaterial({ color, transparent: true, opacity }));
}

/** Grid on the x=const plane (a left/right wall), lines across z and up y. */
function wallX(xPlane: number): LineSegments {
  const p: number[] = [];
  for (let z = -0.5; z <= Z_HI + 0.001; z += 1) p.push(xPlane, LO, z, xPlane, Y_HI, z);
  for (let y = -0.5; y <= Y_HI + 0.001; y += 1) p.push(xPlane, y, LO, xPlane, y, Z_HI);
  return lineSegments(p, GRID_LINE, 0.4);
}

/** Grid on the z=const plane (a front/back wall), lines across x and up y. */
function wallZ(zPlane: number): LineSegments {
  const p: number[] = [];
  for (let x = -0.5; x <= X_HI + 0.001; x += 1) p.push(x, LO, zPlane, x, Y_HI, zPlane);
  for (let y = -0.5; y <= Y_HI + 0.001; y += 1) p.push(LO, y, zPlane, X_HI, y, zPlane);
  return lineSegments(p, GRID_LINE, 0.4);
}

export class Well {
  private readonly group = new Group();
  private readonly xLo: LineSegments;
  private readonly xHi: LineSegments;
  private readonly zLo: LineSegments;
  private readonly zHi: LineSegments;

  constructor(scene: Scene) {
    // Solid floor. polygonOffset pushes its depth back a step so the grid
    // lines 0.001 above never z-fight it — the orbiting camera hits grazing
    // angles where a fixed world-space lift alone can dip under depth-buffer
    // precision (slope-scaled offset tracks the grazing angle; lines don't
    // polygon-offset, so the plane is the one that must yield).
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

    // Floor cell grid.
    const fp: number[] = [];
    for (let x = -0.5; x <= X_HI + 0.001; x += 1) fp.push(x, LO + 0.001, LO, x, LO + 0.001, Z_HI);
    for (let z = -0.5; z <= Z_HI + 0.001; z += 1) fp.push(LO, LO + 0.001, z, X_HI, LO + 0.001, z);
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
  setCorner(corner: number): void {
    const c = ((corner % 4) + 4) % 4;
    // Corner quadrants: 0:+x+z  1:-x+z  2:-x-z  3:+x-z (see camera-rig).
    this.xHi.visible = !(c === 0 || c === 3); // +x side
    this.zHi.visible = !(c === 0 || c === 1); // +z side
    this.xLo.visible = !(c === 1 || c === 2); // -x side
    this.zLo.visible = !(c === 2 || c === 3); // -z side
  }

  setAllWallsVisible(visible: boolean): void {
    this.xLo.visible = visible;
    this.xHi.visible = visible;
    this.zLo.visible = visible;
    this.zHi.visible = visible;
  }
}
