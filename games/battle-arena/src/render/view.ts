// The Three.js stage: renderer, scene, lights, the static arena built from
// data/map, and an ARPG chase camera. Reads map data — nothing hand-placed.
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
  ARENA,
  BOSS_PLATFORM_RADIUS,
  BOSS_HEIGHT,
  CAMPS,
  DELIVERY_PADS,
  HALF,
  OBSTACLES,
  SPAWNS,
} from "../data/map";
import { terrainHeight } from "../data/terrain";
import { teamColor } from "./palette";

const INTRO_S = 2.4; // establishing fly-in duration (solo intro)

// Action-RPG chase camera: sits behind the player's facing, orbiting up/down
// with the look pitch (FPS-style vertical look).
const CAM = {
  distance: 10,
  fov: 52,
  lookAhead: 6,
  lookHeight: 1.4,
  baseElev: 0.62, // default elevation angle above horizontal (≈6.4u high at dist 10)
  posLerp: 10, // how fast the follow focus eases toward the player (translation only)
};

// Final grade: gain+lift split-tone → contrast → saturation → radial vignette.
// Runs after OutputPass in display (sRGB) space — a "video" grade, easy to tune.
const GradeShader = {
  uniforms: {
    tDiffuse: { value: null },
    uContrast: { value: 1.08 },
    uSaturation: { value: 1.1 },
    uVignette: { value: 0.32 },
    uVigStart: { value: 0.58 },
    uLift: { value: new THREE.Vector3(-0.006, -0.003, 0.012) },
    uGain: { value: new THREE.Vector3(1.03, 1.01, 0.97) },
  },
  vertexShader: "varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }",
  fragmentShader: `
    uniform sampler2D tDiffuse; uniform float uContrast,uSaturation,uVignette,uVigStart; uniform vec3 uLift,uGain;
    varying vec2 vUv;
    void main(){
      vec3 c = texture2D(tDiffuse, vUv).rgb;
      c = c*uGain + uLift*(1.0-c);
      c = (c-0.5)*uContrast + 0.5;
      float l = dot(c, vec3(0.2126,0.7152,0.0722));
      c = mix(vec3(l), c, uSaturation);
      float r = length(vUv-0.5)*1.4142;
      c *= 1.0 - uVignette*smoothstep(uVigStart,1.0,r);
      gl_FragColor = vec4(clamp(c,0.0,1.0),1.0);
    }`,
};

/** Clamped hermite smoothstep (GLSL semantics, increasing edges). */
function sstep(e0: number, e1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

const GROUND_STONE = new THREE.Color(0x565b68); // readable cool dungeon stone
const GROUND_MOSS = new THREE.Color(0x44523f); // forest-invaded west (the Breach)
const GROUND_DIRT = new THREE.Color(0x4a4238); // trampled earth around camp lairs

/** Zone tint for a ground-disc vertex: moss creeps in from the west rim, dirt
 *  rings each camp lair. Pure function of position — identical on every client. */
function groundZoneColor(x: number, z: number, out: THREE.Color): THREE.Color {
  out.copy(GROUND_STONE);
  const r = Math.hypot(x, z);
  const ang = Math.atan2(z, x);
  const west = Math.abs(Math.atan2(Math.sin(ang - Math.PI), Math.cos(ang - Math.PI)));
  const mossK = (1 - sstep(0.2, 0.6, west)) * sstep(24, 32, r);
  if (mossK > 0) out.lerp(GROUND_MOSS, mossK);
  let campD2 = Infinity;
  for (const c of CAMPS) {
    const d2 = (x - c.x) ** 2 + (z - c.y) ** 2;
    if (d2 < campD2) campD2 = d2;
  }
  const dirtK = 1 - sstep(3.5, 5.5, Math.sqrt(campD2));
  if (dirtK > 0) out.lerp(GROUND_DIRT, dirtK * 0.85);
  return out;
}

/** Build the terrain-displaced ground disc — a flat stone base under the
 *  flagstone tiles (it only shows in tile gaps + the platform skirt). One mesh. */
function buildGroundDisc(): THREE.Mesh {
  const R = HALF + 3;
  const rings = 40;
  const seg = 96;
  const zc = new THREE.Color();
  groundZoneColor(0, 0, zc);
  const pos: number[] = [0, terrainHeight(0, 0), 0];
  const col: number[] = [zc.r, zc.g, zc.b];
  for (let ring = 1; ring <= rings; ring++) {
    const rr = (ring / rings) * R;
    for (let s = 0; s < seg; s++) {
      const a = (s / seg) * Math.PI * 2;
      const x = Math.cos(a) * rr;
      const z = Math.sin(a) * rr;
      pos.push(x, terrainHeight(x, z), z);
      groundZoneColor(x, z, zc);
      col.push(zc.r, zc.g, zc.b);
    }
  }
  const idx: number[] = [];
  for (let s = 0; s < seg; s++) idx.push(0, 1 + s, 1 + ((s + 1) % seg)); // center fan
  for (let ring = 0; ring < rings - 1; ring++) {
    const a0 = 1 + ring * seg;
    const a1 = 1 + (ring + 1) * seg;
    for (let s = 0; s < seg; s++) {
      const sn = (s + 1) % seg;
      idx.push(a0 + s, a1 + s, a0 + sn, a0 + sn, a1 + s, a1 + sn);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, metalness: 0, side: THREE.DoubleSide }));
  mesh.receiveShadow = true;
  return mesh;
}

