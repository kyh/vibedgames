// One circuit's place: sky, sun, ground, road and everything beside it. Built
// per track and thrown away on a track change; the paint texture it is handed
// is the only thing shared between circuits.

import * as THREE from "three";

import { curvatureAt, pointAt } from "../sim/track";
import type { Track } from "../sim/track";
import type { PaintLayer } from "./paint-layer";
import { addContactStrips, addCornerBoards, addInfield, addShade, addVerge } from "./props";
import { KERB_INSET, mottle, ribbon, roadMaterial } from "./road";
import {
  BLOCK,
  Kit,
  REACH,
  addBarriers,
  addBillboards,
  addBuildings,
  addGantry,
  addGrandstand,
  addLamps,
  addPads,
  addPits,
  addTrees,
  addTyres,
} from "./scenery";
import type { Gantry } from "./scenery";
import { Site } from "./site";
import { Sky } from "./sky";
import { asphalt, concrete, grass, seeded } from "./textures";

/** World units the baked ground plan covers, and its resolution. */
const PLAN_SPAN = 880;
const PLAN_PX = 2048;
/** Half-extent of the square the sun's shadow map covers around the action. */
const SHADOW_REACH = 95;

/**
 * The ground is layers a few centimetres apart: road on apron on lawn on plan.
 * From far away that is less than the depth buffer can tell apart, and the
 * layers fight triangle by triangle. Each lower layer is pushed back by a
 * polygon offset, so the order holds at any distance.
 */
const under = (layer: number) => ({
  polygonOffset: true,
  polygonOffsetFactor: layer * 2,
  polygonOffsetUnits: layer * 12,
});

export interface WorldOptions {
  /** Shadow map size, or 0 for none (phones). */
  shadows: number;
}

/** Draw every plot's ground: paving in one of a few tones, a car park with bays, or a small park. */
const paintLots = (
  ctx: CanvasRenderingContext2D,
  px: (v: number) => number,
  scale: number,
  random: () => number,
  tarmac: string,
): void => {
  // Every plot gets a ground treatment of its own: paving in one of a few
  // tones, a car park with bays, or a small park. No two neighbours alike.
  for (let gx = -REACH; gx < REACH; gx += BLOCK) {
    for (let gz = -REACH; gz < REACH; gz += BLOCK) {
      const x0 = px(gx + 4.5);
      const y0 = px(gz + 4.5);
      const side = (BLOCK - 9) * scale;
      const kind = random();
      if (kind < 0.2) {
        ctx.fillStyle = "#3f7a44";
        ctx.fillRect(x0, y0, side, side);
      } else if (kind < 0.42) {
        ctx.fillStyle = tarmac;
        ctx.fillRect(x0, y0, side, side);
        ctx.strokeStyle = "rgba(240,235,215,0.55)";
        ctx.lineWidth = 0.22 * scale;
        for (let bay = 1; bay < 9; bay += 1) {
          const bx = x0 + (bay * side) / 9;
          ctx.beginPath();
          ctx.moveTo(bx, y0 + side * 0.08);
          ctx.lineTo(bx, y0 + side * 0.38);
          ctx.moveTo(bx, y0 + side * 0.62);
          ctx.lineTo(bx, y0 + side * 0.92);
          ctx.stroke();
        }
      } else {
        const tone = 150 + Math.floor(random() * 70);
        ctx.fillStyle = `rgb(${tone},${tone - 6},${tone - 14})`;
        ctx.fillRect(x0, y0, side, side);
        ctx.strokeStyle = "rgba(0,0,0,0.12)";
        ctx.lineWidth = 0.12 * scale;
        for (let t = 1; t < 6; t += 1) {
          ctx.beginPath();
          ctx.moveTo(x0 + (t * side) / 6, y0);
          ctx.lineTo(x0 + (t * side) / 6, y0 + side);
          ctx.moveTo(x0, y0 + (t * side) / 6);
          ctx.lineTo(x0 + side, y0 + (t * side) / 6);
          ctx.stroke();
        }
      }
    }
  }
};

/**
 * The ground plan, drawn once: plaza, the street grid between building plots,
 * the lawn inside the loop, the concrete apron under the road. One texture
 * over the whole district, so an overview reads as a place.
 */
