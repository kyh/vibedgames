import * as THREE from "three";

import { DabSet } from "./dab-set";
import { BASE, RAMP, rampTexture } from "./palette";
import {
  DAB_FRAGMENT,
  DAB_VERTEX,
  MESH_FRAGMENT,
  MESH_VERTEX,
  RESOLVE_FRAGMENT,
  RESOLVE_VERTEX,
  SHADOW_FRAGMENT,
} from "./shaders";

export interface StageView {
  eye: THREE.Vector3;
  target: THREE.Vector3;
  /** Art pixels per world unit: how close the camera sits. */
  zoom: number;
}

/** Where and how one copy of a model stands this frame. */
export interface Placement {
  x: number;
  y: number;
  z: number;
  /** Heading: turns the model's +x towards +z. */
  yaw: number;
  /** Lean about the model's length, and nose-up tilt. */
  roll?: number;
  pitch?: number;
  scale?: number;
  /** Extra vertical squash on top of `scale`. */
  squash?: number;
  /** The ramp that replaces the model's team colour. */
  ramp?: number;
  /** Draw every part in `ramp`, whatever it was built in: a silhouette. */
  mono?: boolean;
  /** Draw every other pixel: see-through, the way a console did it. */
  sheer?: boolean;
  /** High above the board: it throws no shadow until it comes down. */
  aloft?: boolean;
}

/** The board's top as bytes a texel: ramp, step, flags, and which piece of board it belongs to. */
export interface BoardMap {
  bytes: Uint8Array;
  width: number;
  height: number;
  /** World x and z of the texture's first texel. */
  x: number;
  z: number;
  /** Texels per world unit. */
  scale: number;
}

/** The paint and light maps: cells across and down, and cells per world unit. Centred on the origin. */
export const FLOOR_COLS = 672;
export const FLOOR_ROWS = 432;
export const FLOOR_CELLS = 6;

/** Art pixels per world unit at the closest zoom. */
export const PX_PER_UNIT = 16;

const SUN_REACH = 46;
const SUN_FAR = 400;
const ROWS = 360;
const LAYER_DABS = 1;
const LAYER_ALOFT = 2;
const WORLD_IDS = 16;
const NEAR = 1;
const FAR = 600;

const RIGHT = new THREE.Vector3();
const UP = new THREE.Vector3();
const AHEAD = new THREE.Vector3();
const SHIFT = new THREE.Vector3();
const WORLD_UP = new THREE.Vector3(0, 1, 0);
const LIGHT_VP = new THREE.Matrix4();
const PROJECTED = new THREE.Vector3();

const NEAREST = {
  generateMipmaps: false,
  magFilter: THREE.NearestFilter,
  minFilter: THREE.NearestFilter,
} as const;

const dataTexture = (
  bytes: Uint8Array,
  width: number,
  height: number,
  format: THREE.PixelFormat,
) => {
  const texture = new THREE.DataTexture(bytes, width, height, format);
  texture.magFilter = THREE.NearestFilter;
  texture.minFilter = THREE.NearestFilter;
  texture.needsUpdate = true;

  return texture;
};

const dabGeometry = (set: DabSet) => {
  const geometry = new THREE.InstancedBufferGeometry();
  geometry.setAttribute(
    "position",
    new THREE.BufferAttribute(new Float32Array([-1, -1, 1, -1, 1, 1, -1, 1]), 2),
  );
  geometry.setIndex(new THREE.BufferAttribute(new Uint16Array([0, 1, 2, 0, 2, 3]), 1));
  const centers = new THREE.InstancedBufferAttribute(set.centers, 3);
  const data = new THREE.InstancedBufferAttribute(set.data, 4);
  centers.setUsage(THREE.DynamicDrawUsage);
  data.setUsage(THREE.DynamicDrawUsage);
  geometry.setAttribute("aCenter", centers);
  geometry.setAttribute("aData", data);
  geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), Number.POSITIVE_INFINITY);
  geometry.instanceCount = 0;

  return geometry;
};

interface Pool {
  meshes: THREE.Mesh[];
  used: number;
}

