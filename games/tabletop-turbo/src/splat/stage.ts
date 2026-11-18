import * as THREE from "three";

import { PAINT_CELL, PAINT_SIZE } from "../shared/constants";
import type { PaintGrid } from "../sim/paint";
import { RAMP, rampTexture } from "./palette";
import { RESOLVE_FRAGMENT, RESOLVE_VERTEX, SPLAT_FRAGMENT, SPLAT_VERTEX } from "./shaders";
import { SplatSet } from "./splat-set";

export interface StageView {
  /** Orthographic (a sliding diorama) or perspective (a chase camera). */
  ortho: boolean;
  eye: THREE.Vector3;
  target: THREE.Vector3;
  /** World units the screen shows top to bottom, when orthographic. */
  height: number;
  /** Vertical field of view in degrees, when perspective. */
  fov: number;
  /** Snap the camera to the art grid: for cameras that slide, never for ones that turn. */
  snap: boolean;
  /** Most fog, 0–1, and where it starts and ends in metres from the camera. */
  fog: number;
  fogStart: number;
  fogEnd: number;
}

const CHUNK = 32;
const SUN_REACH = 58;
const SUN_FAR = 400;
const ROWS = 216;
const CUT = Math.sqrt(-2 * Math.log(0.5));

const RIGHT = new THREE.Vector3();
const UP = new THREE.Vector3();
const AHEAD = new THREE.Vector3();
const SHIFT = new THREE.Vector3();
const WORLD_UP = new THREE.Vector3(0, 1, 0);
const LIGHT_VP = new THREE.Matrix4();
const PROJECTED = new THREE.Vector3();

const quad = () => ({
  corner: new THREE.BufferAttribute(new Float32Array([-1, -1, 1, -1, 1, 1, -1, 1]), 2),
  index: new THREE.BufferAttribute(new Uint16Array([0, 1, 2, 0, 2, 3]), 1),
});

const geometryFor = (set: SplatSet, start: number, count: number, moving: boolean) => {
  const geometry = new THREE.InstancedBufferGeometry();
  const { corner, index } = quad();
  geometry.setAttribute("position", corner);
  geometry.setIndex(index);
  const centers = new THREE.InstancedBufferAttribute(set.centers, 3);
  const normals = new THREE.InstancedBufferAttribute(set.normals, 4, true);
  const data = new THREE.InstancedBufferAttribute(set.data, 4);

  if (moving) {
    for (const attribute of [centers, normals, data]) {
      attribute.setUsage(THREE.DynamicDrawUsage);
    }
  }

  geometry.setAttribute("aCenter", centers);
  geometry.setAttribute("aNormal", normals);
  geometry.setAttribute("aData", data);
  geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), Number.POSITIVE_INFINITY);
  geometry.instanceCount = moving ? start : count;

  return geometry;
};

