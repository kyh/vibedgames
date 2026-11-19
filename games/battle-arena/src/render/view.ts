import { softLightMaterial } from "./soft-light";
import * as THREE from "three";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";
import { ShaderPass } from "three/addons/postprocessing/ShaderPass.js";
import { SMAAPass } from "three/addons/postprocessing/SMAAPass.js";
import { FXAAShader } from "three/addons/shaders/FXAAShader.js";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import {
  APOTHEM,
  ARENA,
  BOSS_PLATFORM_RADIUS,
  BOSS_HEIGHT,
  CAMPS,
  DELIVERY_PADS,
  HEX_R,
  OBSTACLES,
  SPAWNS,
} from "../data/map";
import { terrainHeight } from "../data/terrain";
import { PLATEAU_R, STAIR_RUN } from "../sim/elevation";
import { teamColor } from "./palette";

const INTRO_S = 2.4;

const CAM = {
  baseElev: 0.62,
  distance: 10,
  fov: 52,
  lookAhead: 6,
  lookHeight: 1.4,
  posLerp: 10,
};

const GradeShader = {
  fragmentShader: `
    uniform sampler2D tDiffuse; uniform float uContrast,uSaturation,uVignette,uVigStart,uFlash; uniform vec3 uLift,uGain;
    varying vec2 vUv;
    void main(){
      vec3 c = texture2D(tDiffuse, vUv).rgb;
      c = c*uGain + uLift*(1.0-c);
      c = (c-0.5)*uContrast + 0.5;
      float l = dot(c, vec3(0.2126,0.7152,0.0722));
      c = mix(vec3(l), c, uSaturation);
      float r = length(vUv-0.5)*1.4142;
      c *= 1.0 - uVignette*smoothstep(uVigStart,1.0,r);
      c += (vec3(1.0)-c) * uFlash;
      gl_FragColor = vec4(clamp(c,0.0,1.0),1.0);
    }`,
  uniforms: {
    tDiffuse: { value: null },
    uContrast: { value: 1.08 },
    uFlash: { value: 0 },
    uGain: { value: new THREE.Vector3(1.03, 1.01, 0.97) },
    uLift: { value: new THREE.Vector3(-0.006, -0.003, 0.012) },
    uSaturation: { value: 1.1 },
    uVigStart: { value: 0.7 },
    uVignette: { value: 0.18 },
  },
  vertexShader:
    "varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }",
};

/** `CAM.fov` is the VERTICAL angle, so holding it fixed on a portrait phone
 *  collapses the horizontal view to a corridor (25° at 393×852 against 82° at
 *  16:9). Below square, hold the HORIZONTAL fov at its square-aspect value
 *  instead — solve vFov from hFov(1) = base — capped so extreme ratios don't
 *  fisheye. Same solve as games/tetris' camera rig. */
export const fovForAspect = (base: number, aspect: number) => {
  if (aspect >= 1) {
    return base;
  }

  return Math.min(110, (Math.atan(Math.tan((base * Math.PI) / 360) / aspect) * 360) / Math.PI);
};

const sstep = (e0: number, e1: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));

  return t * t * (3 - 2 * t);
};

let shadowRefresher: (() => void) | null = null;

/** Re-render the static shadow map once — safe no-op before the View exists. */
export const refreshStaticShadows = () => {
  shadowRefresher?.();
};

const GROUND_STONE = new THREE.Color(0x56_5b_68);
const GROUND_DIRT = new THREE.Color(0x4a_42_38);

const groundZoneColor = (x: number, z: number, out: THREE.Color) => {
  out.copy(GROUND_STONE);
  let campD2 = Infinity;

  for (const c of CAMPS) {
    const d2 = (x - c.x) ** 2 + (z - c.y) ** 2;

    if (d2 < campD2) {
      campD2 = d2;
    }
  }

  const dirtK = 1 - sstep(3.5, 5.5, Math.sqrt(campD2));

  if (dirtK > 0) {
    out.lerp(GROUND_DIRT, dirtK * 0.85);
  }

  return out;
};