export class View {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly sun: THREE.DirectionalLight;
  private look = new THREE.Vector3();
  private camPos = new THREE.Vector3();
  private camYaw = 0; // camera heading (atan2(faceX,faceZ)) — snapped 1:1 to input
  private camPitch = 0; // look pitch (>0 looks up) — snapped 1:1 to input
  private focus = new THREE.Vector3(); // eased follow point (smooths translation)
  private camGroundY = 0; // smoothed terrain height under the player
  private camPlaced = false;
  private scratchA = new THREE.Vector3();
  private scratchB = new THREE.Vector3();
  private scratchFwd = new THREE.Vector3();
  private shake = 0;
  private shakeT = 0; // rotational-shake phase clock (advances with trauma time)
  private shakeOff = new THREE.Vector3();
  private kickVec = new THREE.Vector3(); // directional camera punch (impact weight), decays to 0
  private fovPunch = 0; // degrees of punch-in (narrower FOV on big beats), decays 7/s
  // intro fly-in: startIntro() → 2.4s easeInOutCubic blend from a high establishing
  // pose down into the chase camera. -1 = inactive.
  private introT = -1;
  private readonly introPos = new THREE.Vector3(0, 22, 14);
  private readonly introLook = new THREE.Vector3(0, 2, 0);
  private readonly introScratch = new THREE.Vector3();
  readonly throneAura: THREE.Mesh;
  private throneColumn: THREE.Mesh | null = null;
  // post-processing
  private composer: EffectComposer | null = null;
  private bloom: UnrealBloomPass | null = null;
  private grade: ShaderPass | null = null;
  private fxaa: ShaderPass | null = null;
  private quality: "high" | "low" = "high";
  private prNow = Math.min(window.devicePixelRatio, 2);
  private dtAvg = 1 / 60;
  private prStep = 0; // 0=full, 1=1.5, 2=1.25 (adaptive downscale)

  constructor(container: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    // STATIC shadows: characters use blob shadows and every real caster is
    // scenery, so the shadow map renders ONCE (refreshShadows() re-arms it).
    // Touch devices skip shadows entirely — biggest single mobile win.
    const coarse = typeof window.matchMedia === "function" && window.matchMedia("(pointer:coarse)").matches;
    this.renderer.shadowMap.enabled = !coarse;
    this.renderer.shadowMap.type = THREE.PCFShadowMap; // + shadow.radius softens
    this.renderer.shadowMap.autoUpdate = false;
    this.renderer.shadowMap.needsUpdate = true;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    container.appendChild(this.renderer.domElement);

    // moody dungeon base — dim & atmospheric but the whole arena floor stays
    // readable; torches + bloom carve brighter pools.
    this.scene.background = new THREE.Color(0x0c0f18);
    this.scene.fog = new THREE.FogExp2(0x0c0f18, 0.015);

    // image-based lighting so metals (coins) and PBR surfaces aren't flat
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.environmentIntensity = 0.36;
    pmrem.dispose();

    this.camera = new THREE.PerspectiveCamera(CAM.fov, window.innerWidth / window.innerHeight, 0.5, 400);
    this.camPos.set(0, Math.sin(CAM.baseElev) * CAM.distance, Math.cos(CAM.baseElev) * CAM.distance);
    this.camera.position.copy(this.camPos);
    this.camera.lookAt(0, 1, 0);

    // torch-lit ruin: the cool wash drops so the 7 warm point-light pools carry
    // the scene. Fill stays high enough that nothing reads pure black.
    this.scene.add(new THREE.HemisphereLight(0x8098c4, 0x24201a, 0.72));
    this.scene.add(new THREE.AmbientLight(0xffffff, 0.24));
    this.sun = new THREE.DirectionalLight(0xbcccff, 1.5);
    this.sun.position.set(18, 34, 12);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    this.sun.shadow.camera.near = 1;
    this.sun.shadow.camera.far = 80;
    this.sun.shadow.radius = 4; // soft penumbra (PCFSoft)
    const sc = this.sun.shadow.camera;
    sc.left = -HALF;
    sc.right = HALF;
    sc.top = HALF;
    sc.bottom = -HALF;
    sc.updateProjectionMatrix();
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.05;
    this.scene.add(this.sun);
    this.scene.add(this.sun.target);

    const rim = new THREE.DirectionalLight(0x6f8cff, 0.5); // cool back-rim, no shadow
    rim.position.set(-16, 10, -14);
    this.scene.add(rim);

    this.throneAura = this.buildArena();
    this.buildComposer();
  }