export class PixelStage {
  /** Everything drawn as a disc: refilled every frame between `begin` and `render`. */
  readonly dabs = new DabSet(8192);
  /** Direction to the sun. */
  readonly sun = new THREE.Vector3(0.46, 0.74, -0.49).normalize();

  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly world = new THREE.Group();
  private readonly actors = new THREE.Group();
  private readonly pools = new Map<THREE.BufferGeometry, Pool>();
  private readonly orthoCam = new THREE.OrthographicCamera(-1, 1, 1, -1, NEAR, FAR);
  private readonly sunCam = new THREE.OrthographicCamera(
    -SUN_REACH,
    SUN_REACH,
    SUN_REACH,
    -SUN_REACH,
    1,
    SUN_FAR,
  );
  private readonly solid: THREE.RawShaderMaterial;
  private readonly shade: THREE.RawShaderMaterial;
  private readonly dab: THREE.RawShaderMaterial;
  private readonly resolve: THREE.RawShaderMaterial;
  private readonly resolveScene = new THREE.Scene();
  private readonly gbuffer: THREE.WebGLRenderTarget;
  private readonly sunMap: THREE.WebGLRenderTarget | null;
  private readonly paintBytes = new Uint8Array(FLOOR_COLS * FLOOR_ROWS * 2);
  private readonly paint: THREE.DataTexture;
  private readonly light: THREE.DataTexture;
  private readonly slotRamp = new Float32Array(32);
  private readonly dabMesh: THREE.InstancedBufferGeometry;
  private readonly sunSize: number;
  private readonly grid = new THREE.Vector4();
  private readonly pan = new THREE.Vector2();
  private readonly lightVP = new THREE.Matrix4();
  private readonly boardMap = new THREE.Vector3(0, 0, 1);
  private readonly shadow: THREE.Vector4;
  private worldSolids: THREE.BufferGeometry[] = [];
  private boardTexture: THREE.DataTexture | null = null;
  private drawn = 0;
  private sunOn = true;
  private pixel = 3;
  private dpr = 1;
  private wide = 2;
  private tall = 2;

