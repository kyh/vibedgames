// 3D character-select stage for the lobby. Reuses the game's WebGLRenderer with
// its own scene + camera: the champion roster stands on a shallow arc (curving
// away at the edges so all ten fit the frustum), idle-animated, each turned
// slightly toward the camera. Click one to select it (highlight ring + glow +
// step forward). Raycasts pointer events against per-champion proxy boxes.
// Rig-aware: `rig: "large"` champs bind the "Large/" clip prefix and their
// ChampDef scale, so the Black Knight reads properly huge in select.
import * as THREE from "three";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import { CHAMPIONS } from "../data/champions";
import { AnimatedCharacter, ModelLibrary } from "./models";

const ARC_R = 15; // arc radius — edge champs curve gently back into the fog
const ARC_GAP = 2.35; // spacing along the arc between champions (6-champ row)
const CAM_Z = 11.5;

type Slot = {
  id: string;
  tint: number;
  char: AnimatedCharacter;
  group: THREE.Group;
  ring: THREE.Mesh;
  mats: THREE.MeshStandardMaterial[];
  baseYaw: number; // resting turn toward the camera (arc lineup look)
  baseZ: number; // resting depth on the arc (selected steps forward from here)
};

export class MenuStage {
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  private slots: Slot[] = [];
  private raycaster = new THREE.Raycaster();
  private picks: THREE.Object3D[] = [];
  private selectedId = CHAMPIONS[0]!.id;
  private hoverId: string | null = null;
  private t = 0;