const buildGroundDisc = () => {
  const R = HEX_R + 6;
  const seg = 96;
  const DROP = 0.02;
  const uniform = 40;
  const radii: number[] = [];

  for (let ring = 1; ring <= uniform; ring += 1) {
    radii.push((ring / uniform) * R);
  }

  radii.push(PLATEAU_R, PLATEAU_R + 0.05);

  for (let i = 1; i <= 4; i += 1) {
    radii.push(PLATEAU_R + (i / 4) * STAIR_RUN);
  }

  radii.sort((a, b) => a - b);
  const rings = radii.length;
  const zc = new THREE.Color();
  groundZoneColor(0, 0, zc);
  const pos: number[] = [0, terrainHeight(0, 0) - DROP, 0];
  const col: number[] = [zc.r, zc.g, zc.b];

  for (const rr of radii) {
    for (let s = 0; s < seg; s += 1) {
      const a = (s / seg) * Math.PI * 2;
      const x = Math.cos(a) * rr;
      const z = Math.sin(a) * rr;
      pos.push(x, terrainHeight(x, z) - DROP, z);
      groundZoneColor(x, z, zc);
      col.push(zc.r, zc.g, zc.b);
    }
  }

  const idx: number[] = [];

  for (let s = 0; s < seg; s += 1) {
    idx.push(0, 1 + s, 1 + ((s + 1) % seg));
  }

  for (let ring = 0; ring < rings - 1; ring += 1) {
    const a0 = 1 + ring * seg;
    const a1 = 1 + (ring + 1) * seg;

    for (let s = 0; s < seg; s += 1) {
      const sn = (s + 1) % seg;
      idx.push(a0 + s, a1 + s, a0 + sn, a0 + sn, a1 + s, a1 + sn);
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
  geo.setIndex(idx);
  geo.computeVertexNormals();

  const mesh = new THREE.Mesh(
    geo,
    new THREE.MeshStandardMaterial({
      metalness: 0,
      roughness: 1,
      side: THREE.DoubleSide,
      vertexColors: true,
    }),
  );

  mesh.receiveShadow = true;

  return mesh;
};

const clampCamDistance = (px: number, pz: number, dx: number, dz: number) => {
  let dist = CAM.distance;

  const consider = (ox: number, oz: number, orad: number) => {
    const rr = orad + 0.7;
    const rx = ox - px;
    const rz = oz - pz;
    const b = rx * dx + rz * dz;

    if (b <= 0) {
      return;
    }

    const c = rx * rx + rz * rz - rr * rr;
    const disc = b * b - c;

    if (disc < 0) {
      return;
    }

    const entry = b - Math.sqrt(disc);

    if (entry > 0.5 && entry - 0.5 < dist) {
      dist = entry - 0.5;
    }
  };

  for (const o of OBSTACLES) {
    if (o.height < 3) {
      continue;
    }

    consider(o.x, o.y, o.radius);
  }

  return Math.max(4, dist);
};

export class View {
  private readonly reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)") ?? null;
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly sun: THREE.DirectionalLight;
  private look = new THREE.Vector3();
  private camPos = new THREE.Vector3();
  private camYaw = 0;
  private camPitch = 0;
  private focus = new THREE.Vector3();
  private camGroundY = 0;
  private camPlaced = false;
  private scratchA = new THREE.Vector3();
  private scratchB = new THREE.Vector3();
  private scratchFwd = new THREE.Vector3();
  private shake = 0;
  private shakeT = 0;
  private shakeOff = new THREE.Vector3();
  private kickVec = new THREE.Vector3();
  private fovPunch = 0;
  private flashAmt = 0;
  private vigPunch = 0;
  private introT = -1;
  private readonly introPos = new THREE.Vector3(0, 22, 14);
  private readonly introLook = new THREE.Vector3(0, 2, 0);
  private readonly introScratch = new THREE.Vector3();
  readonly throneAura: THREE.Mesh;
  private throneColumn: THREE.Mesh<THREE.CylinderGeometry, THREE.MeshBasicMaterial> | null = null;
  /** TRAILER-ONLY bloom scale, read only by cinematic(). 1 = the game's bloom. */
  bloomScale = 1;
  private composer: EffectComposer | null = null;
  private bloom: UnrealBloomPass | null = null;
  private grade: ShaderPass | null = null;
  private fxaa: ShaderPass | null = null;
  private quality: "high" | "low" = "high";
  private prNow = Math.min(window.devicePixelRatio, 2);
  private dtAvg = 1 / 60;
  private prStep = 0;

  constructor(container: HTMLElement) {
    const coarse = "matchMedia" in window && window.matchMedia("(pointer:coarse)").matches;
    const dense = coarse && window.devicePixelRatio >= 2;
    this.renderer = new THREE.WebGLRenderer({
      antialias: !dense,
      powerPreference: "high-performance",
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, coarse ? 1.5 : 2));
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.debug.checkShaderErrors =
      import.meta.env.DEV && !new URLSearchParams(location.search).has("fastshaders");
    this.renderer.shadowMap.enabled = !coarse;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.shadowMap.autoUpdate = false;
    this.renderer.shadowMap.needsUpdate = true;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1;
    container.append(this.renderer.domElement);

    this.scene.background = new THREE.Color(0x0c_0f_18);
    this.scene.fog = new THREE.FogExp2(0x0c_0f_18, 0.015);

    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.environmentIntensity = 0.36;
    pmrem.dispose();

    const aspect = window.innerWidth / window.innerHeight;
    this.camera = new THREE.PerspectiveCamera(fovForAspect(CAM.fov, aspect), aspect, 0.5, 400);
    this.camPos.set(
      0,
      Math.sin(CAM.baseElev) * CAM.distance,
      Math.cos(CAM.baseElev) * CAM.distance,
    );
    this.camera.position.copy(this.camPos);
    this.camera.lookAt(0, 1, 0);

    this.scene.add(new THREE.HemisphereLight(0x80_98_c4, 0x24_20_1a, 0.72));
    this.scene.add(new THREE.AmbientLight(0xff_ff_ff, 0.24));
    this.sun = new THREE.DirectionalLight(0xbc_cc_ff, 1.5);
    this.sun.position.set(18, 34, 12);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    this.sun.shadow.camera.near = 1;
    this.sun.shadow.camera.far = 80;
    this.sun.shadow.radius = 4;
    const sc = this.sun.shadow.camera;
    const shadowR = HEX_R + 8;
    sc.left = -shadowR;
    sc.right = shadowR;
    sc.top = shadowR;
    sc.bottom = -shadowR;
    sc.updateProjectionMatrix();
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.05;
    this.scene.add(this.sun);
    this.scene.add(this.sun.target);

    const rim = new THREE.DirectionalLight(0x6f_8c_ff, 0.5);
    rim.position.set(-16, 10, -14);
    this.scene.add(rim);

    this.throneAura = this.buildArena();
    this.buildComposer();
    shadowRefresher = () => this.refreshShadows();
  }

  private buildArena() {
    const arenaGroup = new THREE.Group();

    const sky = new THREE.Mesh(
      new THREE.SphereGeometry(300, 32, 16),
      new THREE.ShaderMaterial({
        depthWrite: false,
        fog: false,
        fragmentShader:
          "varying vec3 vP; uniform vec3 uTop; uniform vec3 uBot;" +
          " void main(){ vec3 n = normalize(vP); float h = smoothstep(-0.1,0.5, n.y);" +
          " vec3 c = mix(uBot,uTop,h);" +
          " gl_FragColor = vec4(c,1.0); }",
        side: THREE.BackSide,
        uniforms: {
          uBot: { value: new THREE.Color(0x1a_16_26) },
          uTop: { value: new THREE.Color(0x0a_0e_1c) },
        },
        vertexShader:
          "varying vec3 vP; void main(){ vP = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }",
      }),
    );

    sky.renderOrder = -1;
    arenaGroup.add(sky);

    arenaGroup.add(buildGroundDisc());

    const plateauTop = terrainHeight(0, 0);

    const dais = new THREE.Mesh(
      new THREE.CylinderGeometry(BOSS_PLATFORM_RADIUS, BOSS_PLATFORM_RADIUS + 0.6, BOSS_HEIGHT, 32),
      new THREE.MeshStandardMaterial({ color: 0x46_41_5a, roughness: 0.85 }),
    );

    dais.position.set(ARENA.throne.x, plateauTop + BOSS_HEIGHT / 2, ARENA.throne.y);
    dais.castShadow = true;
    dais.receiveShadow = true;
    arenaGroup.add(dais);

    const aura = new THREE.Mesh(
      new THREE.RingGeometry(ARENA.throne.radius - 0.5, ARENA.throne.radius, 64),
      new THREE.MeshBasicMaterial({
        color: 0xff_cc_44,
        depthWrite: false,
        opacity: 0.5,
        side: THREE.DoubleSide,
        transparent: true,
      }),
    );

    aura.rotation.x = -Math.PI / 2;
    aura.position.y = terrainHeight(ARENA.throne.radius, 0) + 0.1;
    arenaGroup.add(aura);

    this.throneColumn = new THREE.Mesh(
      new THREE.CylinderGeometry(1.2, 2, 11, 24, 1, true),
      softLightMaterial(0xff_cc_55, 0.03),
    );
    this.throneColumn.position.set(ARENA.throne.x, plateauTop + 5.5, ARENA.throne.y);
    arenaGroup.add(this.throneColumn);

    for (const sp of SPAWNS) {
      const col = teamColor(`bot:${sp.slot}`);
      const padY = terrainHeight(sp.x, sp.y);

      const rim = new THREE.Mesh(
        new THREE.RingGeometry(4.2, 5, 40),
        new THREE.MeshBasicMaterial({
          blending: THREE.AdditiveBlending,
          color: col,
          depthWrite: false,
          opacity: 0.6,
          side: THREE.DoubleSide,
          transparent: true,
        }),
      );

      rim.rotation.x = -Math.PI / 2;
      rim.position.set(sp.x, padY + 0.18, sp.y);
      arenaGroup.add(rim);
    }

    const beaconGeos: THREE.BufferGeometry[] = [];

    for (const d of DELIVERY_PADS) {
      const pad = new THREE.Mesh(
        new THREE.RingGeometry(1.4, 1.7, 4),
        new THREE.MeshBasicMaterial({
          color: 0x66_ff_cc,
          depthWrite: false,
          opacity: 0.55,
          transparent: true,
        }),
      );

      pad.rotation.x = -Math.PI / 2;
      pad.position.set(d.x, terrainHeight(d.x, d.y) + 0.1, d.y);
      arenaGroup.add(pad);
      const cone = new THREE.ConeGeometry(0.55, 3.5, 8, 1, true);
      cone.translate(d.x, terrainHeight(d.x, d.y) + 1.75, d.y);
      beaconGeos.push(cone);
    }

    const beaconGeo = mergeGeometries(beaconGeos);

    if (beaconGeo) {
      const beacons = new THREE.Mesh(
        beaconGeo,
        new THREE.MeshBasicMaterial({
          blending: THREE.AdditiveBlending,
          color: 0x66_ff_cc,
          depthWrite: false,
          opacity: 0.05,
          side: THREE.DoubleSide,
          transparent: true,
        }),
      );

      arenaGroup.add(beacons);
    }

    for (const g of beaconGeos) {
      g.dispose();
    }

    this.scene.add(arenaGroup);

    return aura;
  }

  /** Chase the local hero from behind their facing (action-RPG). faceX/faceZ is
   *  the unit facing on the (x,z) ground plane; pitch tilts the view up/down. */
  follow(
    x: number,
    y: number,
    faceX: number,
    faceZ: number,
    pitch: number,
    dt: number,
    groundY = 0,
  ) {
    const reduced = this.reducedMotion?.matches ?? false;

    if (reduced) {
      this.resetImpulses();
    }

    if (faceX !== 0 || faceZ !== 0) {
      this.camYaw = Math.atan2(faceX, faceZ);
    }

    this.camPitch = pitch;
    const fx = Math.sin(this.camYaw);
    const fz = Math.cos(this.camYaw);

    this.camGroundY += (groundY - this.camGroundY) * Math.min(1, 6 * dt);

    this.scratchA.set(x, 0, y);

    if (this.camPlaced) {
      this.focus.lerp(this.scratchA, Math.min(1, CAM.posLerp * dt));
    } else {
      this.focus.copy(this.scratchA);
      this.camPlaced = true;
    }

    const elev = Math.max(0.12, CAM.baseElev - this.camPitch * 0.55);
    const dist = clampCamDistance(this.focus.x, this.focus.z, -fx, -fz);
    const horiz = Math.cos(elev) * dist;
    const vert = Math.max(1.4, Math.sin(elev) * dist) + this.camGroundY;
    this.camPos.set(this.focus.x - fx * horiz, vert, this.focus.z - fz * horiz);

    const camMax = APOTHEM + 0.4;
    const camR = Math.hypot(this.camPos.x, this.camPos.z);

    if (camR > camMax) {
      const s = camMax / camR;
      this.camPos.x *= s;
      this.camPos.z *= s;
    }

    const daisR = BOSS_PLATFORM_RADIUS + 1.2;

    if (camR < daisR) {
      this.camPos.y = Math.max(this.camPos.y, BOSS_HEIGHT + 2.8);
    }

    this.look.set(
      this.focus.x + fx * CAM.lookAhead,
      CAM.lookHeight + this.camPitch * 5 + this.camGroundY,
      this.focus.z + fz * CAM.lookAhead,
    );

    const s = this.stepImpulses(dt);
    this.camera.position.copy(this.camPos).add(this.shakeOff).add(this.kickVec);
    this.aimCamera(reduced, dt);
    this.camera.rotateZ(
      (Math.sin(this.shakeT * 1.3) * 0.55 + Math.sin(this.shakeT * 2.7) * 0.45) * s * 0.05,
    );
  }

  private stepImpulses(dt: number) {
    this.shake = Math.max(0, this.shake - dt * 1.6);
    this.shakeT += dt * 31;

    if (this.bloom) {
      this.bloom.strength = 0.6 + this.shake * 0.5;
    }

    this.flashAmt *= Math.max(0, 1 - 9 * dt);
    this.vigPunch *= Math.max(0, 1 - 5 * dt);
    const vig = this.grade?.uniforms["uVignette"];

    if (vig) {
      vig.value = 0.18 + this.shake * 0.25 + this.vigPunch;
    }

    const fl = this.grade?.uniforms["uFlash"];

    if (fl) {
      fl.value = this.flashAmt;
    }

    const s = this.shake * this.shake;
    this.shakeOff.set(
      (Math.random() - 0.5) * s * 1.4,
      (Math.random() - 0.5) * s * 0.8,
      (Math.random() - 0.5) * s * 1.4,
    );

    this.kickVec.multiplyScalar(Math.max(0, 1 - dt * 11));

    this.fovPunch *= Math.max(0, 1 - 7 * dt);

    if (this.fovPunch < 0.01) {
      this.fovPunch = 0;
    }

    const fovNow = fovForAspect(CAM.fov, this.camera.aspect) - this.fovPunch;

    if (Math.abs(fovNow - this.camera.fov) > 0.01) {
      this.camera.fov = fovNow;
      this.camera.updateProjectionMatrix();
    }

    return s;
  }

  private aimCamera(reduced: boolean, dt: number) {
    if (this.introT < 0) {
      this.camera.lookAt(this.look);

      return;
    }

    this.introT += dt;
    const t = Math.min(1, this.introT / INTRO_S);
    const k = t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;

    if (this.introT >= INTRO_S) {
      this.introT = -1;
    }

    if (reduced) {
      this.camera.lookAt(this.look);
    } else {
      this.camera.position.lerpVectors(this.introPos, this.camera.position, k);
      this.introScratch.lerpVectors(this.introLook, this.look, k);
      this.camera.lookAt(this.introScratch);
    }
  }

  /** TRAILER-ONLY free camera: drive the camera to an explicit pose while
   *  keeping every juice channel alive — trauma shake, directional kick, FOV
   *  punch, screen flash/vignette — the same per-frame decay block follow()
   *  runs. Gameplay never calls this; follow() remains the one gameplay path. */
  cinematic(pos: THREE.Vector3, look: THREE.Vector3, dt: number, fovBase = CAM.fov) {
    if (this.reducedMotion?.matches) {
      this.resetImpulses();
    }

    this.shake = Math.max(0, this.shake - dt * 1.6);
    this.shakeT += dt * 31;

    if (this.bloom) {
      this.bloom.strength = (0.6 + this.shake * 0.5) * this.bloomScale;
    }

    this.flashAmt *= Math.max(0, 1 - 9 * dt);
    this.vigPunch *= Math.max(0, 1 - 5 * dt);
    const vig = this.grade?.uniforms["uVignette"];

    if (vig) {
      vig.value = 0.18 + this.shake * 0.25 + this.vigPunch;
    }

    const fl = this.grade?.uniforms["uFlash"];

    if (fl) {
      fl.value = this.flashAmt;
    }

    const s = this.shake * this.shake;
    this.shakeOff.set(
      (Math.random() - 0.5) * s * 1.4,
      (Math.random() - 0.5) * s * 0.8,
      (Math.random() - 0.5) * s * 1.4,
    );
    this.kickVec.multiplyScalar(Math.max(0, 1 - dt * 11));
    this.fovPunch *= Math.max(0, 1 - 7 * dt);

    if (this.fovPunch < 0.01) {
      this.fovPunch = 0;
    }

    const fovNow = fovForAspect(fovBase, this.camera.aspect) - this.fovPunch;

    if (Math.abs(fovNow - this.camera.fov) > 0.01) {
      this.camera.fov = fovNow;
      this.camera.updateProjectionMatrix();
    }

    this.camera.position.copy(pos).add(this.shakeOff).add(this.kickVec);
    this.camera.lookAt(look);
    this.camera.rotateZ(
      (Math.sin(this.shakeT * 1.3) * 0.55 + Math.sin(this.shakeT * 2.7) * 0.45) * s * 0.05,
    );
  }

  /** Begin the 2.4s establishing fly-in (solo intro). Camera blends from a high
   *  arena-wide pose down into the chase framing; input/HUD gating is the
   *  scene's job — read `introBlend` (0→1, 1 = handed off). */
  startIntro() {
    this.introT = 0;
  }

  /** Fly-in progress 0→1. 1 when no intro is running. */
  get introBlend() {
    return this.introT < 0 ? 1 : Math.min(1, this.introT / INTRO_S);
  }

  /** Punch the FOV in by `deg` degrees (kill 4.0 / heavy hit 1.8 / your R 2.2).
   *  Decays ×(1−7dt) — a distinct "impact zoom" channel on top of the shake. */
  punchFov(deg: number) {
    if (this.reducedMotion?.matches) {
      return;
    }

    this.fovPunch = Math.max(this.fovPunch, deg);
  }

  /** Full-screen beat: whiten `flash` (0..~0.25) and/or squeeze the vignette
   *  by `vignette` — the big-ult "the screen itself reacts" channel. */
  screenPulse(flash: number, vignette = 0) {
    if (this.reducedMotion?.matches) {
      return;
    }

    this.flashAmt = Math.max(this.flashAmt, flash);
    this.vigPunch = Math.max(this.vigPunch, vignette);
  }

  /** Re-render the (static) shadow map once — call after scenery changes. */
  refreshShadows() {
    this.renderer.shadowMap.needsUpdate = true;
  }

  addTrauma(amount: number) {
    if (this.reducedMotion?.matches) {
      return;
    }

    this.shake = Math.min(1, this.shake + amount);
  }

  /** Directional camera punch toward an impact (dx,dy = sim-plane hit dir). Snaps
   *  the camera a hair toward the hit, then springs back — weight on YOUR blows. */
  kick(dx: number, dy: number, amount: number) {
    if (this.reducedMotion?.matches) {
      return;
    }

    const n = Math.hypot(dx, dy) || 1;
    this.kickVec.set((dx / n) * amount, 0, (dy / n) * amount);
  }

  /** Rematch/preference boundary: clear decorative impulses without moving the
   * chase camera, changing aim or restarting the intro's control deadline. */
  resetImpulses() {
    this.vigPunch = 0;
    this.flashAmt = 0;
    this.fovPunch = 0;
    this.shakeT = 0;
    this.shake = 0;
    this.shakeOff.set(0, 0, 0);
    this.kickVec.set(0, 0, 0);

    if (this.bloom) {
      this.bloom.strength = 0.6;
    }

    const flash = this.grade?.uniforms["uFlash"];
    const vignette = this.grade?.uniforms["uVignette"];

    if (flash) {
      flash.value = 0;
    }

    if (vignette) {
      vignette.value = 0.18;
    }
  }

  /** Pulse the throne aura + glow column. */
  tickAura(t: number) {
    const m = this.throneAura.material as THREE.MeshBasicMaterial;
    m.opacity = this.reducedMotion?.matches ? 0.35 : 0.35 + Math.sin(t * 2) * 0.15;

    if (this.throneColumn) {
      this.throneColumn.material.opacity = this.reducedMotion?.matches
        ? 0.033
        : 0.022 + Math.abs(Math.sin(t * 1.5)) * 0.022;
    }
  }

  private buildComposer() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    const coarse = "matchMedia" in window && window.matchMedia("(pointer:coarse)").matches;
    this.quality = !coarse && this.prNow >= 1.5 ? "high" : "low";

    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.bloom = new UnrealBloomPass(new THREE.Vector2(w, h), 0.6, 0.5, 0.82);
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());
    this.grade = new ShaderPass(GradeShader);
    this.composer.addPass(this.grade);

    if (this.quality === "high") {
      this.composer.addPass(new SMAAPass());
    } else {
      this.fxaa = new ShaderPass(FXAAShader);
      this.fxaa.material.uniforms["resolution"]?.value.set(
        1 / (w * this.prNow),
        1 / (h * this.prNow),
      );
      this.composer.addPass(this.fxaa);
    }

    this.composer.setPixelRatio(this.prNow);
  }

  private applyPixelRatio(pr: number) {
    this.prNow = pr;
    this.renderer.setPixelRatio(pr);
    this.composer?.setPixelRatio(pr);

    if (this.fxaa) {
      this.fxaa.material.uniforms["resolution"]?.value.set(
        1 / (window.innerWidth * pr),
        1 / (window.innerHeight * pr),
      );
    }
  }

  /** Roll a frame-time average; step the pixel ratio down if we can't hold ~55fps.
   *  Uses REAL frameDt (never the hit-stop-scaled dt). */
  samplePerf(frameDt: number) {
    this.dtAvg = this.dtAvg * 0.95 + Math.min(frameDt, 0.1) * 0.05;

    if (1 / this.dtAvg < 50 && this.prStep < 2) {
      this.prStep += 1;
      this.applyPixelRatio(Math.min(this.prStep === 1 ? 1.5 : 1.25, this.prNow));
    }
  }

  resize() {
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.camera.aspect = window.innerWidth / window.innerHeight;
    this.camera.fov = fovForAspect(CAM.fov, this.camera.aspect);
    this.camera.updateProjectionMatrix();
    this.composer?.setSize(window.innerWidth, window.innerHeight);

    if (this.fxaa) {
      this.fxaa.material.uniforms["resolution"]?.value.set(
        1 / (window.innerWidth * this.prNow),
        1 / (window.innerHeight * this.prNow),
      );
    }
  }

  /** Sim-plane (x, y) at height `h` → screen px. `h` defaults to chest height;
   *  floating damage numbers pass their own, since they arc through the air. */
  worldToScreen(x: number, y: number, h = 1.4) {
    const p = this.scratchA.set(x, h, y);
    this.camera.getWorldDirection(this.scratchFwd);
    const toP = this.scratchB.copy(p).sub(this.camera.position);

    if (toP.dot(this.scratchFwd) <= 0.1) {
      return { visible: false, x: 0, y: 0 };
    }

    p.project(this.camera);

    return {
      visible: p.z < 1,
      x: (p.x * 0.5 + 0.5) * window.innerWidth,
      y: (-p.y * 0.5 + 0.5) * window.innerHeight,
    };
  }

  render() {
    if (this.composer) {
      this.composer.render();
    } else {
      this.renderer.render(this.scene, this.camera);
    }
  }
}