  private buildArena(): THREE.Mesh {
    const arenaGroup = new THREE.Group();

    // gradient sky dome (so the screen edges aren't pure black and the vignette
    // + atmospheric fog have something to land on)
    const sky = new THREE.Mesh(
      new THREE.SphereGeometry(300, 32, 16),
      new THREE.ShaderMaterial({
        side: THREE.BackSide,
        depthWrite: false,
        fog: false,
        uniforms: {
          uTop: { value: new THREE.Color(0x0a0e1c) },
          uBot: { value: new THREE.Color(0x1a1626) },
          uWest: { value: new THREE.Color(0x14231c) }, // mossy Breach horizon
        },
        vertexShader: "varying vec3 vP; void main(){ vP = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }",
        fragmentShader:
          "varying vec3 vP; uniform vec3 uTop; uniform vec3 uBot; uniform vec3 uWest;" +
          " void main(){ vec3 n = normalize(vP); float h = smoothstep(-0.1,0.5, n.y);" +
          " vec3 c = mix(uBot,uTop,h);" +
          " float west = smoothstep(0.15,0.85,-n.x) * (1.0 - smoothstep(0.02,0.4,abs(n.y)));" +
          " c = mix(c, uWest, west*0.85);" +
          " gl_FragColor = vec4(c,1.0); }",
      }),
    );
    sky.renderOrder = -1;
    arenaGroup.add(sky);

    // tessellated, terrain-displaced, vertex-colored ground disc — reads the
    // hills + the zone bands (stone plaza → grass field → mossy earth berm)
    arenaGroup.add(buildGroundDisc());

    // throne dais — sits atop the raised central plateau
    const plateauTop = terrainHeight(0, 0);
    const dais = new THREE.Mesh(
      new THREE.CylinderGeometry(BOSS_PLATFORM_RADIUS, BOSS_PLATFORM_RADIUS + 0.6, BOSS_HEIGHT, 32),
      new THREE.MeshStandardMaterial({ color: 0x46415a, roughness: 0.85 }),
    );
    dais.position.set(ARENA.throne.x, plateauTop + BOSS_HEIGHT / 2, ARENA.throne.y);
    dais.castShadow = true;
    dais.receiveShadow = true;
    arenaGroup.add(dais);

    // throne aura ring (the gold/xp zone) — emissive, pulses in update(). Sits
    // at the ramp height for its radius so it hugs the plateau slope.
    const aura = new THREE.Mesh(
      new THREE.RingGeometry(ARENA.throne.radius - 0.5, ARENA.throne.radius, 64),
      new THREE.MeshBasicMaterial({ color: 0xffcc44, transparent: true, opacity: 0.5, side: THREE.DoubleSide }),
    );
    aura.rotation.x = -Math.PI / 2;
    aura.position.y = terrainHeight(ARENA.throne.radius, 0) + 0.05;
    arenaGroup.add(aura);

    // glowing column rising from the throne — makes the "magnet" readable from
    // the low chase camera across the arena
    // slim beacon over the throne itself — wide enough to read as "the magnet"
    // from across the arena, narrow enough not to curtain the sky behind the dais
    this.throneColumn = new THREE.Mesh(
      new THREE.CylinderGeometry(1.6, 2.6, 11, 24, 1, true),
      new THREE.MeshBasicMaterial({ color: 0xffcc55, transparent: true, opacity: 0.05, side: THREE.DoubleSide, depthWrite: false, blending: THREE.AdditiveBlending }),
    );
    this.throneColumn.position.set(ARENA.throne.x, plateauTop + 5.5, ARENA.throne.y);
    arenaGroup.add(this.throneColumn);

    // (cover pillars are real KayKit models — see render/environment.ts)

    // base pads (team-colored discs at the spawns)
    for (const sp of SPAWNS) {
      const pad = new THREE.Mesh(
        new THREE.CircleGeometry(3.2, 28),
        new THREE.MeshStandardMaterial({ color: teamColor(`bot:${sp.slot}`), roughness: 0.7, emissive: teamColor(`bot:${sp.slot}`), emissiveIntensity: 0.12 }),
      );
      pad.rotation.x = -Math.PI / 2;
      pad.position.set(sp.x, terrainHeight(sp.x, sp.y) + 0.03, sp.y);
      pad.receiveShadow = true;
      arenaGroup.add(pad);
    }

    // delivery pads + beacon cones (all pads merged into ONE draw call so the
    // shrines read from across the arena without costing anything)
    const beaconGeos: THREE.BufferGeometry[] = [];
    for (const d of DELIVERY_PADS) {
      const pad = new THREE.Mesh(
        new THREE.RingGeometry(1.4, 1.7, 4),
        new THREE.MeshBasicMaterial({ color: 0x66ffcc, transparent: true, opacity: 0.55 }),
      );
      pad.rotation.x = -Math.PI / 2;
      pad.position.set(d.x, terrainHeight(d.x, d.y) + 0.04, d.y);
      arenaGroup.add(pad);
      const cone = new THREE.ConeGeometry(0.55, 3.5, 8, 1, true);
      cone.translate(d.x, terrainHeight(d.x, d.y) + 1.75, d.y);
      beaconGeos.push(cone);
    }
    const beaconGeo = mergeGeometries(beaconGeos);
    if (beaconGeo) {
      const beacons = new THREE.Mesh(
        beaconGeo,
        new THREE.MeshBasicMaterial({ color: 0x66ffcc, transparent: true, opacity: 0.05, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, depthWrite: false }),
      );
      arenaGroup.add(beacons);
    }
    for (const g of beaconGeos) g.dispose();

    this.scene.add(arenaGroup);
    return aura;
  }