  constructor(
    private renderer: THREE.WebGLRenderer,
    lib: ModelLibrary,
    private onSelect: (id: string) => void,
  ) {
    this.scene.background = new THREE.Color(0x0a0e1a);
    this.scene.fog = new THREE.Fog(0x0a0e1a, 15, 34);

    const pmrem = new THREE.PMREMGenerator(renderer);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.environmentIntensity = 0.5;
    pmrem.dispose();

    this.scene.add(new THREE.HemisphereLight(0x9fc6ff, 0x1a1a24, 1.0));
    const key = new THREE.DirectionalLight(0xfff1d6, 2.4);
    key.position.set(5, 9, 7);
    this.scene.add(key);
    const rim = new THREE.DirectionalLight(0x6fa0ff, 0.8);
    rim.position.set(-6, 4, -5);
    this.scene.add(rim);

    const floor = new THREE.Mesh(
      new THREE.CircleGeometry(13, 56),
      new THREE.MeshStandardMaterial({ color: 0x161d30, roughness: 0.92, metalness: 0.1 }),
    );
    floor.rotation.x = -Math.PI / 2;
    this.scene.add(floor);

    const n = CHAMPIONS.length;
    const ringGeo = new THREE.RingGeometry(0.72, 0.98, 36);
    CHAMPIONS.forEach((c, i) => {
      const group = new THREE.Group();
      // shallow arc: x sweeps the row, edges bow away from the camera
      const th = (i - (n - 1) / 2) * (ARC_GAP / ARC_R);
      group.position.x = Math.sin(th) * ARC_R;
      group.position.z = (Math.cos(th) - 1) * ARC_R;
      // half-turn each champion toward the camera so the lineup faces you
      const baseYaw = Math.atan2(-group.position.x, CAM_Z - group.position.z) * 0.55;
      group.rotation.y = baseYaw;

      const scale = c.scale ?? 1;
      const char = new AnimatedCharacter(lib, c.model, c.rig === "large" ? "Large/" : "");
      const mats: THREE.MeshStandardMaterial[] = [];
      char.root.traverse((o) => {
        if (!(o instanceof THREE.Mesh)) return;
        if (Array.isArray(o.material)) o.material = o.material.map((mm) => mm.clone());
        else o.material = o.material.clone();
        const mat = Array.isArray(o.material) ? o.material[0] : o.material;
        if (mat instanceof THREE.MeshStandardMaterial) mats.push(mat);
      });
      char.root.scale.setScalar(scale);
      group.add(char.root);
      if (c.weaponR) char.attach(lib.instance(c.weaponR), "handslot.r");
      if (c.weaponL) char.attach(lib.instance(c.weaponL), "handslot.l");

      const ring = new THREE.Mesh(
        ringGeo,
        new THREE.MeshBasicMaterial({ color: c.tint, transparent: true, opacity: 0, side: THREE.DoubleSide }),
      );
      ring.rotation.x = -Math.PI / 2;
      ring.position.y = 0.04;
      group.add(ring);

      const proxy = new THREE.Mesh(
        new THREE.BoxGeometry(1.5, 2.3 * scale, 1.5),
        new THREE.MeshBasicMaterial({ visible: false }),
      );
      proxy.position.y = 1.15 * scale;
      proxy.userData["champId"] = c.id;
      group.add(proxy);
      this.picks.push(proxy);

      this.scene.add(group);
      char.play("Idle_A", { fade: 0 });
      char.update(i * 0.37); // stagger so the idles don't march in lockstep

      this.slots.push({ id: c.id, tint: c.tint, char, group, ring, mats, baseYaw, baseZ: group.position.z });
    });

    this.camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100);
    this.camera.position.set(0, 2.8, CAM_Z);
    this.camera.lookAt(0, 1.05, 0);
    this.resize();
    // NB: don't notify onSelect here — `menu` isn't constructed yet. main.ts
    // calls stage.select(chosenChamp()) once both exist (persisted pick).
  }

  /** Programmatic select (also called from raycast hits). */
  select(id: string): void {
    this.selectedId = id;
    this.onSelect(id);
  }

  /** NDC from a pointer event; raycast the champion proxies. */
  private pick(clientX: number, clientY: number): string | null {
    const ndc = new THREE.Vector2((clientX / window.innerWidth) * 2 - 1, -(clientY / window.innerHeight) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
    const hit = this.raycaster.intersectObjects(this.picks, false)[0];
    return hit ? (hit.object.userData["champId"] as string) : null;
  }

  onPointerMove(clientX: number, clientY: number): void {
    this.hoverId = this.pick(clientX, clientY);
  }

  /** Returns true if a champion was clicked (so the caller can ignore the click otherwise). */
  onClick(clientX: number, clientY: number): boolean {
    const id = this.pick(clientX, clientY);
    if (id) {
      this.select(id);
      return true;
    }
    return false;
  }

  update(dt: number): void {
    this.t += dt;
    for (const s of this.slots) {
      s.char.update(dt);
      const selected = s.id === this.selectedId;
      const hovered = s.id === this.hoverId;
      // selected steps forward + bobs + spins its ring; hovered lifts a touch
      const targetZ = s.baseZ + (selected ? 1.2 : 0);
      const targetScale = selected ? 1.12 : hovered ? 1.05 : 1;
      s.group.position.z += (targetZ - s.group.position.z) * Math.min(1, 8 * dt);
      const sc = s.group.scale.x + (targetScale - s.group.scale.x) * Math.min(1, 8 * dt);
      s.group.scale.setScalar(sc);
      s.group.rotation.y = s.baseYaw + (selected ? Math.sin(this.t * 0.6) * 0.25 : 0);
      const ringMat = s.ring.material as THREE.MeshBasicMaterial;
      const targetOp = selected ? 0.85 + Math.sin(this.t * 4) * 0.15 : hovered ? 0.4 : 0;
      ringMat.opacity += (targetOp - ringMat.opacity) * Math.min(1, 10 * dt);
      s.ring.rotation.z += (selected ? 1.4 : 0.3) * dt;
      // subtle emissive rim on the selected champion
      const glow = selected ? 0.18 : hovered ? 0.07 : 0;
      const c = new THREE.Color(s.tint);
      for (const m of s.mats) m.emissive.setRGB(c.r * glow, c.g * glow, c.b * glow);
    }
  }

  render(): void {
    this.renderer.render(this.scene, this.camera);
  }

  resize(): void {
    this.camera.aspect = window.innerWidth / window.innerHeight;
    this.camera.updateProjectionMatrix();
  }

  dispose(): void {
    for (const s of this.slots) s.char.dispose();
    this.scene.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh) {
        m.geometry?.dispose();
        const mat = m.material;
        if (Array.isArray(mat)) mat.forEach((x) => x.dispose());
        else mat?.dispose();
      }
    });
  }
}