export class SplatStage {
  /** Everything that moves: refilled every frame between `begin` and `render`. */
  readonly dynamic = new SplatSet(49_152, true);
  /** Direction to the sun. */
  readonly sun = new THREE.Vector3(-0.42, 0.74, 0.52).normalize();

  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly world = new THREE.Group();
  private readonly orthoCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 1, 600);
  private readonly perspCam = new THREE.PerspectiveCamera(60, 1, 0.5, 420);
  private readonly sunCam = new THREE.OrthographicCamera(
    -SUN_REACH,
    SUN_REACH,
    SUN_REACH,
    -SUN_REACH,
    1,
    SUN_FAR,
  );
  private readonly splat: THREE.RawShaderMaterial;
  private readonly shade: THREE.RawShaderMaterial;
  private readonly resolve: THREE.RawShaderMaterial;
  private readonly resolveScene = new THREE.Scene();
  private readonly tones: THREE.WebGLRenderTarget;
  private readonly sunMap: THREE.WebGLRenderTarget | null;
  private readonly paintBytes = new Uint8Array(PAINT_SIZE * PAINT_SIZE * 2);
  private readonly paint: THREE.DataTexture;
  private readonly slotRamp = new Float32Array(32);
  private readonly moving: THREE.InstancedBufferGeometry;
  private readonly sunSize: number;
  private readonly grid = new THREE.Vector4();
  private readonly lightVP = new THREE.Matrix4();
  private readonly look = new THREE.Vector4(1, 0.3, CUT, 0);
  private readonly depthInfo = new THREE.Vector4(1, 600, 1, 0.9);
  private readonly fog = new THREE.Vector4(0, 1, 0, 1);
  private readonly rows = { value: 1 };
  private readonly sky = new THREE.Vector4(RAMP.room, 2, 1, 0.5);
  private active: THREE.Camera = this.orthoCam;
  private time = 0;
  private sunOn = true;
  private readonly shadow = new THREE.Vector4(1, 0.9 / SUN_FAR, 0.4, 0);
  private pixel = 3;
  private wide = 2;
  private tall = 2;

  constructor(renderer: THREE.WebGLRenderer, sunSize: number) {
    this.renderer = renderer;
    this.sunSize = sunSize;
    this.paint = new THREE.DataTexture(this.paintBytes, PAINT_SIZE, PAINT_SIZE, THREE.RGFormat);
    this.paint.magFilter = THREE.NearestFilter;
    this.paint.minFilter = THREE.NearestFilter;
    this.paint.needsUpdate = true;

    this.tones = new THREE.WebGLRenderTarget(4, 4, {
      depthTexture: new THREE.DepthTexture(4, 4),
      generateMipmaps: false,
      magFilter: THREE.NearestFilter,
      minFilter: THREE.NearestFilter,
    });
    this.sunMap =
      sunSize > 0
        ? new THREE.WebGLRenderTarget(sunSize, sunSize, {
            depthTexture: new THREE.DepthTexture(sunSize, sunSize),
            generateMipmaps: false,
            magFilter: THREE.NearestFilter,
            minFilter: THREE.NearestFilter,
          })
        : null;

    const common = { value: this.look };

    const base = {
      blending: THREE.NoBlending,
      fragmentShader: SPLAT_FRAGMENT,
      glslVersion: THREE.GLSL3,
      side: THREE.DoubleSide,
      vertexShader: SPLAT_VERTEX,
    };

    this.splat = new THREE.RawShaderMaterial({
      ...base,
      uniforms: {
        uGrid: { value: this.grid },
        uLightVP: { value: this.lightVP },
        uPaint: { value: this.paint },
        uPaintSpan: { value: PAINT_SIZE * PAINT_CELL },
        uShade: { value: new THREE.Vector4(1, 1, 0.35, 0.8) },
        uShadow: { value: this.shadow },
        uShadowMap: { value: this.sunMap?.depthTexture ?? null },
        uSlotRamp: { value: this.slotRamp },
        uSplat: common,
        uSun: { value: new THREE.Vector4(this.sun.x, this.sun.y, this.sun.z, 0.45) },
      },
    });
    this.shade = new THREE.RawShaderMaterial({
      ...base,
      defines: { SHADOW: "" },
      uniforms: {
        uGrid: {
          value: new THREE.Vector4(sunSize, sunSize, sunSize / (SUN_REACH * 2), 1),
        },
        uSplat: common,
      },
    });
    this.resolve = new THREE.RawShaderMaterial({
      depthTest: false,
      depthWrite: false,
      fragmentShader: RESOLVE_FRAGMENT,
      glslVersion: THREE.GLSL3,
      uniforms: {
        uDepth: { value: this.tones.depthTexture },
        uDepthInfo: { value: this.depthInfo },
        uFog: { value: this.fog },
        uRamps: { value: rampTexture() },
        uRows: this.rows,
        uSky: { value: this.sky },
        uTones: { value: this.tones.texture },
      },
      vertexShader: RESOLVE_VERTEX,
    });

    const screen = new THREE.BufferGeometry();
    screen.setAttribute(
      "position",
      new THREE.BufferAttribute(new Float32Array([-1, -1, 3, -1, -1, 3]), 2),
    );
    screen.boundingSphere = new THREE.Sphere(new THREE.Vector3(), Number.POSITIVE_INFINITY);
    const cover = new THREE.Mesh(screen, this.resolve);
    cover.frustumCulled = false;
    this.resolveScene.add(cover);

    this.moving = geometryFor(this.dynamic, 0, this.dynamic.capacity, true);
    const mover = new THREE.Mesh(this.moving, this.splat);
    mover.frustumCulled = false;
    this.scene.add(this.world, mover);
    this.setSun(sunSize > 0);

    const { style } = renderer.domElement;
    style.position = "absolute";
    style.imageRendering = "pixelated";
  }

  /** The static world, split into chunks the cameras can cull. */
  setWorld(set: SplatSet) {
    for (const child of this.world.children) {
      if (child instanceof THREE.Mesh) {
        child.geometry.dispose();
      }
    }

    this.world.clear();
    const buckets = new Map<string, number[]>();

    for (let i = 0; i < set.count; i += 1) {
      const key = `${Math.floor((set.centers[i * 3] ?? 0) / CHUNK)}:${Math.floor((set.centers[i * 3 + 2] ?? 0) / CHUNK)}`;
      const list = buckets.get(key);

      if (list) {
        list.push(i);
      } else {
        buckets.set(key, [i]);
      }
    }

    for (const list of buckets.values()) {
      const part = new SplatSet(list.length);

      for (const i of list) {
        part.centers.set(set.centers.subarray(i * 3, i * 3 + 3), part.count * 3);
        part.normals.set(set.normals.subarray(i * 4, i * 4 + 4), part.count * 4);
        part.data.set(set.data.subarray(i * 4, i * 4 + 4), part.count * 4);
        part.count += 1;
      }

      const geometry = geometryFor(part, 0, part.count, false);
      geometry.boundingSphere = new THREE.Sphere().setFromPoints(
        list.map(
          (i) =>
            new THREE.Vector3(
              set.centers[i * 3] ?? 0,
              set.centers[i * 3 + 1] ?? 0,
              set.centers[i * 3 + 2] ?? 0,
            ),
        ),
      );
      geometry.boundingSphere.radius += 1;
      this.world.add(new THREE.Mesh(geometry, this.splat));
    }
  }

  /** The wall colour behind everything: the ramp the far distance and the fog are drawn in. */
  setSky(ramp: number) {
    this.sky.x = ramp;
  }

  /** Where a world point lands on the page, in CSS pixels; null when it is behind the camera. */
  project(x: number, y: number, z: number) {
    PROJECTED.set(x, y, z).project(this.active);

    if (PROJECTED.z > 1) {
      return null;
    }

    const box = this.renderer.domElement.getBoundingClientRect();

    return {
      x: box.left + ((PROJECTED.x + 1) / 2) * box.width,
      y: box.top + ((1 - PROJECTED.y) / 2) * box.height,
    };
  }

  /** Turn the shadow pass on or off. Without a depth map it stays off. */
  setSun(on: boolean) {
    this.sunOn = on && this.sunMap !== null;
    this.shadow.x = this.sunOn ? 1 : 0;
  }

  /** Which ramp paint slot `slot` shows as. */
  setSlotRamp(slot: number, ramp: number) {
    if (slot > 0 && slot < this.slotRamp.length) {
      this.slotRamp[slot] = ramp;
    }
  }

  /** Copy the paint grid to the texture the track's splats read their colour from. */
  uploadPaint(grid: PaintGrid) {
    const { owner, strength } = grid;
    const out = this.paintBytes;

    for (let cell = 0; cell < owner.length; cell += 1) {
      out[cell * 2] = owner[cell] ?? 0;
      out[cell * 2 + 1] = Math.round((strength[cell] ?? 0) * 255);
    }

    this.paint.needsUpdate = true;
  }

  /** Fit the art grid to a window `width` by `height` CSS pixels. */
  resize(width: number, height: number) {
    this.pixel = Math.max(2, Math.round(height / ROWS));
    this.wide = Math.ceil(width / this.pixel) + 2;
    this.tall = Math.ceil(height / this.pixel) + 2;
    this.renderer.setPixelRatio(1);
    this.renderer.setSize(this.wide, this.tall, false);
    this.tones.setSize(this.wide * 2, this.tall * 2);
    const { style } = this.renderer.domElement;
    style.width = `${this.wide * this.pixel}px`;
    style.height = `${this.tall * this.pixel}px`;
    style.left = `${Math.round((width - this.wide * this.pixel) / 2)}px`;
    style.top = `${Math.round((height - this.tall * this.pixel) / 2)}px`;
  }

  /** Start a frame: nothing that moves is on stage yet. */
  begin(dt: number) {
    this.time += dt;
    this.look.w = this.time;
    this.dynamic.clear();
  }

  render(view: StageView) {
    const { renderer } = this;
    const camera = view.ortho ? this.aimOrtho(view) : this.aimPersp(view);
    this.active = camera;
    this.upload();

    if (this.sunMap && this.sunOn) {
      this.aimSun(view.target);
      this.scene.overrideMaterial = this.shade;
      renderer.setRenderTarget(this.sunMap);
      renderer.clear();
      renderer.render(this.scene, this.sunCam);
      this.scene.overrideMaterial = null;
    }

    renderer.setRenderTarget(this.tones);
    renderer.setClearColor(0x00_00_00, 0);
    renderer.clear();
    renderer.render(this.scene, camera);

    this.depthInfo.set(camera.near, camera.far, view.ortho ? 1 : 0, 0.9);
    this.fog.set(view.fogStart, view.fogEnd, view.fog, 2);
    this.rows.value = this.tall;
    renderer.setRenderTarget(null);
    renderer.render(this.resolveScene, camera);
  }

  private upload() {
    const { dynamic, moving } = this;
    const count = Math.min(dynamic.count, moving.getAttribute("aData").count);
    moving.instanceCount = count;

    for (const name of ["aCenter", "aNormal", "aData"]) {
      const attribute = moving.getAttribute(name);

      if (attribute instanceof THREE.InstancedBufferAttribute) {
        attribute.clearUpdateRanges();
        attribute.addUpdateRange(0, count * attribute.itemSize);
        attribute.needsUpdate = true;
      }
    }
  }

  private aimOrtho(view: StageView) {
    const camera = this.orthoCam;
    const rows = this.tall - 2;
    const texel = view.height / rows;
    AHEAD.subVectors(view.target, view.eye).normalize();
    RIGHT.crossVectors(AHEAD, WORLD_UP).normalize();
    UP.crossVectors(RIGHT, AHEAD);
    let dx = 0;
    let dy = 0;
    SHIFT.set(0, 0, 0);

    if (view.snap) {
      const a = view.target.dot(RIGHT);
      const b = view.target.dot(UP);
      dx = a - Math.round(a / texel) * texel;
      dy = b - Math.round(b / texel) * texel;
      SHIFT.addScaledVector(RIGHT, -dx).addScaledVector(UP, -dy);
    }

    camera.left = (-this.wide * texel) / 2;
    camera.right = (this.wide * texel) / 2;
    camera.top = (this.tall * texel) / 2;
    camera.bottom = (-this.tall * texel) / 2;
    camera.position.copy(view.eye).add(SHIFT);
    camera.up.copy(WORLD_UP);
    camera.lookAt(SHIFT.add(view.target));
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld();
    this.grid.set(this.wide * 2, this.tall * 2, 2 / texel, 1);
    const { pixel } = this;
    this.renderer.domElement.style.transform = `translate(${((-dx / texel) * pixel).toFixed(2)}px, ${((dy / texel) * pixel).toFixed(2)}px)`;

    return camera;
  }

  private aimPersp(view: StageView) {
    const camera = this.perspCam;
    camera.fov = view.fov;
    camera.aspect = this.wide / this.tall;
    camera.position.copy(view.eye);
    camera.lookAt(view.target);
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld();
    const focal = this.tall / Math.tan(THREE.MathUtils.degToRad(view.fov) / 2);
    this.grid.set(this.wide * 2, this.tall * 2, focal, 0);
    this.renderer.domElement.style.transform = "none";

    return camera;
  }

  private aimSun(target: THREE.Vector3) {
    const camera = this.sunCam;
    AHEAD.copy(this.sun).negate();
    RIGHT.crossVectors(AHEAD, WORLD_UP).normalize();
    UP.crossVectors(RIGHT, AHEAD);
    const texel = (SUN_REACH * 2) / this.sunSize;
    const a = Math.round(target.dot(RIGHT) / texel) * texel;
    const b = Math.round(target.dot(UP) / texel) * texel;
    const c = target.dot(AHEAD);
    SHIFT.set(0, 0, 0).addScaledVector(RIGHT, a).addScaledVector(UP, b).addScaledVector(AHEAD, c);
    camera.position.copy(SHIFT).addScaledVector(this.sun, SUN_FAR / 2);
    camera.up.copy(WORLD_UP);
    camera.lookAt(SHIFT);
    camera.updateMatrixWorld();
    camera.matrixWorldInverse.copy(camera.matrixWorld).invert();
    LIGHT_VP.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this.lightVP.copy(LIGHT_VP);
  }
}