  /** Chase the local hero from behind their facing (action-RPG). faceX/faceZ is
   *  the unit facing on the (x,z) ground plane; pitch tilts the view up/down. */
  follow(x: number, y: number, faceX: number, faceZ: number, pitch: number, dt: number, groundY = 0): void {
    // 1:1 mouse-look: snap heading/pitch straight to the input — NO rotational
    // smoothing. Only the follow *focus* eases, so walking is steady but turning
    // is instant (rotation is computed from the snapped yaw, not an eased pos).
    if (faceX !== 0 || faceZ !== 0) this.camYaw = Math.atan2(faceX, faceZ);
    this.camPitch = pitch;
    const fx = Math.sin(this.camYaw);
    const fz = Math.cos(this.camYaw);

    // follow the terrain height under the player so it doesn't float on a slope
    this.camGroundY += (groundY - this.camGroundY) * Math.min(1, 6 * dt);

    // ease the focus point toward the player (smooths translation only)
    this.scratchA.set(x, 0, y);
    if (!this.camPlaced) {
      this.focus.copy(this.scratchA);
      this.camPlaced = true;
    } else {
      this.focus.lerp(this.scratchA, Math.min(1, CAM.posLerp * dt));
    }

    // orbit vertically by pitch: looking up lowers the camera & raises the target
    const elev = Math.max(0.12, CAM.baseElev - this.camPitch * 0.55);
    const dist = this.clampCamDistance(this.focus.x, this.focus.z, -fx, -fz);
    const horiz = Math.cos(elev) * dist;
    const vert = Math.max(1.4, Math.sin(elev) * dist) + this.camGroundY;
    this.camPos.set(this.focus.x - fx * horiz, vert, this.focus.z - fz * horiz);

    // keep the camera from sailing out past the dungeon walls at the rim
    const camR = Math.hypot(this.camPos.x, this.camPos.z);
    const maxR = HALF + 5;
    if (camR > maxR) {
      const s = maxR / camR;
      this.camPos.x *= s;
      this.camPos.z *= s;
    }

    this.look.set(this.focus.x + fx * CAM.lookAhead, CAM.lookHeight + this.camPitch * 5 + this.camGroundY, this.focus.z + fz * CAM.lookAhead);

    // trauma shake (+ a brief bloom/vignette punch on big impacts — free juice)
    this.shake = Math.max(0, this.shake - dt * 1.6);
    this.shakeT += dt * 31; // rotational-shake phase
    if (this.bloom) this.bloom.strength = 0.6 + this.shake * 0.5;
    const vig = this.grade?.uniforms["uVignette"];
    if (vig) vig.value = 0.32 + this.shake * 0.25;
    const s = this.shake * this.shake;
    this.shakeOff.set((Math.random() - 0.5) * s * 1.4, (Math.random() - 0.5) * s * 0.8, (Math.random() - 0.5) * s * 1.4);

    // directional impact kick — snaps toward the hit, springs back (game feel)
    this.kickVec.multiplyScalar(Math.max(0, 1 - dt * 11));

    // FOV punch-in (kill / heavy hit / your R) — distinct channel from the shake
    this.fovPunch *= Math.max(0, 1 - 7 * dt);
    if (this.fovPunch < 0.01) this.fovPunch = 0;
    const fovNow = CAM.fov - this.fovPunch;
    if (Math.abs(fovNow - this.camera.fov) > 0.01) {
      this.camera.fov = fovNow;
      this.camera.updateProjectionMatrix();
    }

    this.camera.position.copy(this.camPos).add(this.shakeOff).add(this.kickVec);
    if (this.introT >= 0) {
      // intro fly-in: blend pose + look from the high establishing shot into the
      // live chase values (easeInOutCubic over 2.4s), then hand off seamlessly
      this.introT += dt;
      const t = Math.min(1, this.introT / INTRO_S);
      const k = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
      if (this.introT >= INTRO_S) this.introT = -1;
      this.camera.position.lerpVectors(this.introPos, this.camera.position, k);
      this.introScratch.lerpVectors(this.introLook, this.look, k);
      this.camera.lookAt(this.introScratch);
    } else {
      this.camera.lookAt(this.look);
    }
    // rotational roll — sine mix (not white noise) reads as violence, max ≈2.9°
    this.camera.rotateZ((Math.sin(this.shakeT * 1.3) * 0.55 + Math.sin(this.shakeT * 2.7) * 0.45) * s * 0.05);
  }