  constructor(renderer: THREE.WebGLRenderer, sunSize: number, lightBytes: Uint8Array) {
    this.renderer = renderer;
    this.sunSize = sunSize;
    this.shadow = new THREE.Vector4(1, 0.12 / SUN_FAR, 0.1, 1 / Math.max(1, sunSize));
    this.paint = dataTexture(this.paintBytes, FLOOR_COLS, FLOOR_ROWS, THREE.RGFormat);
    this.light = dataTexture(lightBytes, FLOOR_COLS, FLOOR_ROWS, THREE.RedFormat);
    this.light.magFilter = THREE.LinearFilter;
    this.light.minFilter = THREE.LinearFilter;

    this.gbuffer = new THREE.WebGLRenderTarget(4, 4, {
      ...NEAREST,
      count: 2,
      depthTexture: new THREE.DepthTexture(4, 4),
    });
    this.sunMap =
      sunSize > 0
        ? new THREE.WebGLRenderTarget(sunSize, sunSize, {
            ...NEAREST,
            depthTexture: new THREE.DepthTexture(sunSize, sunSize),
          })
        : null;

    const base = {
      blending: THREE.NoBlending,
      glslVersion: THREE.GLSL3,
      side: THREE.DoubleSide,
    };

    this.solid = new THREE.RawShaderMaterial({
      ...base,
      fragmentShader: MESH_FRAGMENT,
      uniforms: {
        uBoard: { value: null },
        uBoardMap: { value: this.boardMap },
        uFloorSpan: {
          value: new THREE.Vector2(FLOOR_COLS / FLOOR_CELLS, FLOOR_ROWS / FLOOR_CELLS),
        },
        uLight: { value: this.light },
        uLightVP: { value: this.lightVP },
        uObject: { value: new THREE.Vector4() },
        uPaint: { value: this.paint },
        uPan: { value: this.pan },
        uShadow: { value: this.shadow },
        uShadowMap: { value: this.sunMap?.depthTexture ?? null },
        uSlotRamp: { value: this.slotRamp },
        uSun: { value: new THREE.Vector4(this.sun.x, this.sun.y, this.sun.z, 2.6) },
      },
      vertexShader: MESH_VERTEX,
    });
    this.shade = new THREE.RawShaderMaterial({
      ...base,
      defines: { SHADOW: "" },
      fragmentShader: SHADOW_FRAGMENT,
      uniforms: { uBoard: { value: null }, uBoardMap: { value: this.boardMap } },
      vertexShader: MESH_VERTEX,
    });
    this.dab = new THREE.RawShaderMaterial({
      ...base,
      fragmentShader: DAB_FRAGMENT,
      uniforms: { uDepthPerUnit: { value: 2 / (FAR - NEAR) }, uGrid: { value: this.grid } },
      vertexShader: DAB_VERTEX,
    });
    this.resolve = new THREE.RawShaderMaterial({
      depthTest: false,
      depthWrite: false,
      fragmentShader: RESOLVE_FRAGMENT,
      glslVersion: THREE.GLSL3,
      uniforms: {
        uDepth: { value: this.gbuffer.depthTexture },
        uDepthInfo: { value: new THREE.Vector4(NEAR, FAR, 0.5, 0.07) },
        uRamps: { value: rampTexture() },
        uSun: { value: this.sun },
        uSurface: { value: this.gbuffer.textures[1] ?? null },
        uTones: { value: this.gbuffer.textures[0] ?? null },
        uVoid: { value: new THREE.Vector2(RAMP.sand, BASE - 2) },
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

    this.dabMesh = dabGeometry(this.dabs);
    const discs = new THREE.Mesh(this.dabMesh, this.dab);
    discs.frustumCulled = false;
    discs.layers.set(LAYER_DABS);
    this.orthoCam.layers.enable(LAYER_DABS);
    this.orthoCam.layers.enable(LAYER_ALOFT);
    this.scene.add(this.world, this.actors, discs);
    this.setSun(sunSize > 0);

    const { style } = renderer.domElement;
    style.position = "absolute";
    style.imageRendering = "pixelated";
  }

  /** Art rows and columns on screen. */
  get rows() {
    return this.tall - 2;
  }

  get columns() {
    return this.wide - 2;
  }

  /** The solids that never move. */
  setWorld(geometries: readonly THREE.BufferGeometry[]) {
    for (const geometry of this.worldSolids) {
      geometry.dispose();
    }

    this.world.clear();
    this.worldSolids = [...geometries];

    for (const [index, geometry] of geometries.entries()) {
      const params = new THREE.Vector4(0, 0, index + 1, 0);
      this.world.add(this.bind(new THREE.Mesh(geometry, this.solid), params));
    }
  }

  /** The painted top of the board, read by every face built with the textured ramp. */
  setBoard(map: BoardMap) {
    const texture = dataTexture(map.bytes, map.width, map.height, THREE.RGBAFormat);
    this.boardTexture?.dispose();
    this.boardTexture = texture;

    for (const material of [this.solid, this.shade]) {
      const uniform = material.uniforms.uBoard;

      if (uniform) {
        uniform.value = texture;
      }
    }

    this.boardMap.set(map.x, map.z, map.scale);
  }

  /** Put one copy of `model` on stage for this frame. */
  draw(model: THREE.BufferGeometry, place: Placement) {
    const mesh = this.take(model);
    const { yaw } = place;
    const roll = place.roll ?? 0;
    const pitch = place.pitch ?? 0;
    const cy = Math.cos(yaw);
    const sy = Math.sin(yaw);
    const cr = Math.cos(roll);
    const sr = Math.sin(roll);
    const cp = Math.cos(pitch);
    const sp = Math.sin(pitch);
    const wide = place.scale ?? 1;
    const high = wide * (place.squash ?? 1);
    mesh.matrix.set(
      cy * cp * wide,
      (-cy * sp * cr - sy * sr) * high,
      (cy * sp * sr - sy * cr) * wide,
      place.x,
      sp * wide,
      cp * cr * high,
      -cp * sr * wide,
      place.y,
      sy * cp * wide,
      (-sy * sp * cr + cy * sr) * high,
      (sy * sp * sr + cy * cr) * wide,
      place.z,
      0,
      0,
      0,
      1,
    );
    mesh.matrixWorld.copy(mesh.matrix);
    mesh.layers.set(place.aloft === true ? LAYER_ALOFT : 0);
    this.drawn += 1;
    const params: unknown = mesh.userData.params;

    if (params instanceof THREE.Vector4) {
      params.set(
        place.ramp ?? 0,
        place.mono === true ? 1 : 0,
        WORLD_IDS + (this.drawn % (255 - WORLD_IDS)),
        place.sheer === true ? 1 : 0,
      );
    }
  }

  /** Where a world point lands on the page, in CSS pixels. */
  project(x: number, y: number, z: number) {
    PROJECTED.set(x, y, z).project(this.orthoCam);
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

  /** Whether the sun casts shadows: without them, cars lay their own. */
  get shadows() {
    return this.sunOn;
  }

  /** Which ramp paint slot `slot` shows as. */
  setSlotRamp(slot: number, ramp: number) {
    if (slot > 0 && slot < this.slotRamp.length) {
      this.slotRamp[slot] = ramp;
    }
  }

  /** Copy the glow grid to the texture the floor reads its marks from. */
  uploadPaint(owner: Uint8Array, strength: Float32Array) {
    const out = this.paintBytes;

    for (let cell = 0; cell < owner.length; cell += 1) {
      out[cell * 2] = owner[cell] ?? 0;
      out[cell * 2 + 1] = Math.round((strength[cell] ?? 0) * 255);
    }

    this.paint.needsUpdate = true;
  }

  /** The light map changed: send it to the card. */
  uploadLight() {
    this.light.needsUpdate = true;
  }

  /** Fit the art grid to a window `width` by `height` CSS pixels. */
  resize(width: number, height: number) {
    const dpr = globalThis.devicePixelRatio || 1;
    this.dpr = dpr;
    this.pixel = Math.max(1, Math.round((height * dpr) / ROWS)) / dpr;
    this.wide = Math.ceil(width / this.pixel) + 2;
    this.tall = Math.ceil(height / this.pixel) + 2;
    this.renderer.setPixelRatio(1);
    this.renderer.setSize(this.wide, this.tall, false);
    this.gbuffer.setSize(this.wide, this.tall);
    const { style } = this.renderer.domElement;
    style.width = `${this.wide * this.pixel}px`;
    style.height = `${this.tall * this.pixel}px`;
    style.left = `${Math.round(((width - this.wide * this.pixel) / 2) * dpr) / dpr}px`;
    style.top = `${Math.round(((height - this.tall * this.pixel) / 2) * dpr) / dpr}px`;
  }

  /** Start a frame: nothing that moves is on stage yet. */
  begin() {
    this.dabs.clear();
    this.drawn = 0;

    for (const pool of this.pools.values()) {
      for (let i = 0; i < pool.used; i += 1) {
        const mesh = pool.meshes[i];

        if (mesh) {
          mesh.visible = false;
        }
      }

      pool.used = 0;
    }
  }

  render(view: StageView) {
    const { renderer } = this;
    const camera = this.aimOrtho(view);
    this.upload();

    if (this.sunMap && this.sunOn) {
      this.aimSun(view.target);
      this.scene.overrideMaterial = this.shade;
      renderer.setRenderTarget(this.sunMap);
      renderer.clear();
      renderer.render(this.scene, this.sunCam);
      this.scene.overrideMaterial = null;
    }

    renderer.setRenderTarget(this.gbuffer);
    renderer.setClearColor(0x00_00_00, 0);
    renderer.clear();
    renderer.render(this.scene, camera);
    renderer.setRenderTarget(null);
    renderer.render(this.resolveScene, camera);
  }

  private take(model: THREE.BufferGeometry) {
    let pool = this.pools.get(model);

    if (!pool) {
      pool = { meshes: [], used: 0 };
      this.pools.set(model, pool);
    }

    let mesh = pool.meshes[pool.used];

    if (!mesh) {
      mesh = this.bind(new THREE.Mesh(model, this.solid), new THREE.Vector4());
      pool.meshes.push(mesh);
      this.actors.add(mesh);
    }

    pool.used += 1;
    mesh.visible = true;

    return mesh;
  }

  private bind(mesh: THREE.Mesh, params: THREE.Vector4) {
    mesh.userData.params = params;
    mesh.matrixAutoUpdate = false;
    mesh.matrixWorldAutoUpdate = false;
    mesh.onBeforeRender = (_renderer, _scene, _camera, _geometry, material) => {
      if (material === this.solid) {
        const uniform = this.solid.uniforms.uObject;

        if (uniform) {
          uniform.value = params;
        }

        this.solid.uniformsNeedUpdate = true;
      }
    };

    return mesh;
  }

  private upload() {
    const { dabMesh, dabs } = this;
    dabMesh.instanceCount = dabs.count;

    if (dabs.count === 0) {
      return;
    }

    for (const name of ["aCenter", "aData"]) {
      const attribute = dabMesh.getAttribute(name);

      if (attribute instanceof THREE.InstancedBufferAttribute) {
        attribute.clearUpdateRanges();
        attribute.addUpdateRange(0, dabs.count * attribute.itemSize);
        attribute.needsUpdate = true;
      }
    }
  }

  private aimOrtho(view: StageView) {
    const camera = this.orthoCam;
    const texel = 1 / view.zoom;
    AHEAD.subVectors(view.target, view.eye).normalize();
    RIGHT.crossVectors(AHEAD, WORLD_UP).normalize();
    UP.crossVectors(RIGHT, AHEAD);
    const a = view.target.dot(RIGHT);
    const b = view.target.dot(UP);
    const dx = a - Math.round(a / texel) * texel;
    const dy = b - Math.round(b / texel) * texel;
    SHIFT.set(0, 0, 0).addScaledVector(RIGHT, -dx).addScaledVector(UP, -dy);

    camera.left = (-this.wide * texel) / 2;
    camera.right = (this.wide * texel) / 2;
    camera.top = (this.tall * texel) / 2;
    camera.bottom = (-this.tall * texel) / 2;
    camera.position.copy(view.eye).add(SHIFT);
    camera.up.copy(WORLD_UP);
    camera.lookAt(SHIFT.add(view.target));
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld();
    this.grid.set(this.wide, this.tall, view.zoom, -AHEAD.y);
    this.pan.set(Math.round(a / texel), Math.round(b / texel));
    const { dpr, pixel } = this;
    const slideX = Math.round((-dx / texel) * pixel * dpr) / dpr;
    const slideY = Math.round((dy / texel) * pixel * dpr) / dpr;
    this.renderer.domElement.style.transform = `translate(${slideX}px, ${slideY}px)`;

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