const groundPlan = (track: Track): THREE.CanvasTexture => {
  const { palette } = track.def;
  const random = seeded(track.n + 3);
  const canvas = document.createElement("canvas");
  canvas.width = PLAN_PX;
  canvas.height = PLAN_PX;
  const ctx = canvas.getContext("2d");
  const scale = PLAN_PX / PLAN_SPAN;
  const px = (v: number): number => (v + PLAN_SPAN / 2) * scale;
  if (ctx) {
    ctx.fillStyle = palette.plaza;
    ctx.fillRect(0, 0, PLAN_PX, PLAN_PX);
    // Streets on the plot grid, with a centre line.
    for (let g = -REACH; g <= REACH; g += BLOCK) {
      ctx.fillStyle = palette.road;
      ctx.fillRect(px(g) - 4.5 * scale, 0, 9 * scale, PLAN_PX);
      ctx.fillRect(0, px(g) - 4.5 * scale, PLAN_PX, 9 * scale);
    }
    ctx.strokeStyle = "rgba(235,225,190,0.5)";
    ctx.lineWidth = 0.35 * scale;
    ctx.setLineDash([4 * scale, 5 * scale]);
    for (let g = -REACH; g <= REACH; g += BLOCK) {
      ctx.beginPath();
      ctx.moveTo(px(g), 0);
      ctx.lineTo(px(g), PLAN_PX);
      ctx.moveTo(0, px(g));
      ctx.lineTo(PLAN_PX, px(g));
      ctx.stroke();
    }
    ctx.setLineDash([]);
    paintLots(ctx, px, scale, random, palette.road);

    const loop = new Path2D();
    for (let i = 0; i < track.n; i += 2) {
      const x = px(track.xs[i] ?? 0);
      const y = px(track.zs[i] ?? 0);
      if (i === 0) {
        loop.moveTo(x, y);
      } else {
        loop.lineTo(x, y);
      }
    }
    loop.closePath();

    // A green verge either side of the circuit, then the lawn inside it.
    ctx.lineJoin = "round";
    ctx.strokeStyle = "#35683a";
    ctx.lineWidth = (track.rail + 17) * 2 * scale;
    ctx.stroke(loop);
    ctx.save();
    ctx.clip(loop);
    ctx.fillStyle = "#35683a";
    ctx.fillRect(0, 0, PLAN_PX, PLAN_PX);
    ctx.restore();
    // Mottle the grass: mown stripes of lighter and darker green, dry patches.
    ctx.save();
    ctx.globalCompositeOperation = "source-atop";
    for (let i = 0; i < 900; i += 1) {
      const x = random() * PLAN_PX;
      const y = random() * PLAN_PX;
      const r = (6 + random() * 26) * scale;
      const blot = ctx.createRadialGradient(x, y, 0, x, y, r);
      const tone = random();
      let shade = "rgba(120,170,80,0.5)";
      if (tone < 0.5) {
        shade = "rgba(20,60,30,0.55)";
      } else if (tone > 0.9) {
        shade = "rgba(190,170,110,0.45)";
      }
      blot.addColorStop(0, shade);
      blot.addColorStop(1, "rgba(0,0,0,0)");
      ctx.fillStyle = blot;
      ctx.fillRect(x - r, y - r, r * 2, r * 2);
    }
    ctx.restore();

    // Gravel traps on the outside of the bends, and footpaths across the lawn.
    ctx.fillStyle = "#d9c9a2";
    for (let i = 0; i < track.n; i += 3) {
      const bend = curvatureAt(track, i);
      if (Math.abs(bend) > 0.03) {
        const p = pointAt(track, i, -Math.sign(bend) * (track.rail + 7));
        ctx.beginPath();
        ctx.arc(px(p.x), px(p.z), 6.5 * scale, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.save();
    ctx.clip(loop);
    ctx.strokeStyle = "#cdbf9c";
    ctx.lineWidth = 2.2 * scale;
    for (let path = 0; path < 5; path += 1) {
      ctx.beginPath();
      ctx.moveTo(random() * PLAN_PX, random() * PLAN_PX);
      ctx.bezierCurveTo(
        random() * PLAN_PX,
        random() * PLAN_PX,
        random() * PLAN_PX,
        random() * PLAN_PX,
        random() * PLAN_PX,
        random() * PLAN_PX,
      );
      ctx.stroke();
    }
    ctx.restore();

    // The apron the road and its barriers sit on.
    ctx.strokeStyle = palette.apron;
    ctx.lineWidth = (track.rail + 2.6) * 2 * scale;
    ctx.stroke(loop);
    // Stains and wear over everything, so no region is one flat tone.
    for (let i = 0; i < 500; i += 1) {
      const x = random() * PLAN_PX;
      const y = random() * PLAN_PX;
      const r = (8 + random() * 40) * scale;
      const blot = ctx.createRadialGradient(x, y, 0, x, y, r);
      blot.addColorStop(0, random() < 0.6 ? "rgba(0,0,0,0.16)" : "rgba(255,245,225,0.1)");
      blot.addColorStop(1, "rgba(0,0,0,0)");
      ctx.fillStyle = blot;
      ctx.fillRect(x - r, y - r, r * 2, r * 2);
    }
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 8;
  return texture;
};

export class World {
  readonly group = new THREE.Group();
  /** Where the low sun sits, as a unit vector from the scene towards it. */
  readonly sunDir: THREE.Vector3;
  private readonly kit: Kit;
  private readonly sky: Sky;
  private readonly sun: THREE.DirectionalLight;
  private readonly padMaterials: THREE.MeshBasicMaterial[];
  private readonly padColor: THREE.Color;
  private readonly gantry: Gantry;
  private readonly track: Track;
  private reach = SHADOW_REACH;

  constructor(track: Track, paint: PaintLayer, options: WorldOptions) {
    const { palette } = track.def;
    this.track = track;
    this.kit = new Kit(track.n);
    const { kit } = this;
    this.sunDir = new THREE.Vector3(
      Math.cos(palette.bearing),
      0.62,
      Math.sin(palette.bearing),
    ).normalize();
    this.sky = new Sky(palette, this.sunDir, track.n);
    this.group.add(this.sky.group, kit.group);

    // Low warm key, cool fill from the sky, a little bounce off the ground.
    this.sun = new THREE.DirectionalLight(palette.key, 3.6);
    this.sun.castShadow = options.shadows > 0;
    if (options.shadows > 0) {
      const { shadow } = this.sun;
      shadow.mapSize.set(options.shadows, options.shadows);
      shadow.camera.left = -SHADOW_REACH;
      shadow.camera.right = SHADOW_REACH;
      shadow.camera.top = SHADOW_REACH;
      shadow.camera.bottom = -SHADOW_REACH;
      shadow.camera.near = 20;
      shadow.camera.far = 520;
      shadow.bias = -0.0006;
      shadow.normalBias = 0.06;
      shadow.radius = 4;
    }
    // Apply the frustum: an orthographic shadow camera keeps its default
    // ±5 units until its projection is rebuilt.
    this.setShadowReach(SHADOW_REACH);
    this.group.add(this.sun, this.sun.target);
    this.group.add(new THREE.HemisphereLight(palette.fill, "#7a685c", 1.75));

    this.addGround(track);
    this.addRoad(track, paint);
    const site = new Site(track);
    addBarriers(kit, track, paint);
    addTyres(kit, track);
    addBuildings(kit, site);
    addShade(kit, addTrees(kit, site));
    addContactStrips(kit, track);
    addVerge(kit, track);
    addCornerBoards(kit, track);
    addInfield(kit, site);
    addLamps(kit, track);
    addBillboards(kit, track);
    addGrandstand(kit, track);
    addPits(kit, track);
    this.gantry = addGantry(kit, track);
    this.padMaterials = addPads(kit, track);
    this.padColor = new THREE.Color(palette.accent2);
    this.follow(new THREE.Vector3());
  }

  /** `padReady[i]` is whether splat pad i is armed; resting pads go dim. */
  update(time: number, padReady: readonly boolean[], focus: THREE.Vector3): void {
    this.sky.update(time);
    for (const [i, material] of this.padMaterials.entries()) {
      const armed = padReady[i] ?? true;
      const pulse = armed ? 0.7 + Math.sin(time * 5 + i) * 0.3 : 0.1;
      material.color.copy(this.padColor).multiplyScalar(pulse * 1.3);
    }
    this.follow(focus);
  }

  /** Light the start gantry: `count` red lamps on, or all green on the go. */
  setStartLights(count: number, go: boolean): void {
    for (const [i, material] of this.gantry.lights.entries()) {
      if (go) {
        material.color.set("#35ff6b");
      } else {
        material.color.set(i < count ? "#ff2a1a" : "#2a0606");
      }
    }
  }

  /** Widen the shadow map to the whole district (the overview) or back to the action. */
  setShadowReach(reach: number): void {
    const { camera } = this.sun.shadow;
    camera.left = -reach;
    camera.right = reach;
    camera.top = reach;
    camera.bottom = -reach;
    // The light backs off as the frustum widens, so its near plane never cuts the ground.
    camera.near = 10;
    camera.far = reach * 4 + 260;
    camera.updateProjectionMatrix();
    this.reach = reach;
  }

  /** A prefiltered copy of this sky, for reflections on paint and bodywork. */
  environment(renderer: THREE.WebGLRenderer): THREE.Texture {
    const { palette } = this.track.def;
    const scene = new THREE.Scene();
    const sky = new Sky(palette, this.sunDir, this.track.n);
    scene.add(sky.group);
    const generator = new THREE.PMREMGenerator(renderer);
    const { texture } = generator.fromScene(scene, 0.02, 1, 1100);
    generator.dispose();
    sky.dispose();
    return texture;
  }

  dispose(): void {
    this.group.removeFromParent();
    this.sky.dispose();
    this.kit.dispose();
    this.sun.shadow.map?.dispose();
  }

  /** Keep the shadow map centred on the action, snapped so its texels do not swim. */
  private follow(focus: THREE.Vector3): void {
    const snap = (this.reach * 2) / Math.max(1, this.sun.shadow.mapSize.x);
    const x = Math.round(focus.x / snap) * snap;
    const z = Math.round(focus.z / snap) * snap;
    this.sun.target.position.set(x, 0, z);
    this.sun.position.set(x, 0, z).addScaledVector(this.sunDir, this.reach * 2 + 80);
  }

  private addGround(track: Track): void {
    const { kit } = this;
    const plan = kit.own(groundPlan(track));
    const detail = concrete("#ffffff", 29);
    kit.own(detail.map);
    kit.own(detail.normalMap);
    kit.own(detail.roughnessMap);
    detail.normalMap.repeat.set(PLAN_SPAN / 10, PLAN_SPAN / 10);
    detail.roughnessMap.repeat.set(PLAN_SPAN / 10, PLAN_SPAN / 10);
    const material = kit.own(
      new THREE.MeshStandardMaterial({
        ...under(3),
        map: plan,
        normalMap: detail.normalMap,
        normalScale: new THREE.Vector2(0.7, 0.7),
        roughness: 1,
        roughnessMap: detail.roughnessMap,
      }),
    );
    const ground = kit.mesh(
      new THREE.PlaneGeometry(PLAN_SPAN, PLAN_SPAN).rotateX(-Math.PI / 2),
      material,
    );
    ground.position.y = -0.3;
    ground.castShadow = false;
    // Past the plan the district just goes on, in the plaza tone, into the haze.
    const beyond = kit.mesh(
      new THREE.PlaneGeometry(3000, 3000).rotateX(-Math.PI / 2),
      kit.own(
        new THREE.MeshStandardMaterial({
          ...under(4),
          color: track.def.palette.plaza,
          roughness: 1,
        }),
      ),
    );
    beyond.position.y = -0.6;
    beyond.castShadow = false;
    // A strip of real grass texture right beside the barriers, where the camera sits.
    const turf = grass();
    kit.own(turf.map);
    kit.own(turf.normalMap);
    kit.own(turf.roughnessMap);
    const lawn = kit.own(new THREE.MeshStandardMaterial({ ...turf, ...under(2), roughness: 1 }));
    mottle(lawn, 0.5, 0.11);
    mottle(material, 0.3, 0.06);
    for (const side of [-1, 1]) {
      const strip = kit.mesh(
        ribbon(track, side * (track.rail + 1.6), side * (track.rail + 17), -0.14),
        lawn,
      );
      strip.castShadow = false;
    }
  }

  private addRoad(track: Track, paint: PaintLayer): void {
    const { kit } = this;
    const { palette } = track.def;
    const tar = asphalt(palette.road);
    kit.own(tar.map);
    kit.own(tar.normalMap);
    kit.own(tar.roughnessMap);
    const road = kit.own(
      roadMaterial(
        track,
        paint,
        tar,
        new THREE.Color(palette.accent).multiplyScalar(0.85),
        new THREE.Color("#ecebe6"),
      ),
    );
    const edge = track.halfWidth / KERB_INSET;
    const surface = kit.mesh(ribbon(track, -edge, edge, 0), road);
    surface.castShadow = false;
    const slab = concrete(palette.apron, 43);
    kit.own(slab.map);
    kit.own(slab.normalMap);
    kit.own(slab.roughnessMap);
    const apron = kit.mesh(
      ribbon(track, -track.rail - 1.7, track.rail + 1.7, -0.06),
      kit.own(new THREE.MeshStandardMaterial({ ...slab, ...under(1), roughness: 0.95 })),
    );
    apron.castShadow = false;
  }
}