  /** Begin the 2.4s establishing fly-in (solo intro). Camera blends from a high
   *  arena-wide pose down into the chase framing; input/HUD gating is the
   *  scene's job — read `introBlend` (0→1, 1 = handed off). */
  startIntro(): void {
    this.introT = 0;
  }

  /** Fly-in progress 0→1. 1 when no intro is running. */
  get introBlend(): number {
    return this.introT < 0 ? 1 : Math.min(1, this.introT / INTRO_S);
  }

  /** Punch the FOV in by `deg` degrees (kill 4.0 / heavy hit 1.8 / your R 2.2).
   *  Decays ×(1−7dt) — a distinct "impact zoom" channel on top of the shake. */
  punchFov(deg: number): void {
    this.fovPunch = Math.max(this.fovPunch, deg);
  }

  /** Re-render the (static) shadow map once — call after scenery changes. */
  refreshShadows(): void {
    this.renderer.shadowMap.needsUpdate = true;
  }

  /** Shorten the camera distance so an obstacle never sits between cam & player.
   *  (px,pz) player, (dx,dz) unit dir from player toward the camera. */
  private clampCamDistance(px: number, pz: number, dx: number, dz: number): number {
    let dist = CAM.distance;
    const consider = (ox: number, oz: number, orad: number): void => {
      const rr = orad + 0.7;
      const rx = ox - px;
      const rz = oz - pz;
      const b = rx * dx + rz * dz; // projection of obstacle onto the ray
      if (b <= 0) return; // obstacle is behind the player, not toward the camera
      const c = rx * rx + rz * rz - rr * rr;
      const disc = b * b - c;
      if (disc < 0) return; // ray misses the obstacle
      const entry = b - Math.sqrt(disc);
      if (entry > 0.5 && entry - 0.5 < dist) dist = entry - 0.5;
    };
    // only the tall cover pillars can actually block the chase cam. The throne
    // dais is a low (1.6u) platform players stand on constantly — including it
    // here (the check is 2D, ignoring height) yanked the camera to its minimum
    // whenever you contested the throne, the one place everyone fights.
    for (const o of OBSTACLES) consider(o.x, o.y, o.radius);
    return Math.max(4, dist);
  }

