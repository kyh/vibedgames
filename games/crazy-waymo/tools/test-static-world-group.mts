import * as THREE from "three";
import { StaticWorldGroup } from "../src/render/static-world-group";

type Check = (name: string, condition: boolean, detail?: string) => void;

class CountedGroup extends THREE.Group {
  visits = 0;

  override updateMatrixWorld(force?: boolean): void {
    this.visits++;
    super.updateMatrixWorld(force);
  }
}

export function checkStaticWorldGroup(check: Check): void {
  const scene = new THREE.Scene();
  scene.position.x = 3;
  const root = new StaticWorldGroup();
  root.position.x = 7;
  const child = new CountedGroup();
  child.position.z = 11;
  root.add(child);
  scene.add(root);
  scene.updateMatrixWorld(true);
  root.seal();
  const world = child.matrixWorld.clone();
  child.visits = 0;
  // Renderer updates the live scene, whose local compose forces descendants.
  for (let i = 0; i < 120; i++) scene.updateMatrixWorld();
  check("sealed city skips every redundant descendant matrix visit", child.visits === 0);
  check(
    "sealed city preserves composed parent and child transforms",
    child.matrixWorld.equals(world) && world.elements[12] === 10 && world.elements[14] === 11,
  );

  // Matches ParcelStreamer.install: attach, compose, then freeze the new cell.
  const cell = new THREE.Group();
  const facade = new CountedGroup();
  facade.position.set(2, 4, 6);
  cell.add(facade);
  root.add(cell);
  cell.updateMatrixWorld(true);
  cell.traverse((object) => {
    object.matrixAutoUpdate = false;
    object.matrixWorldAutoUpdate = root.matrixWorldAutoUpdate;
  });
  const installed = facade.matrixWorld.clone();
  facade.visits = 0;
  scene.updateMatrixWorld();
  check(
    "late streamed cells inherit the frozen city transform without per-frame visits",
    facade.visits === 0 &&
      facade.matrixWorld.equals(installed) &&
      installed.elements[12] === 12 &&
      installed.elements[13] === 4 &&
      installed.elements[14] === 6,
  );

  const editor = new StaticWorldGroup();
  const movable = new CountedGroup();
  editor.add(movable);
  editor.position.x = 1;
  editor.updateMatrixWorld();
  editor.position.x = 8;
  movable.position.z = 9;
  editor.updateMatrixWorld();
  check(
    "unsealed editor city still propagates parent and child edits",
    movable.matrixWorld.elements[12] === 8 && movable.matrixWorld.elements[14] === 9,
  );
  const clone = root.clone(false);
  const clonedChild = new CountedGroup();
  clone.add(clonedChild);
  clone.updateMatrixWorld(true);
  check("cloned city roots start unsealed", clonedChild.visits === 1);
}