  addTrauma(amount: number): void {
    this.shake = Math.min(1, this.shake + amount);
  }

  /** Directional camera punch toward an impact (dx,dy = sim-plane hit dir). Snaps
   *  the camera a hair toward the hit, then springs back — weight on YOUR blows. */
  kick(dx: number, dy: number, amount: number): void {
    const n = Math.hypot(dx, dy) || 1;
    this.kickVec.set((dx / n) * amount, 0, (dy / n) * amount);
  }

  /** Pulse the throne aura + glow column. */
  tickAura(t: number): void {
    const m = this.throneAura.material as THREE.MeshBasicMaterial;
    m.opacity = 0.35 + Math.sin(t * 2) * 0.15;
    if (this.throneColumn) {
      (this.throneColumn.material as THREE.MeshBasicMaterial).opacity = 0.05 + Math.abs(Math.sin(t * 1.5)) * 0.05;
    }
  }

  /** Build the post-processing chain: Render → Bloom → Output(ACES+sRGB) →
   *  Grade(vignette/contrast/saturation) → SMAA(high)/FXAA(low). */
  private buildComposer(): void {
    const w = window.innerWidth;
    const h = window.innerHeight;
    const coarse = typeof window.matchMedia === "function" && window.matchMedia("(pointer:coarse)").matches;
    this.quality = !coarse && this.prNow >= 1.5 ? "high" : "low";

    this.composer = new EffectComposer(this.renderer); // HalfFloat HDR targets
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    // bloom in linear HDR — threshold 0.7 lets torch pools + >1 VFX cores glow
    this.bloom = new UnrealBloomPass(new THREE.Vector2(w, h), 0.6, 0.5, 0.82);
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass()); // ACES tone-map + sRGB encode
    this.grade = new ShaderPass(GradeShader);
    this.composer.addPass(this.grade);
    if (this.quality === "high") {
      this.composer.addPass(new SMAAPass());
    } else {
      this.fxaa = new ShaderPass(FXAAShader);
      this.fxaa.material.uniforms["resolution"]?.value.set(1 / (w * this.prNow), 1 / (h * this.prNow));
      this.composer.addPass(this.fxaa);
    }
    this.composer.setPixelRatio(this.prNow);
  }

  private applyPixelRatio(pr: number): void {
    this.prNow = pr;
    this.renderer.setPixelRatio(pr);
    this.composer?.setPixelRatio(pr);
    if (this.fxaa) {
      this.fxaa.material.uniforms["resolution"]?.value.set(1 / (window.innerWidth * pr), 1 / (window.innerHeight * pr));
    }
  }

  /** Roll a frame-time average; step the pixel ratio down if we can't hold ~55fps.
   *  Uses REAL frameDt (never the hit-stop-scaled dt). */
  samplePerf(frameDt: number): void {
    this.dtAvg = this.dtAvg * 0.95 + Math.min(frameDt, 0.1) * 0.05;
    if (1 / this.dtAvg < 50 && this.prStep < 2) {
      this.prStep++;
      this.applyPixelRatio(this.prStep === 1 ? Math.min(1.5, this.prNow) : 1.25);
    }
  }

  resize(): void {
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.camera.aspect = window.innerWidth / window.innerHeight;
    this.camera.updateProjectionMatrix();
    this.composer?.setSize(window.innerWidth, window.innerHeight);
    if (this.fxaa) {
      this.fxaa.material.uniforms["resolution"]?.value.set(1 / (window.innerWidth * this.prNow), 1 / (window.innerHeight * this.prNow));
    }
  }

  /** sim → screen for HUD markers. Rejects points behind the camera (which the
   *  perspective divide would otherwise mirror to a wrong on-screen position). */
  worldToScreen(x: number, y: number): { x: number; y: number; visible: boolean } {
    const p = this.scratchA.set(x, 1.4, y);
    this.camera.getWorldDirection(this.scratchFwd);
    const toP = this.scratchB.copy(p).sub(this.camera.position);
    if (toP.dot(this.scratchFwd) <= 0.1) return { x: 0, y: 0, visible: false };
    p.project(this.camera);
    return {
      x: (p.x * 0.5 + 0.5) * window.innerWidth,
      y: (-p.y * 0.5 + 0.5) * window.innerHeight,
      visible: p.z < 1,
    };
  }

  render(): void {
    if (this.composer) this.composer.render();
    else this.renderer.render(this.scene, this.camera);
  }
}
