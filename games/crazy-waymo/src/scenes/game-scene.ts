import * as THREE from "three";
import { notifyGameStarted, watchControlContext } from "@repo/embed";
import { Sky } from "three/addons/objects/Sky.js";

import { ModelCache } from "../assets/loader";
import { bannerControls } from "../controls";
import type { AmbientLife } from "../fx/ambient-life";
import { ChaseCamera } from "../fx/camera-rig";
import { SkyClouds } from "../fx/clouds";
import type { SmashCones } from "../fx/cones";
import type { Debris } from "../fx/debris";
import type { LampGlow } from "../fx/lamp-glow";
import type { NightWindows } from "../fx/night-windows";
import { Fx } from "../fx/particles";
import { Sfx } from "../fx/sfx";
import { SignalLights } from "../fx/signal-lights";
import type { SkidMarks } from "../fx/skids";
import { SpeedLines } from "../fx/speedlines";
import { VehicleFxRig } from "../fx/vehicle-fx";
import { Shockwaves } from "../fx/trails";
import type { DriftTrails } from "../fx/trails";
import {
  type FareEvent,
  type FareManager,
  GROUND_RING_LIFT,
  tierColor,
  tierPayMult,
} from "../game/fares";
import { GameState } from "../game/state";
import type { ParkedCars } from "../game/parked-cars";
import { Traffic } from "../game/traffic";
import { InputState } from "../input/keyboard";
import { NetSession } from "../net/session";
import { readTransform, type RemoteCars } from "../net/remote-cars";
import type { PhysicsWorld } from "../physics/physics-world";
import { DayNight } from "../render/day-night";
import { FULL_QUALITY, isCoarsePointer, type QualityFeatures } from "../render/quality";
import {
  CAMERA,
  CAR,
  FARE,
  GRID_X,
  GRID_Z,
  MP_MAX_PLAYERS,
  MP_ROOM,
  MPH_FACTOR,
  NET_TICK_HZ,
  OFFLINE_FALLBACK_MS,
  WORLD_H,
  WORLD_W,
} from "../shared/constants";
import type { GameMode } from "../shared/types";
import { GaragePreview } from "../ui/garage-preview";
import { Hud } from "../ui/hud";
import type { Minimap, MinimapMarker } from "../ui/minimap";
import { setTouchPlaying, setupTouch, type TouchControls } from "../ui/touch";
import type { Car } from "../vehicle/car";
import type { CityModel, Garage } from "../world/city";
import { HECKLES, SpeechBubbles } from "../fx/speech-bubbles";
import { ROBOTAXI_SKINS, skinById } from "../vehicle/car";
import { districtAt, landFactor } from "../world/sf-map";
import type { SolidIndex } from "../world/solid-index";
import { loadWorld, type WorldCoreSystems, type WorldSpawn } from "./world-loader";

const HALF_PI = Math.PI / 2;

// Shore texture for the ocean shader: landFactor (the same pure mask the
// terrain samples) baked over the map + margin. R8 bilinear — the fragment
// shader turns it into the shallow ramp and the lapping foam band.
const SHORE_TEX_N = 256;
const SHORE_SPAN = 1.12; // fraction of the map span the texture covers
function buildShoreTexture(): THREE.DataTexture {
  const n = SHORE_TEX_N;
  const data = new Uint8Array(n * n);
  for (let iz = 0; iz < n; iz++) {
    const v = (iz / (n - 1) - 0.5) * SHORE_SPAN + 0.5;
    for (let ix = 0; ix < n; ix++) {
      const u = (ix / (n - 1) - 0.5) * SHORE_SPAN + 0.5;
      data[iz * n + ix] = Math.round(THREE.MathUtils.clamp(landFactor(u, v), 0, 1) * 255);
    }
  }
  const tex = new THREE.DataTexture(data, n, n, THREE.RedFormat, THREE.UnsignedByteType);
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  return tex;
}
// Initial sun direction — the DayNight cycle takes over from the first frame.
const SUN_DIR = new THREE.Vector3().setFromSphericalCoords(
  1,
  THREE.MathUtils.degToRad(90 - 32),
  THREE.MathUtils.degToRad(150),
);
// Sum of the taxi and a car's collision half-extents — the centre distance at
// which their bodies touch. The punt fires predictively at this range (plus the
// ground the taxi covers this frame) so the car goes DYNAMIC before Rapier
// resolves the overlap, instead of the taxi ramming a still-kinematic wall.
const CONTACT_R = 2.6;
const NEAR_MISS_MIN = 2.8; // above the contact zone so a hit isn't also a "near miss"
const NEAR_MISS_MAX = 4.6;
const NEAR_MISS_SPEED = 22;
const CRASH_THRESHOLD = 7;
const COUNTDOWN_STEP = 0.45; // seconds per 3-2-1 beat
const BEST_KEY = "crazy-waymo:best";
const SOUND_KEY = "crazy-waymo:sound";
const HINT_DRIFT_KEY = "crazy-waymo:hint-drift";
const HINT_BOOST_KEY = "crazy-waymo:hint-boost";

// Mobile quality knobs (tier-independent; the tiered ones live in quality.ts).
const LAMP_GLOW_BUDGET = { cap: 150, poolScale: 0.75 } as const;
const HUD_HZ = 30; // mobile HUD/minimap redraw rate (desktop stays per-frame)
// Re-bake the mobile sky when the day-night phase drifts this far past the
// baked snapshot (~40-60s of wall time; the phase moves ~1.4-2.8e-5/s).
const SKY_REBAKE_PHASE = 8e-4;
const SKY_BAKE_SIZE = 256;

// tierColor() → CSS hex, memoized — the minimap builds these per marker per
// frame and the strings never change.
const TIER_HEX = new Map<string, string>();
function tierHex(tier: Parameters<typeof tierColor>[0]): string {
  const hit = TIER_HEX.get(tier);
  if (hit !== undefined) return hit;
  const s = `#${tierColor(tier).toString(16).padStart(6, "0")}`;
  TIER_HEX.set(tier, s);
  return s;
}

// Arcade license classes; give the score a name and a next target.
const RANKS: readonly { min: number; rank: string }[] = [
  { min: 12000, rank: "S" },
  { min: 8000, rank: "A" },
  { min: 5000, rank: "B" },
  { min: 3000, rank: "C" },
  { min: 1500, rank: "D" },
  { min: 0, rank: "E" },
];

function rankFor(score: number): { rank: string; next: string | null; nextAt: number } {
  for (let i = 0; i < RANKS.length; i++) {
    const r = RANKS[i];
    if (r && score >= r.min) {
      const above = RANKS[i - 1];
      return { rank: r.rank, next: above ? above.rank : null, nextAt: above ? above.min : 0 };
    }
  }
  return { rank: "E", next: "D", nextAt: 1500 };
}

// localStorage throws in some embeds (sandboxed iframes, blocked cookies,
// private modes). The game must boot and run without persistence.
function storageGet(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}
function storageSet(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Blocked store just loses persistence — never the run.
  }
}

function readBest(): number {
  const raw = storageGet(BEST_KEY);
  const n = raw === null ? 0 : Number(raw);
  return Number.isFinite(n) ? n : 0;
}

export class GameScene {
  readonly scene = new THREE.Scene();
  // Coarse primary pointer = phone/tablet: mobile-only budgets apply.
  // (Declared first: later field initializers read it.)
  private readonly mobileUi = isCoarsePointer();
  private rig: ChaseCamera;
  private cache = new ModelCache();
  private input = new InputState();
  private hud = new Hud(this.mobileUi);
  private fx = new Fx();
  private sfx = new Sfx();
  private state = new GameState();

  // Multiplayer: free-roam presence over the shared (fixed-seed) city. Connects
  // as soon as the scene exists; falls back to solo if the party server is
  // unreachable. Only the local car transform is broadcast — no shared scoring.
  private net = new NetSession({
    room: MP_ROOM,
    maxPlayers: MP_MAX_PLAYERS,
    fallbackMs: OFFLINE_FALLBACK_MS,
  });
  private remoteCars: RemoteCars | null = null;
  private bubbles = new SpeechBubbles();
  private heckleCooldown = 0;
  private skinId = "waymo";
  private chatText = "";
  private chatAt = 0;
  private chatEl: HTMLInputElement | null = null;
  private garagePillar: THREE.Mesh | null = null;
  private garageRings: THREE.Group | null = null;
  private garageOpen = false;
  private garageEl: HTMLDivElement | null = null;
  private garagePreview: GaragePreview | null = null;
  private ownedSkins = new Set<string>(["waymo"]);
  private netAcc = 0;
  private netInfoEl = document.getElementById("netinfo");

  private city: CityModel | null = null;
  private car: Car | null = null;
  private fares: FareManager | null = null;
  private traffic: Traffic | null = null;
  private signalLights: SignalLights | null = null;
  private skids: SkidMarks | null = null;
  private debris: Debris | null = null;
  private speedLines = new SpeedLines();
  private clouds = new SkyClouds(this.mobileUi);
  private trails: DriftTrails | null = null;
  private vehicleFx = new VehicleFxRig(
    this.fx,
    () => this.trails,
    () => this.skids,
  );
  private shocks = new Shockwaves();
  private oceanTime = { value: 0 };
  private dayNight: DayNight;
  private lampGlow: LampGlow | null = null;
  private nightWindows: NightWindows | null = null;
  private cones: SmashCones | null = null;
  private parked: ParkedCars | null = null;
  private minimap: Minimap | null = null;
  private ambient: AmbientLife | null = null;
  private sceneFog: THREE.Fog;

  private sun = new THREE.DirectionalLight(0xfff2d8, 2.0);
  private sky: Sky;
  // Feature tier pushed by the perf governor; desktop never leaves FULL.
  private quality: QualityFeatures = FULL_QUALITY;
  private renderer: THREE.WebGLRenderer | null = null;
  // Mobile sky bake: the Sky dome rendered once into a small cube RT.
  private skyBakeRT: THREE.WebGLCubeRenderTarget | null = null;
  private skyBakeCam: THREE.CubeCamera | null = null;
  private skyBakedPhase = -1; // <0 = no bake yet
  private hudAcc = 0; // accumulated dt since the last HUD/minimap redraw
  private readonly mmMarkers: MinimapMarker[] = [];
  // Scratch for the shadow-texel snap (no per-frame allocation).
  private scrSnapDir = new THREE.Vector3();
  private scrSnapRight = new THREE.Vector3();
  private scrSnapUp = new THREE.Vector3();
  private scrSnapAnchor = new THREE.Vector3();
  private mode: GameMode = { kind: "loading", progress: 0 };
  ready: Promise<void> = Promise.resolve();
  // What the start CTA shows while the city finishes behind the title.
  private finishStage = "DOWNLOADING THE CITY…";
  get isReady(): boolean {
    return this.loadDone;
  }

  // ---- wrapper pause -----------------------------------------------------
  // Solo game, no wall-clock gameplay timers (fares/score/patience are all
  // dt-driven — see GameState.update/FareManager) — a full freeze is safe.
  private paused = false;

  /** Wrapper asked us to pause: skip update() entirely (sim + physics both
   *  gate on it) and kill the continuous engine/screech/scrape/boost loops
   *  so nothing drones on under the overlay. */
  requestPause(): void {
    this.paused = true;
    this.sfx.stopEngine();
    this.sfx.setScreech(0, 1);
    this.sfx.setScrape(false);
    this.sfx.setBoostLoop(false);
    // Music droning under the PAUSED overlay defeats the pause. Only playing
    // runs have it on (start()/endRun own it) — remember, so resume restarts
    // it only when we were the ones to stop it.
    this.musicPausedByWrapper = this.mode.kind === "playing";
    if (this.musicPausedByWrapper) this.sfx.stopMusic();
  }

  /** Wrapper resume: update() picks the loops back up on its own next frame. */
  requestResume(): void {
    this.paused = false;
    if (this.musicPausedByWrapper) {
      this.musicPausedByWrapper = false;
      this.sfx.startMusic();
    }
  }
  private musicPausedByWrapper = false;
  // Editor: live street rebuild — regenerate roads in-place and respawn
  // traffic on the new network. No reload.
  rebuildStreets(): void {
    const city = this.city;
    if (!city) return;
    city.rebuildStreetsLive(this.scene);
    if (this.traffic) {
      this.scene.remove(this.traffic.group);
      this.traffic.dispose();
      this.traffic = null;
    }
    if (this.physics) {
      this.traffic = new Traffic(
        this.cache,
        city,
        { avoid: { gx: this.spawn.gx, gz: this.spawn.gz }, avoidR: 4 },
        this.physics,
      );
      this.scene.add(this.traffic.group);
    }
    this.rebuildSignalLights();
  }

  // Live signal lamps ride the baked poles: rebuilt whenever the network (or
  // Traffic) changes so lamp state and traffic behavior share one cycle.
  private rebuildSignalLights(): void {
    if (this.signalLights) {
      this.scene.remove(this.signalLights.mesh);
      this.signalLights.dispose();
      this.signalLights = null;
    }
    const city = this.city;
    if (!city) return;
    this.signalLights = new SignalLights(city.network, (x, z) => city.terrain.heightAt(x, z));
    this.scene.add(this.signalLights.mesh);
  }

  // Editor: freeze daylight and push the fog out so the whole map is visible.
  editorLighting = false;
  enableEditorLighting(): void {
    this.editorLighting = true;
    this.dayNight.setPhase(0.25);
  }
  private loadDone = false;
  private pendingStart = false;
  // Touch-capable device: on-screen buttons show and CTA copy says TAP.
  private touchUi = false;
  private touch: TouchControls | null = null;
  private titleT = 0;
  private lowBeepAt = -1;
  private flameAccum = 0;
  private scrapeFrames = 0;
  private wasBoosting = false;
  private lastDriftTier: 0 | 1 | 2 = 0;
  private outro = -1; // >=0: slow-mo time-up sting is running
  private countdownShown = -1;
  private camFrom = new THREE.Vector3();
  private hintDriftShown = storageGet(HINT_DRIFT_KEY) !== null;
  private hintBoostShown = storageGet(HINT_BOOST_KEY) !== null;
  private turnHold = 0;
  // Static city solids only (grid-indexed) — traffic contact is handled by the
  // physics punt path (the taxi shoves cars instead of bouncing off them).
  private solidIndex: SolidIndex | null = null;
  private physics: PhysicsWorld | null = null;
  private hitStop = 0; // brief sim freeze for crash impact
  private spawn: WorldSpawn = { x: 0, z: 0, yaw: 0, gx: 0, gz: 0 };
  private lastDistrict = "";
  private scrArrow = new THREE.Vector3();
  // When true (set by DEV debug hooks only) the game stops driving the camera,
  // so an external tool can park it anywhere for inspection.
  freecam = false;

  constructor(aspect: number) {
    this.rig = new ChaseCamera(aspect);

    // Plugging in / unplugging a pad changes which control hints apply — the
    // title banner is the only live instruction surface, so redraw it.
    watchControlContext(() => {
      if (this.mode.kind === "title") this.toTitle();
    });

    // Atmospheric sky + sun.
    const sky = new Sky();
    sky.scale.setScalar(12000);
    const su = sky.material.uniforms;
    const setU = (name: string, value: number): void => {
      const u = su[name];
      if (u) u.value = value;
    };
    // Low turbidity = the deep saturated zenith blue (hazy 8 read washed-out
    // beige at noon); mie kept small so the sun halo stays tight.
    setU("turbidity", 2.5);
    setU("rayleigh", 1.1);
    setU("mieCoefficient", 0.003);
    setU("mieDirectionalG", 0.85);
    const sunU = su.sunPosition;
    if (sunU && sunU.value instanceof THREE.Vector3) sunU.value.copy(SUN_DIR);
    this.scene.add(sky);
    this.sky = sky;

    // Draw-distance fog: the map is far larger than the view, so haze the
    // horizon well inside the camera far plane (2000). Doubles as the visual cue
    // for the chunk draw-distance cull.
    const fog = new THREE.Fog(0xbcd7ea, 420, 960);
    this.scene.fog = fog;
    this.sceneFog = fog;

    const hemi = new THREE.HemisphereLight(0xbfe0ff, 0x4a4a3e, 0.35);
    this.scene.add(hemi);
    const ambient = new THREE.AmbientLight(0xffffff, 0.08);
    this.scene.add(ambient);

    this.sun.position.copy(SUN_DIR).multiplyScalar(90);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    this.sun.shadow.camera.near = 1;
    this.sun.shadow.camera.far = 260;
    const sc = this.sun.shadow.camera;
    sc.left = -58;
    sc.right = 58;
    sc.top = 58;
    sc.bottom = -58;
    sc.updateProjectionMatrix();
    this.sun.shadow.bias = -0.0005;
    this.sun.shadow.normalBias = 0.04;
    this.scene.add(this.sun);
    this.scene.add(this.sun.target);

    // Ocean surrounding the island (reflects the sky via scene.environment).
    // Two scrolling sine fields perturb the normal so the sky reflection
    // shimmers — reads as swell without any extra geometry. On top of that,
    // the Mario Kart water grammar: a shore texture (the same pure landFactor
    // mask terrain uses) drives a turquoise shallow ramp and an animated
    // lapping foam band along every coast, and rare sine-field crossings pop
    // as moving sun glints. All fragment work — the plane stays one quad.
    const oceanMat = new THREE.MeshStandardMaterial({
      color: 0x2e7fc0,
      roughness: 0.32,
      metalness: 0.3,
    });
    const oceanTime = this.oceanTime;
    const shoreTex = buildShoreTexture();
    const spanX = (WORLD_W * SHORE_SPAN).toFixed(1);
    const spanZ = (WORLD_H * SHORE_SPAN).toFixed(1);
    oceanMat.onBeforeCompile = (shader) => {
      shader.uniforms.uOceanTime = oceanTime;
      shader.uniforms.uShore = { value: shoreTex };
      shader.vertexShader = shader.vertexShader
        .replace("#include <common>", "#include <common>\nvarying vec3 vOceanPos;")
        .replace(
          "#include <begin_vertex>",
          "#include <begin_vertex>\nvOceanPos = (modelMatrix * vec4(transformed, 1.0)).xyz;",
        );
      shader.fragmentShader = shader.fragmentShader
        .replace(
          "#include <common>",
          `#include <common>
uniform float uOceanTime;
uniform sampler2D uShore;
varying vec3 vOceanPos;
float ocHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float ocNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = p - i;
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(ocHash(i), ocHash(i + vec2(1.0, 0.0)), u.x),
    mix(ocHash(i + vec2(0.0, 1.0)), ocHash(i + vec2(1.0, 1.0)), u.x),
    u.y);
}`,
        )
        .replace(
          "#include <normal_fragment_begin>",
          `#include <normal_fragment_begin>
          {
            vec2 wp = vOceanPos.xz;
            float t = uOceanTime;
            float nx = sin(wp.x * 0.115 + t * 1.3) * 0.5
                     + sin(wp.x * 0.041 + wp.y * 0.053 - t * 0.62) * 0.5;
            float nz = sin(wp.y * 0.093 - t * 1.05) * 0.5
                     + sin((wp.x + wp.y) * 0.035 + t * 0.84) * 0.5;
            normal = normalize(normal + vec3(nx, 0.0, nz) * 0.2);
          }`,
        )
        .replace(
          "#include <color_fragment>",
          `#include <color_fragment>
          {
            vec2 wp = vOceanPos.xz;
            float t = uOceanTime;
            vec2 suv = vec2(wp.x / ${spanX} + 0.5, wp.y / ${spanZ} + 0.5);
            float s = texture2D(uShore, suv).r;
            // Fade the shore treatment at the texture border: beyond it the
            // clamped edge would smear land values (the map's south edge is
            // land) across open ocean.
            float inMap = 1.0 - smoothstep(0.46, 0.5, max(abs(suv.x - 0.5), abs(suv.y - 0.5)));
            s *= inMap;
            // Deep-water grade: open ocean darkens toward navy, with slow
            // drifting swell patches so it never reads as one flat fill.
            float deep = 1.0 - smoothstep(0.0, 0.25, s);
            diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.085, 0.23, 0.42), deep * 0.55);
            float swell = ocNoise(wp * 0.011 + vec2(t * 0.016, -t * 0.011))
                        + ocNoise(wp * 0.034 - vec2(t * 0.022, t * 0.017)) * 0.5;
            diffuseColor.rgb *= 1.0 + (swell / 1.5 - 0.5) * 0.10;
            // Shallow-water turquoise ramp toward the coast.
            float shallow = smoothstep(0.10, 0.44, s);
            diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.36, 0.78, 0.72), shallow * 0.75);
            // Lapping foam: an animated band just off the waterline plus a
            // solid white line hugging it. The visible waterline sits near
            // s ≈ 0.40 (terrain crosses the ocean plane there), so both bands
            // live below that, not at the land-mask 0.5 edge.
            float lap = 0.5 + 0.5 * sin(t * 1.7 + (wp.x + wp.y) * 0.16 + s * 30.0);
            float foam = smoothstep(0.26, 0.38, s) * (0.30 + 0.45 * lap);
            foam += smoothstep(0.36, 0.42, s) * 0.9;
            // Sun glints: HASH twinkles — sparse random cells that flicker in
            // and out. (The old sine-product crossings landed on a visible
            // regular lattice: the "grid of white dots" read.)
            vec2 gcell = floor(wp * 0.42);
            float seed = ocHash(gcell);
            float tw = fract(seed * 7.13 + t * (0.10 + seed * 0.14));
            float glint = smoothstep(0.965, 0.995, seed) * smoothstep(0.30, 0.5, tw) * smoothstep(0.7, 0.5, tw);
            // Sub-cell jitter so lit cells read as points, not squares.
            vec2 sub = fract(wp * 0.42) - vec2(ocHash(gcell + 19.7), ocHash(gcell + 7.3));
            glint *= smoothstep(0.30, 0.08, length(sub));
            diffuseColor.rgb += vec3(glint * 3.2);
            diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.93, 0.97, 0.98), clamp(foam, 0.0, 0.9));
          }`,
        );
    };
    const ocean = new THREE.Mesh(new THREE.PlaneGeometry(9000, 9000), oceanMat);
    ocean.rotation.x = -HALF_PI;
    ocean.position.y = -0.5;
    this.scene.add(ocean);

    this.fx.addTo(this.scene);
    this.scene.add(this.speedLines.object3D);
    this.scene.add(this.clouds.group);
    this.scene.add(this.shocks.group);

    // Day-night cycle owns every light-related knob from the first frame.
    this.dayNight = new DayNight({
      sky: this.sky,
      sun: this.sun,
      hemi,
      ambient,
      fog,
      scene: this.scene,
    });
    this.touch = setupTouch(this.input, () => {
      if (this.mode.kind === "playing") this.openChat();
    });
    this.touchUi = this.touch.isTouch;
    this.hud.onCta(() => this.handleStartPress());
    // Muted by default; returning players who opted into sound stay unmuted.
    // M is the one toggle.
    this.sfx.setMuted(storageGet(SOUND_KEY) !== "1");
  }

  get camera(): THREE.PerspectiveCamera {
    return this.rig.camera;
  }

  // The shadow light — the perf governor steps its map size with quality tier.
  get sunLight(): THREE.DirectionalLight {
    return this.sun;
  }

  // Day-night shadow ramp state — the governor's cadenced shadow pass reads it.
  get shadowsOn(): boolean {
    return this.dayNight.shadowsActive;
  }

  // Governor-pushed feature tier. Desktop always receives FULL_QUALITY, so
  // every branch below is a no-op there; mobile tiers trade the per-fragment
  // heavy features for frame rate.
  applyQuality(q: QualityFeatures): void {
    const prev = this.quality;
    this.quality = q;
    const r = this.renderer;
    if (r) {
      if (this.sun.castShadow !== q.shadowCast) {
        this.sun.castShadow = q.shadowCast;
        // Coming back from the shadowless floor: refresh the (stale) map.
        if (q.shadowCast) r.shadowMap.needsUpdate = true;
      }
      if (q.shadowCast && q.shadowEvery <= 1 && prev.shadowEvery > 1) {
        // Leaving cadence mode: hand the pass back to the day-night
        // controller's model (on while shadows show, off at night — but never
        // parked before the first depth map exists).
        r.shadowMap.autoUpdate = this.dayNight.shadowsActive || !this.sun.shadow.map;
        r.shadowMap.needsUpdate = true;
      }
    }
    this.clouds.setQuality(q.clouds);
    if (!q.skyBake && prev.skyBake) {
      this.dayNight.setBakedBackground(null); // live dome returns
      this.skyBakedPhase = -1;
    }
    // (The bake itself happens lazily in update() at the re-bake cadence.)
  }

  // Used by the map editor (?editor=1) and DEV hooks.
  getCity(): CityModel | null {
    return this.city;
  }
  getCache(): ModelCache {
    return this.cache;
  }

  // Environment map for PBR fill + ocean/glass/paint sheen: a tiny BOUNDED
  // LDR gradient cubemap, deliberately NOT a PMREM bake of the physical Sky.
  // The Sky's sun disc emits radiance beyond float16 range, and on
  // GLES-class drivers (Android phones, SwiftShader) the PMREM mip chain
  // overflows to Inf/NaN — and a NaN environment poisons EVERY lit material
  // to pure black (found by bisect: env present = black city, env removed =
  // lit city; Metal-backed desktop GL tolerates it, which is why desktop
  // looked fine). 8-bit source texels cannot overflow anywhere. The
  // day-night cycle keeps modulating intensity via environmentIntensity.
  applyEnvironment(renderer: THREE.WebGLRenderer): void {
    const face = (top: string, mid: string, bottom: string): HTMLCanvasElement => {
      const c = document.createElement("canvas");
      c.width = 16;
      c.height = 16;
      const g = c.getContext("2d");
      if (g) {
        const grad = g.createLinearGradient(0, 0, 0, 16);
        grad.addColorStop(0, top);
        grad.addColorStop(0.55, mid);
        grad.addColorStop(1, bottom);
        g.fillStyle = grad;
        g.fillRect(0, 0, 16, 16);
      }
      return c;
    };
    const SKY_TOP = "#7fb2e0";
    const HORIZON = "#dde6ea";
    const GROUND = "#55534a";
    const side = (): HTMLCanvasElement => face(SKY_TOP, HORIZON, GROUND);
    // Face order: +x, -x, +y, -y, +z, -z — sides run zenith→ground.
    const cube = new THREE.CubeTexture([
      side(),
      side(),
      face(SKY_TOP, SKY_TOP, SKY_TOP),
      face(GROUND, GROUND, GROUND),
      side(),
      side(),
    ]);
    cube.colorSpace = THREE.SRGBColorSpace;
    cube.needsUpdate = true;
    this.scene.environment = cube;
    this.scene.environmentIntensity = 0.32; // keep the fill subtle
    this.dayNight.attachRenderer(renderer);
    this.renderer = renderer;
  }

  // Mobile tiers: the Sky addon shades Rayleigh/Mie per fragment every frame
  // for a sun that moves ~1e-5 phase/s. Bake it into a small cube texture and
  // re-bake only when the phase actually drifts — the PMREM environment bake
  // above proves the pattern; full night keeps its flat-color swap.
  private maybeBakeSky(): void {
    if (!this.quality.skyBake) return;
    const r = this.renderer;
    if (!r) return;
    const p = this.dayNight.getPhase();
    if (this.skyBakedPhase >= 0) {
      const d = Math.abs(p - this.skyBakedPhase);
      if (Math.min(d, 1 - d) < SKY_REBAKE_PHASE) return;
    }
    let rt = this.skyBakeRT;
    let cam = this.skyBakeCam;
    if (!rt || !cam) {
      // HalfFloat keeps the sky HDR so the on-screen tone mapping treats the
      // baked background exactly like it treated the live dome.
      rt = new THREE.WebGLCubeRenderTarget(SKY_BAKE_SIZE, {
        type: THREE.HalfFloatType,
        generateMipmaps: false,
        minFilter: THREE.LinearFilter,
        magFilter: THREE.LinearFilter,
      });
      cam = new THREE.CubeCamera(1, 20000, rt);
      this.skyBakeRT = rt;
      this.skyBakeCam = cam;
    }
    const wasVisible = this.sky.visible;
    const tone = r.toneMapping;
    r.toneMapping = THREE.NoToneMapping; // bake linear; tone-map on screen
    this.sky.visible = true;
    const tmp = new THREE.Scene();
    tmp.add(this.sky);
    cam.position.set(0, 0, 0);
    cam.update(r, tmp);
    this.scene.add(this.sky); // move the dome back into the live scene
    this.sky.visible = wasVisible;
    r.toneMapping = tone;
    this.skyBakedPhase = p;
    this.dayNight.setBakedBackground(rt.texture);
  }

  async load(): Promise<void> {
    const loaded = await loadWorld({
      scene: this.scene,
      cache: this.cache,
      sceneFog: this.sceneFog,
      lampGlowBudget: this.mobileUi ? LAMP_GLOW_BUDGET : null,
      setLoading: (progress) => {
        this.mode = { kind: "loading", progress };
        this.hud.setLoading(progress);
      },
      hideLoading: () => this.hud.hideLoading(),
      showTitle: () => this.toTitle(),
      setStage: (label) => this.setFinishStage(label),
      computeSpawn: (city) => this.computeSpawn(city),
      snapToCar: (car) => this.rig.snapTo(car),
      setupGarages: (city) => this.setupGarages(city),
      remoteSay: (anchor, text) => this.bubbles.say(anchor, text, { lift: 3.0 }),
      getRenderer: () => this.renderer,
      getCamera: () => this.rig.camera,
      onCoreSystems: (systems) => this.assignCoreSystems(systems),
      onRemoteCars: (remoteCars) => {
        this.remoteCars = remoteCars;
        this.scene.add(this.bubbles.group);
      },
      onPhysics: (physics) => {
        this.physics = physics;
      },
      onTraffic: (traffic) => {
        this.traffic = traffic;
        this.rebuildSignalLights();
      },
      onParked: (parked) => {
        this.parked = parked;
      },
      onDebris: (debris) => {
        this.debris = debris;
      },
      onCones: (cones) => {
        this.cones = cones;
      },
      onAmbient: (ambient) => {
        this.ambient = ambient;
      },
      onPlayable: () => this.markLoadDone(),
    });
    this.city = loaded.city;
    this.spawn = loaded.spawn;
    this.skinId = loaded.skinId;
    this.car = loaded.car;
    this.ready = loaded.ready;
  }

  // Impatient players see live status on the CTA they already tapped.
  private setFinishStage(label: string): void {
    this.finishStage = label;
    if (this.pendingStart && !this.loadDone) this.hud.setCta(label);
  }

  private assignCoreSystems(systems: WorldCoreSystems): void {
    this.solidIndex = systems.solidIndex;
    this.fares = systems.fares;
    this.skids = systems.skids;
    this.trails = systems.trails;
    this.lampGlow = systems.lampGlow;
    this.nightWindows = systems.nightWindows;
    this.minimap = systems.minimap;
  }

  private markLoadDone(): void {
    this.loadDone = true;
    if (this.pendingStart) {
      this.pendingStart = false;
      this.start();
    }
  }

  resize(aspect: number, scalePx: number): void {
    this.rig.resize(aspect);
    this.fx.setScale(scalePx);
  }

  private toTitle(): void {
    this.mode = { kind: "title" };
    setTouchPlaying(false);
    this.minimap?.setVisible(false);
    this.hud.hideFareCard();
    this.hud.setArrow(false, 0, 0, 0);
    this.hud.setTimer(FARE.startTime, false);
    this.hud.setVignette(0);
    this.hud.setCombo(1, 0);
    const best = readBest();
    this.hud.setLanding(true);
    this.hud.showBanner({
      title: "CRAZY WAYMO",
      sub: "Pick up fares, beat the clock, drive like a maniac.",
      stats:
        best > 0 ? `BEST $${best.toLocaleString("en-US")}` : "Every drop-off buys you more time.",
      // Just the verbs (the manifest drops "mute" here). Drift, restart and
      // chat are left to be discovered.
      controls: bannerControls(),
      cta: this.touchUi ? "START DRIVING" : "START DRIVING ⏎",
    });
  }

  // --- Garages: drive onto the pad to swap robotaxis ---
  private setupGarages(city: CityModel): void {
    this.hud.setOperator(skinById(this.skinId).label, skinById(this.skinId).accent);
    try {
      const raw = storageGet("crazy-waymo:skins-owned");
      if (raw) for (const id of JSON.parse(raw) as string[]) this.ownedSkins.add(id);
    } catch {
      // corrupt storage — start with the default fleet
    }
    // Drive-in pads: a flat glowing ring on each garage forecourt.
    const rings = new THREE.Group();
    const ringGeo = new THREE.RingGeometry(4.4, 5.4, 28).rotateX(-Math.PI / 2);
    const ringMat = new THREE.MeshBasicMaterial({
      color: 0xffa63d,
      transparent: true,
      opacity: 0.55,
      depthWrite: false,
    });
    for (const g of city.garages) {
      const ring = new THREE.Mesh(ringGeo, ringMat);
      ring.position.set(g.padX, city.heightAt(g.padX, g.padZ) + GROUND_RING_LIFT, g.padZ);
      rings.add(ring);
    }
    this.scene.add(rings);
    this.garageRings = rings;
    // Waypoint: one light pillar that hops to whichever garage is nearest.
    const pillarMat = new THREE.MeshBasicMaterial({
      color: 0xffa63d,
      transparent: true,
      opacity: 0.4,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    const pillar = new THREE.Mesh(new THREE.CylinderGeometry(0.7, 0.7, 18, 12, 1, true), pillarMat);
    pillar.position.y = 9;
    this.scene.add(pillar);
    this.garagePillar = pillar;
  }

  private nearestGarage(): Garage | null {
    const city = this.city;
    const car = this.car;
    if (!city || !car) return null;
    let best: Garage | null = null;
    let bd = Infinity;
    for (const g of city.garages) {
      const d = Math.hypot(g.padX - car.position.x, g.padZ - car.position.z);
      if (d < bd) {
        bd = d;
        best = g;
      }
    }
    return best;
  }

  private updateGarages(dt: number): void {
    if (this.garageOpen) this.garagePreview?.update(dt);
    const city = this.city;
    const car = this.car;
    if (!city || !car || this.mode.kind !== "playing") {
      if (this.garageOpen) this.closeGarage();
      return;
    }
    const g = this.nearestGarage();
    if (!g) return;
    if (this.garagePillar) {
      this.garagePillar.position.set(g.padX, city.heightAt(g.padX, g.padZ) + 9, g.padZ);
      const pm = this.garagePillar.material;
      if (pm instanceof THREE.MeshBasicMaterial) {
        pm.opacity = 0.3 + 0.15 * Math.sin(performance.now() / 300);
      }
    }
    const d = Math.hypot(g.padX - car.position.x, g.padZ - car.position.z);
    if (!this.garageOpen && d < 5.5 && car.speed < 4) this.openGarage();
    else if (this.garageOpen && d > 8) this.closeGarage();
  }

  private garageCardsHtml(): string {
    return ROBOTAXI_SKINS.map((sk) => {
      const owned = this.ownedSkins.has(sk.id) || sk.price === 0;
      const equipped = sk.id === this.skinId;
      const tag = equipped ? "EQUIPPED" : owned ? "EQUIP" : `$${sk.price.toLocaleString("en-US")}`;
      const cls = equipped ? "gcard on" : owned ? "gcard owned" : "gcard";
      return `<button class="${cls}" data-skin="${sk.id}"><canvas class="gprev" data-prev="${sk.id}"></canvas><b>${sk.label}</b><small>${sk.blurb}</small><span>${tag}</span></button>`;
    }).join("");
  }

  private openGarage(): void {
    this.garageOpen = true;
    let el = this.garageEl;
    if (!el) {
      el = document.createElement("div");
      el.id = "garage";
      document.body.appendChild(el);
      this.garageEl = el;
      el.addEventListener("click", (e) => {
        const btn = e.target instanceof Element ? e.target.closest("[data-skin]") : null;
        if (!(btn instanceof HTMLElement)) return;
        const id = btn.dataset["skin"];
        const sk = ROBOTAXI_SKINS.find((k) => k.id === id);
        if (!sk || !this.car) return;
        const owned = this.ownedSkins.has(sk.id) || sk.price === 0;
        if (!owned) {
          if (this.state.score < sk.price) {
            this.hud.announceMinor(`NEED $${sk.price}`, "#ff6a5e");
            return;
          }
          this.state.score -= sk.price;
          this.ownedSkins.add(sk.id);
          storageSet("crazy-waymo:skins-owned", JSON.stringify([...this.ownedSkins]));
          this.hud.announceMinor(`${sk.label} UNLOCKED −$${sk.price}`, "#ffd24a");
        }
        this.skinId = sk.id;
        storageSet("crazy-waymo:skin", sk.id);
        this.car.setSkin(sk.id);
        this.hud.setOperator(sk.label, sk.accent);
        this.renderGarage();
      });
      this.garagePreview = new GaragePreview(this.cache);
      this.garagePreview.bind(el);
    }
    this.renderGarage();
    el.style.display = "flex";
  }

  private renderGarage(): void {
    const el = this.garageEl;
    if (!el) return;
    el.innerHTML = `<div class="gtitle">✦ ROBOTAXI SHOWROOM ✦</div><div class="gcards">${this.garageCardsHtml()}</div><div class="ghint">drive away to close</div>`;
    this.garagePreview?.attach(el);
  }

  private closeGarage(): void {
    this.garageOpen = false;
    if (this.garageEl) this.garageEl.style.display = "none";
  }

  private openChat(): void {
    let el = this.chatEl;
    if (!el) {
      const found = document.getElementById("chat");
      if (!(found instanceof HTMLInputElement)) return;
      const input = found;
      el = input;
      this.chatEl = input;
      input.placeholder = this.touchUi
        ? "say something… (Return to send)"
        : "say something… (Enter to send, Esc to close)";
      input.addEventListener("keydown", (e) => {
        e.stopPropagation();
        if (e.key === "Enter") {
          const text = input.value.trim().slice(0, 90);
          if (text && this.car) {
            this.chatText = text;
            this.chatAt = Date.now();
            this.bubbles.say(this.car.object3D, text, { lift: 3.0 });
          }
          this.closeChat();
        } else if (e.key === "Escape") {
          this.closeChat();
        }
      });
      el.addEventListener("blur", () => this.closeChat());
    }
    el.style.display = "block";
    el.value = "";
    this.input.setTyping(true);
    el.focus();
  }

  private closeChat(): void {
    const el = this.chatEl;
    if (el) {
      el.style.display = "none";
      el.blur();
    }
    this.input.setTyping(false);
  }

  // Mario-Kart boost pop: one flame burst out of EACH exhaust pipe, colored
  // by tier (0.55 cyan mini-turbo, 0.07 orange boost/super).
  private exhaustFlash(hue: number): void {
    const car = this.car;
    if (!car) return;
    const fx = Math.sin(car.heading);
    const fz = Math.cos(car.heading);
    for (const s of [-1, 1] as const) {
      this.fx.boostFlash(
        car.position.x - fx * 1.9 - fz * 0.55 * s,
        car.position.y + 0.5,
        car.position.z - fz * 1.9 + fx * 0.55 * s,
        -fx,
        -fz,
        hue,
      );
    }
  }

  private handleStartPress(): void {
    if (this.mode.kind === "title" || this.mode.kind === "gameover") this.start();
  }

  private toggleMute(): void {
    this.sfx.setMuted(!this.sfx.muted);
    storageSet(SOUND_KEY, this.sfx.muted ? "0" : "1");
  }

  private start(): void {
    if (!this.loadDone) {
      // City still building behind the title — auto-start the moment it's done.
      // The status goes on the banner, not announceMinor: that lives inside
      // #hud, which the landing screen hides.
      this.pendingStart = true;
      this.hud.setCta(this.finishStage);
      return;
    }
    const car = this.car;
    const fares = this.fares;
    if (!car || !fares) return;
    notifyGameStarted();
    const lapS = (() => {
      let t = performance.now();
      return (label: string): void => {
        const now = performance.now();
        if (now - t > 300) console.log(`[start] ${label} ${Math.round(now - t)}ms`);
        t = now;
      };
    })();
    this.sfx.ensure();
    this.sfx.startMusic();
    lapS("sfx");
    this.state.reset();
    this.hud.resetScore(0);
    // Re-roll the spawn each run — start somewhere new in the city.
    const city = this.city;
    if (city) this.spawn = this.computeSpawn(city);
    lapS("spawn");
    car.reset(this.spawn.x, this.spawn.z, this.spawn.yaw);
    this.traffic?.reset({ gx: this.spawn.gx, gz: this.spawn.gz }, 4);
    lapS("traffic reset");
    fares.reset(car.position.x, car.position.z);
    lapS("fares reset");
    this.cones?.reset();
    this.hud.hideBanner();
    this.hud.setLanding(false); // HUD back, sound button + controls gone
    // A fresh dashboard through the countdown — no stale timer/fares/combo.
    this.hud.setTimer(FARE.startTime, false);
    this.hud.setCombo(1, 0);
    this.hud.setArrow(false, 0, 0, 0);
    this.hud.setVignette(0);
    this.outro = -1;
    this.hitStop = 0;
    this.lowBeepAt = -1;
    this.lastDistrict = "";
    this.countdownShown = -1;
    // Swoop-in start pose: high above and behind the fresh spawn. Never the
    // camera's previous position — the spawn re-rolls every run, so that
    // could be a cross-map flight at warp speed.
    {
      const fwd = new THREE.Vector2(Math.sin(this.spawn.yaw), Math.cos(this.spawn.yaw));
      this.camFrom.set(
        car.position.x - fwd.x * CAMERA.distance * 3.4,
        car.position.y + CAMERA.height + 44,
        car.position.z - fwd.y * CAMERA.distance * 3.4,
      );
      this.rig.camera.position.copy(this.camFrom);
    }
    this.minimap?.setVisible(true);
    setTouchPlaying(true);
    this.mode = { kind: "countdown", t: 0 };
  }

  // A random spot ON a network edge (off the map rim), nose along the street
  // — every run starts in a fresh neighborhood, always on real asphalt.
  private computeSpawn(city: CityModel): {
    x: number;
    z: number;
    yaw: number;
    gx: number;
    gz: number;
  } {
    const edges = city.network.edges;
    for (let attempt = 0; attempt < 32; attempt++) {
      const e = edges[Math.floor(Math.random() * edges.length)];
      if (!e || e.len < 30) continue;
      const s = e.len * (0.25 + Math.random() * 0.5);
      const smp = city.network.sample(e, s);
      const u = smp.x / WORLD_W + 0.5;
      const v = smp.z / WORLD_H + 0.5;
      if (u < 0.06 || u > 0.94 || v < 0.06 || v > 0.94) continue;
      const sign = Math.random() < 0.5 ? 1 : -1;
      return {
        x: smp.x,
        z: smp.z,
        yaw: Math.atan2(smp.tx * sign, smp.tz * sign),
        gx: city.gridX(smp.x),
        gz: city.gridZ(smp.z),
      };
    }
    const mid = { gx: Math.round((GRID_X - 1) / 2), gz: Math.round((GRID_Z - 1) / 2) };
    return { x: city.worldX(mid.gx), z: city.worldZ(mid.gz), yaw: 0, gx: mid.gx, gz: mid.gz };
  }

  // DEV-only: drop the taxi at the road cell nearest to normalized map coords
  // (u,v) — snapped onto a road, yaw aligned to an open road direction nearest
  // the requested one, so scripted drives don't start nose-first into a lot.
  debugTeleport(u: number, v: number, yaw: number): void {
    const car = this.car;
    const city = this.city;
    if (!car || !city) return;
    const x = (u - 0.5) * WORLD_W;
    const z = (v - 0.5) * WORLD_H;
    let best: { gx: number; gz: number } | null = null;
    let bd = Infinity;
    for (const rc of city.roadCells) {
      const cx = city.worldX(rc.gx);
      const cz = city.worldZ(rc.gz);
      const d = (cx - x) * (cx - x) + (cz - z) * (cz - z);
      if (d < bd) {
        bd = d;
        best = rc;
      }
    }
    if (!best) return;
    const isRoad = (gx: number, gz: number): boolean => city.plan.cells[gx]?.[gz] === "road";
    const options: { yaw: number; open: boolean }[] = [
      { yaw: 0, open: isRoad(best.gx, best.gz + 1) },
      { yaw: Math.PI, open: isRoad(best.gx, best.gz - 1) },
      { yaw: HALF_PI, open: isRoad(best.gx + 1, best.gz) },
      { yaw: -HALF_PI, open: isRoad(best.gx - 1, best.gz) },
    ];
    let bestYaw = yaw;
    let bestDiff = Infinity;
    for (const o of options) {
      if (!o.open) continue;
      const diff = Math.abs(((o.yaw - yaw + Math.PI * 3) % (Math.PI * 2)) - Math.PI);
      if (diff < bestDiff) {
        bestDiff = diff;
        bestYaw = o.yaw;
      }
    }
    car.reset(city.worldX(best.gx), city.worldZ(best.gz), bestYaw);
    this.rig.snapTo(car);
  }

  // DEV-only: force the run clock (endgame testing).
  debugSetTime(seconds: number): void {
    this.state.timeLeft = seconds;
  }

  // DEV-only: smash the nearest resting cone in place (exercises the physics
  // launch path without needing pixel-perfect scripted driving).
  debugSmashNearestCone(): boolean {
    const cones = this.cones;
    const car = this.car;
    if (!cones || !car) return false;
    const p = cones.restingPositions()[0];
    if (!p) return false;
    return cones.tryHit(p.x, p.z, 30, 12) > 0;
  }

  // DEV-only: nearest resting cone to the taxi, in normalized coords.
  debugNearestCone(): { u: number; v: number } | null {
    const car = this.car;
    if (!car || !this.cones) return null;
    let best: { x: number; z: number } | null = null;
    let bd = Infinity;
    for (const p of this.cones.restingPositions()) {
      const d = (p.x - car.position.x) ** 2 + (p.z - car.position.z) ** 2;
      if (d < bd) {
        bd = d;
        best = p;
      }
    }
    return best ? { u: best.x / WORLD_W + 0.5, v: best.z / WORLD_H + 0.5 } : null;
  }

  // DEV-only: live car state for headless verification.
  debugProbe(): {
    x: number;
    z: number;
    y: number;
    speed: number;
    heading: number;
    airborne: boolean;
    drifting: boolean;
    boosting: boolean;
    carrying: boolean;
    objective: { u: number; v: number } | null;
    wreckedCount: number;
    nearestTraffic: { dist: number; wrecked: boolean; y: number } | null;
  } | null {
    const car = this.car;
    if (!car) return null;
    const obj = this.fares?.objective() ?? null;
    let nearestTraffic: { dist: number; wrecked: boolean; y: number } | null = null;
    if (this.traffic) {
      for (const c of this.traffic.cars) {
        const d = Math.hypot(c.position.x - car.position.x, c.position.z - car.position.z);
        if (!nearestTraffic || d < nearestTraffic.dist) {
          nearestTraffic = {
            dist: Math.round(d * 10) / 10,
            wrecked: c.wrecked,
            y: Math.round(c.position.y * 10) / 10,
          };
        }
      }
    }
    return {
      x: car.position.x,
      z: car.position.z,
      y: car.position.y,
      speed: car.speed,
      heading: car.heading,
      airborne: car.airborne,
      drifting: car.isDrifting,
      boosting: car.isBoosting,
      carrying: this.fares?.carryingInfo() !== null && this.fares !== null,
      objective: obj ? { u: obj.pos.x / WORLD_W + 0.5, v: obj.pos.z / WORLD_H + 0.5 } : null,
      wreckedCount: this.traffic ? this.traffic.cars.filter((c) => c.wrecked).length : 0,
      nearestTraffic,
    };
  }

  update(dt: number): void {
    if (this.paused) return;
    // Publishes the on-screen stick into `input` before carInput() reads it.
    this.touch?.update();
    if (this.input.consumeStart()) {
      if (this.mode.kind === "playing" && !this.input.typing) this.openChat();
      else this.handleStartPress();
    }
    // Single read — calling consumeRestart() twice would clear the one-shot flag
    // before the second branch could see it. R restarts from any state.
    if (this.input.consumeRestart()) this.start();
    if (this.input.consumeMute()) this.toggleMute();
    this.updateGarages(dt);
    this.heckleCooldown = Math.max(0, this.heckleCooldown - dt);
    this.bubbles.update(dt);
    this.hud.update(dt);
    this.fx.update(dt);
    this.ambient?.update(dt, this.dayNight.lamp, this.sceneFog);
    this.skids?.update(dt);
    this.trails?.update(dt);
    this.shocks.update(dt);
    this.clouds.update(dt);
    this.oceanTime.value += dt;
    // Day rolls on in every mode (title orbit included — sunsets sell there).
    this.dayNight.update(dt);
    this.maybeBakeSky(); // mobile tiers only; no-op at full quality
    if (this.editorLighting && this.scene.fog instanceof THREE.Fog) {
      this.scene.fog.near = 4000;
      this.scene.fog.far = 12000;
    }
    const night = this.dayNight.lamp;
    this.lampGlow?.setIntensity(night);
    this.nightWindows?.setIntensity(night);
    this.lampGlow?.updateNear(this.rig.camera.position.x, this.rig.camera.position.z, dt);
    this.clouds.setNight(night);
    this.car?.setHeadlights(night);
    this.debris?.update(dt);
    this.cones?.update(dt);

    switch (this.mode.kind) {
      case "loading":
        break;
      case "title":
        this.updateTitle(dt);
        break;
      case "countdown":
        this.updateCountdown(this.mode, dt);
        break;
      case "playing":
        this.updatePlaying(dt);
        break;
      case "gameover":
        this.updateTitle(dt);
        break;
    }

    // Sun follow + shadow-frustum snap track wherever the camera ended up —
    // unconditional at the tail so no mode path (hit-stop, outro, freecam…)
    // can forget it and leave shadows lagging the camera.
    this.updateSun();
    // Stream city chunks around wherever the camera ended up this frame (works
    // in gameplay and freecam alike) so distant tiles stop drawing.
    this.city?.updateStreaming(this.rig.camera, this.editorLighting);

    // Don't start the net session (or its offline-fallback grace clock) until
    // the scene has loaded — asset + physics load can otherwise outlast the
    // grace window and drop us to solo before the socket ever connects.
    if (this.mode.kind !== "loading") this.updateNet(dt);
  }

  /** Broadcast the local taxi and render the other players' taxis. Runs in
   *  every mode so you see the city populated even on the title screen. */
  private updateNet(dt: number): void {
    const car = this.car;
    const remote = this.remoteCars;
    // Don't tick the net before assets are in: the offline-fallback grace
    // window starts on the first tick, and this game's GLB + wasm load can
    // eat the whole window on a slow link — wrongly dropping us to solo
    // while the socket never got a chance.
    if (!car || !remote) return;
    this.net.tick();

    // Only an active driver broadcasts: title idlers all park at the same
    // deterministic spawn, and streaming that pose 15×/s just piles identical
    // frozen taxis onto everyone's spawn plaza.
    const driving =
      this.mode.kind === "countdown" ||
      this.mode.kind === "playing" ||
      this.mode.kind === "gameover";
    if (!this.net.offline && driving) {
      this.netAcc += dt;
      if (this.netAcc >= 1 / NET_TICK_HZ) {
        this.netAcc = 0;
        this.net.updateMyState({
          x: roundNet(car.position.x),
          y: roundNet(car.position.y),
          z: roundNet(car.position.z),
          h: roundNet(car.heading),
          skin: this.skinId,
          msg: this.chatText,
          msgAt: this.chatAt,
        });
      }
    }

    remote.sync(this.net.players, this.net.playerId, car.position);
    remote.update(dt);

    if (this.netInfoEl) {
      const others = Math.max(0, Object.keys(this.net.players).length - 1);
      this.netInfoEl.textContent =
        !this.net.live || this.net.offline || others === 0 ? "" : `${others} ONLINE`;
    }
  }

  private silenceLoops(): void {
    this.sfx.stopEngine();
    this.sfx.setScreech(0, 0);
    this.sfx.setScrape(false);
    this.sfx.setBoostLoop(false);
  }

  private updateTitle(dt: number): void {
    this.titleT += dt;
    const car = this.car;
    if (!car) return;
    if (this.freecam) return;
    // High, slow orbit — above the rooftops so facades can't swallow the shot.
    const r = 30;
    const a = this.titleT * 0.2;
    this.rig.camera.position.set(
      car.position.x + Math.cos(a) * r,
      car.position.y + 17,
      car.position.z + Math.sin(a) * r,
    );
    this.rig.camera.lookAt(car.position.x, car.position.y + 1.0, car.position.z);
    this.speedLines.update(dt, this.rig.camera, 0); // fade out leftover streaks
  }

  // 3-2-1-GO: the camera swoops from the title orbit into the chase pose while
  // the numbers count down; holding gas through GO pays launch-control boost.
  private updateCountdown(mode: { kind: "countdown"; t: number }, dt: number): void {
    const car = this.car;
    if (!car) return;
    mode.t += dt;
    const total = COUNTDOWN_STEP * 3;
    const step = Math.min(2, Math.floor(mode.t / COUNTDOWN_STEP));
    if (step !== this.countdownShown) {
      this.countdownShown = step;
      this.hud.showCountdown(String(3 - step), false);
      this.sfx.countdown(3 - step);
    }
    // Swoop: ease from the orbit pose into the chase pose.
    const f = THREE.MathUtils.smoothstep(Math.min(1, mode.t / total), 0, 1);
    const fwd = new THREE.Vector2(Math.sin(car.heading), Math.cos(car.heading));
    const chase = new THREE.Vector3(
      car.position.x - fwd.x * CAMERA.distance,
      car.position.y + CAMERA.height,
      car.position.z - fwd.y * CAMERA.distance,
    );
    this.rig.camera.position.lerpVectors(this.camFrom, chase, f);
    this.rig.camera.lookAt(car.position.x, car.position.y + 1.6, car.position.z);

    if (mode.t >= total) {
      this.hud.showCountdown("GO!", true);
      this.sfx.go();
      this.rig.snapTo(car);
      if (this.input.carInput().throttle > 0) {
        car.addBoost(25);
        this.hud.announceMinor("LAUNCH BOOST!", "#ffd147");
      }
      this.mode = { kind: "playing" };
    }
  }

  private updatePlaying(dt: number): void {
    const car = this.car;
    const city = this.city;
    const fares = this.fares;
    const traffic = this.traffic;
    if (!car || !city || !fares || !traffic) return;

    // Time-up outro: 1.2s of slow-mo before the banner so the ending lands.
    if (this.outro >= 0) {
      this.outro -= dt;
      dt *= 0.35;
      if (this.outro <= 0) {
        this.endRun();
        return;
      }
    }

    // Hit-stop: freeze the sim for a beat after a hard crash so the blow lands.
    // Camera/HUD keep running on real time so it reads as impact, not a stutter.
    const solids = this.solidIndex;
    if (!solids) return;

    if (this.hitStop > 0) {
      this.hitStop = Math.max(0, this.hitStop - dt);
      this.rig.update(dt, car, solids);
      this.tickHud(dt, car, fares, false);
      return;
    }

    const input = this.input.carInput();

    car.update(dt, input, solids);
    this.handleTrafficImpacts(car, traffic, dt);
    this.handleParkedImpacts(car, dt);
    traffic.update(dt, city, car.position.x, car.position.z, car.heading);
    this.signalLights?.update(traffic.time);
    this.physics?.streamSolids(car.position.x, car.position.z);
    this.physics?.step(dt, (fdt) => car.physicsFixedStep(fdt));
    car.syncFromPhysics(dt);
    // Same gate as the vehicle's pedal state machine: at/below 0.5 u/s the
    // pedal means reverse, so the cap says so.
    this.touch?.setReverseHint(car.forwardSpeed <= 0.5);
    traffic.syncWrecked();
    this.parked?.sync();
    this.parked?.updateCulling(this.rig.camera.position.x, this.rig.camera.position.z);
    this.handleNearMiss(car, traffic);
    this.handleHonks(traffic);
    this.handleCones(car);

    // The run is over during the outro — no fare events, no combo ticking.
    if (this.outro < 0) {
      const ev = fares.update(dt, car);
      this.handleFareEvent(ev);
      this.state.update(dt, fares.carryingInfo() !== null);
    }

    // Drift: score + screech + smoke + skid marks (slip-gated in the car).
    const drifting = car.isDrifting && car.speed > 8;
    if (drifting) this.state.addDrift(dt);
    else this.state.endDrift();
    // Hard straight braking reads like the drift: streaks + smoke + screech.
    const brakingHard = !drifting && !car.airborne && input.brake > 0.05 && car.forwardSpeed > 8;
    const slipAmt = Math.min(1, Math.abs(car.slip) / 0.6);
    // During the outro the farewell skid owns the screech channel.
    if (this.outro < 0) {
      const screech = drifting && !car.airborne ? Math.max(0.25, slipAmt) : brakingHard ? 0.3 : 0;
      this.sfx.setScreech(screech, car.speed / CAR.maxSpeed);
    }
    this.vehicleFx.update(
      dt,
      car,
      drifting,
      brakingHard,
      city.surfaceKindAt(car.position.x, car.position.z),
    );

    // Mini-turbo tier tell (Mario Kart): a blip + spark flare each time the
    // charge steps up a tier — blue at tier 1, orange at tier 2.
    const tier = drifting ? car.driftTier : 0;
    if (tier > this.lastDriftTier) {
      this.sfx.driftArm();
      const hue = tier === 2 ? 0.07 : 0.58;
      this.fx.burst(car.position.x, 0.6, car.position.z, hue, 10, 5);
    }
    this.lastDriftTier = tier;

    // Drift-release mini-turbo — the signature skill move — pays by tier.
    // Mario Kart grammar: the pop comes out of the exhaust pipes, tier-
    // colored (cyan → orange). No ground shockwave.
    if (car.miniBoostFired) {
      const superTurbo = car.miniTurboTier >= 2;
      this.sfx.boost();
      this.rig.addTrauma(superTurbo ? 0.26 : 0.18);
      this.hud.flash(superTurbo ? "#ffa726" : "#8fe8ff", 0.16);
      this.exhaustFlash(superTurbo ? 0.07 : 0.55);
      this.hud.showCombo(superTurbo ? "SUPER MINI-TURBO!" : "MINI-TURBO!");
    }

    // Boost package: ignition one-shot + loop + flames + camera kick.
    if (car.isBoosting && !this.wasBoosting) {
      this.sfx.boost();
      this.rig.addTrauma(0.12);
      this.exhaustFlash(0.07);
    }
    this.wasBoosting = car.isBoosting;
    this.sfx.setBoostLoop(car.isBoosting);
    if (car.isBoosting) {
      this.flameAccum += dt;
      if (this.flameAccum >= 0.05) {
        this.flameAccum = 0;
        // Twin flame cones off the rear corners (not one center plume).
        const fx = Math.sin(car.heading);
        const fz = Math.cos(car.heading);
        for (const s of [-1, 1] as const) {
          this.fx.exhaustFlame(
            car.position.x - fx * 1.9 - fz * 0.55 * s,
            car.position.y + 0.5,
            car.position.z - fz * 1.9 + fx * 0.55 * s,
            -fx,
            -fz,
          );
        }
      }
    }
    if (car.boostDenied) {
      this.sfx.denied();
      this.hud.boostDenied();
    }

    this.sfx.setEngine(
      Math.min(1, car.speed / CAR.boostSpeed),
      input.throttle - input.brake, // the engine hum still reads the old -1..1 pedal axis
      car.isBoosting,
      car.airborne,
    );

    // Landing package: squash (in the car), dust ring, thud, shake, air pay.
    if (car.justLanded > 0) {
      this.fx.dustRing(car.position.x, car.position.y + 0.15, car.position.z, 10);
      this.sfx.landThud(Math.min(1, car.justLanded / 12));
      this.rig.addTrauma(Math.min(0.45, 0.15 + car.justLanded * 0.015));
      if (car.airTime > 0.45) {
        const pts = this.state.landAir(car.airTime);
        const air = `AIR ${car.airTime.toFixed(1)}s`;
        this.hud.announceMinor(pts > 0 ? `${air} +$${pts}` : air, "#8fd9ff");
      }
    }

    // Wall contact: crash / scrape / curb-tap, in descending order of drama.
    if (car.lastWallHit > CRASH_THRESHOLD) {
      const impact = car.lastWallHit;
      const p = Math.min(1, (impact - CRASH_THRESHOLD) / 20);
      this.rig.addTrauma(0.35 + p * 0.5);
      this.hud.flash("#ffffff", 0.25 + p * 0.3);
      this.fx.burst(car.position.x, 1, car.position.z, 0.07, 10, 6 + p * 8);
      this.sfx.crash(impact);
      this.debris?.burst(
        car.position.x,
        car.position.z,
        car.lastWallNormal.x,
        car.lastWallNormal.y,
        impact,
      );
      if (this.skids) {
        for (let i = 0; i < 4; i++) {
          this.skids.stamp(
            car.position.x + (Math.random() - 0.5) * 1.6,
            car.position.z + (Math.random() - 0.5) * 1.6,
            car.heading,
            0.5,
          );
        }
      }
      if (impact > 12) {
        this.hitStop = THREE.MathUtils.clamp(0.04 + (impact - 12) * 0.004, 0.04, 0.13);
      }
    } else if (car.lastWallHit > 2) {
      this.sfx.thud();
      this.rig.addTrauma(0.06);
    }
    // Scrape loop: grinding along a wall below crash speed.
    if (car.wallContact && car.lastWallHit <= CRASH_THRESHOLD && car.speed > 7) {
      this.scrapeFrames = Math.min(this.scrapeFrames + 1, 10);
    } else {
      this.scrapeFrames = Math.max(this.scrapeFrames - 1, 0);
    }
    const scraping = this.scrapeFrames >= 2;
    this.sfx.setScrape(scraping);
    if (scraping && Math.random() < 0.4) {
      this.fx.scrapeSparks(
        car.position.x - car.lastWallNormal.x * 0.9,
        car.position.y + 0.5,
        car.position.z - car.lastWallNormal.y * 0.9,
        car.lastWallNormal.x,
        car.lastWallNormal.y,
      );
    }

    // One-time teach toasts for the two skill verbs.
    if (!this.hintDriftShown) {
      this.turnHold = Math.abs(input.steer) > 0.5 && car.speed > 30 ? this.turnHold + dt : 0;
      if (this.turnHold > 0.8) {
        this.hintDriftShown = true;
        storageSet(HINT_DRIFT_KEY, "1");
        this.hud.announceMinor("BRAKE + STEER TO DRIFT", "#ffd147");
      }
    }
    if (!this.hintBoostShown && car.boostMeter >= CAR.boostMax) {
      this.hintBoostShown = true;
      storageSet(HINT_BOOST_KEY, "1");
      this.hud.announceMinor(this.touchUi ? "TAP BOOST!" : "SHIFT — BOOST!", "#ffd147");
    }

    // Announce the SF neighborhood as the taxi crosses into it.
    const dist = districtAt(city.gridX(car.position.x), city.gridZ(car.position.z));
    if (dist.name !== this.lastDistrict) {
      this.lastDistrict = dist.name;
      this.hud.setArea(dist.name);
      this.hud.showDistrict(dist.name);
    }

    if (!this.freecam) {
      this.rig.update(dt, car, solids);
      // Keep the camera above the terrain (hills can rise behind the car).
      const cam = this.rig.camera;
      const minY = city.heightAt(cam.position.x, cam.position.z) + 2.5;
      if (cam.position.y < minY) cam.position.y = minY;
    }
    this.speedLines.update(dt, this.rig.camera, car.speed / CAR.boostSpeed);
    this.hud.setVignette(THREE.MathUtils.clamp((car.speed - 45) / 40, 0, 1) * 0.6);
    this.tickHud(dt, car, fares, true);

    if (this.state.timeLeft <= 10) {
      const sec = Math.ceil(this.state.timeLeft);
      if (sec !== this.lowBeepAt && sec > 0) {
        this.lowBeepAt = sec;
        this.sfx.beep();
      }
    }

    if (this.state.timedOut && this.outro < 0) {
      this.outro = 1.2;
      this.silenceLoops();
      this.sfx.setScreech(1, 1); // one long farewell skid
    }
  }

  private handleCones(car: Car): void {
    const cones = this.cones;
    if (!cones) return;
    const vx = Math.sin(car.heading) * car.speed;
    const vz = Math.cos(car.heading) * car.speed;
    const hits = cones.tryHit(car.position.x, car.position.z, vx, vz);
    if (hits > 0) {
      let cash = 0;
      for (let i = 0; i < hits; i++) cash += this.state.smash();
      this.hud.announceMinor(cash > 0 ? `SMASH +$${cash}` : "SMASH", "#ffb64d");
      this.sfx.thud();
      this.fx.burst(car.position.x, 0.8, car.position.z, 0.07, 5, 4);
    }
  }

  // Ram a traffic car → it gets punted into the physics world (dynamic body,
  // impulse along the contact normal); the taxi sheds some speed but keeps
  // its line. Airborne taxis clear roofs (handled by the height check).
  private handleTrafficImpacts(car: Car, traffic: Traffic, dt: number): void {
    const physics = this.physics;
    if (!physics) return;
    for (const c of traffic.cars) {
      if (c.puntCooldown > 0) continue;
      if (car.position.y > c.position.y + 1.9) continue; // flying over it
      const dx = c.position.x - car.position.x;
      const dz = c.position.z - car.position.z;
      const d = Math.hypot(dx, dz);
      if (d < 1e-4) continue;
      const nx = dx / d;
      const nz = dz / d;
      // Closing speed of the taxi toward this car (0 in physics mode has no
      // side effects — it just reads the velocity along the normal).
      const impact = car.contactPunt(nx, nz, 0);
      // Flip the car to a dynamic body the frame contact is imminent (bodies
      // touch at CONTACT_R; the taxi covers `closing * dt` more this step), so
      // Rapier resolves against a real (heavy) body, not a kinematic wall. Then
      // the taxi's own momentum shoves it — pure physics, no scripted push. The
      // heavier taxi wins the exchange; both slow like actual cars.
      const reach = CONTACT_R + Math.max(0, impact) * dt;
      if (d > reach) continue;
      if (impact < 0.4 && d > CONTACT_R) continue;
      c.puntCooldown = 0.25;
      c.punt(physics);
      // Feed the existing crash pipeline (sfx/debris/shake scale with it).
      car.lastWallHit = Math.max(car.lastWallHit, impact * 0.5);
      // SF has opinions about robotaxis. Bumped drivers share theirs.
      if (impact > 4 && this.heckleCooldown <= 0 && Math.random() < 0.65) {
        this.heckleCooldown = 7;
        const line = this.pickHeckle();
        if (line) this.bubbles.say(c.object3D, line, { lift: 2.3, dur: 4.5, accent: "#e05c2e" });
      }
      // Real hits cost money — traffic is the risk side of weaving.
      if (impact > 7) {
        const pen = this.state.trafficHit(impact);
        this.hud.announceMinor(`TRAFFIC HIT −$${pen}`, "#ff5a52");
      }
    }
  }

  // Ram a parked car → it becomes a dynamic body and the taxi's momentum shoves
  // it off (pure physics), same feel as traffic but with no run/wreck
  // bookkeeping. tryPunt returns the closing speed for the crash pipeline.
  private handleParkedImpacts(car: Car, dt: number): void {
    const parked = this.parked;
    if (!parked) return;
    const impact = parked.tryPunt(car.position.x, car.position.z, car.velX, car.velZ, dt);
    if (impact > 0) car.lastWallHit = Math.max(car.lastWallHit, impact * 0.5);
  }

  private handleHonks(traffic: Traffic): void {
    for (const c of traffic.cars) {
      if (!c.wantsHonk) continue;
      c.wantsHonk = false;
      this.sfx.honk(this.panFor(c.position));
    }
  }

  // Which ear should hear an event at this world position?
  private panFor(pos: THREE.Vector3): number {
    const cam = this.rig.camera;
    const right = new THREE.Vector3().setFromMatrixColumn(cam.matrixWorld, 0);
    const rel = new THREE.Vector3().subVectors(pos, cam.position);
    return THREE.MathUtils.clamp(rel.dot(right) / 14, -1, 1);
  }

  private handleFareEvent(ev: FareEvent): void {
    const car = this.car;
    const city = this.city;
    if (ev.kind === "pickup") {
      this.sfx.pickup();
      this.fx.burst(ev.pos.x, 1.2, ev.pos.z, 0.5, 10, 5);
      const destName = city ? districtAt(ev.dest.gx, ev.dest.gz).name : "";
      this.hud.showCombo(destName ? `TO ${destName.toUpperCase()}!` : "GO GO GO!");
      this.sayRiderLine("pickup");
      if (car) car.addBoost(20);
    } else if (ev.kind === "dropoff") {
      const reward = this.state.dropoff(ev.tiles, ev.rideTime, tierPayMult(ev.tier));
      this.sfx.dropoff(reward.combo);
      // Confetti pop: bursts across the hue wheel + a gold ring — a paycheck
      // should look like a party, not a dust cloud.
      this.fx.burst(ev.pos.x, 1.2, ev.pos.z, 0.0, 9, 8);
      this.fx.burst(ev.pos.x, 1.7, ev.pos.z, 0.33, 9, 7);
      this.fx.burst(ev.pos.x, 2.1, ev.pos.z, 0.6, 9, 6);
      this.shocks.fire(ev.pos.x, 1.0, ev.pos.z, 0xffd147);
      this.hud.flashTimeBonus(reward.timeBonus);
      this.hud.flash("#6bff8e", 0.22);
      this.rig.addTrauma(0.25);
      // Itemized receipt: fare, then tip, then combo — each earns its beat.
      const lines: { text: string; color: string }[] = [
        { text: `FARE $${reward.fare}`, color: "#ffffff" },
      ];
      if (reward.tip > 0) lines.push({ text: `TIP $${reward.tip} SPEEDY!`, color: "#6bff8e" });
      if (reward.combo > 1) lines.push({ text: `${reward.combo}× COMBO`, color: "#ffd147" });
      if (reward.overflowCash > 0)
        lines.push({ text: `TIME FULL +$${reward.overflowCash}`, color: "#8fd9ff" });
      this.hud.showReceipt(lines);
      this.hud.showCombo(`+$${reward.gross}`);
      this.sayRiderLine("dropoff");
      if (car) car.addBoost(30);
    } else if (ev.kind === "bail") {
      this.state.bail();
      this.sfx.denied();
      this.hud.flash("#ff5a52", 0.2);
      this.hud.announceMinor("PASSENGER BAILED!", "#ff5a52");
    }
  }

  // Heckles know WHO they're yelling at: mostly the citywide anti-robotaxi
  // pool, but ~45% of the time an operator-specific jab at the equipped car.
  private pickHeckle(): string | undefined {
    const sk = skinById(this.skinId);
    const pool = sk.heckles.length > 0 && Math.random() < 0.45 ? sk.heckles : HECKLES;
    return pool[Math.floor(Math.random() * pool.length)];
  }

  // Rider flavor: operator-specific one-liners in the equipped brand's color.
  private sayRiderLine(kind: "pickup" | "dropoff"): void {
    const car = this.car;
    if (!car) return;
    const sk = skinById(this.skinId);
    const pool = kind === "pickup" ? sk.pickupLines : sk.dropoffLines;
    const line = pool[Math.floor(Math.random() * pool.length)];
    if (line) this.bubbles.say(car.object3D, line, { lift: 3.0, dur: 3.5, accent: sk.accent });
  }

  private handleNearMiss(car: Car, traffic: Traffic): void {
    if (car.speed < NEAR_MISS_SPEED) return;
    if (car.lastWallHit > 0) return; // a crash this frame isn't a near miss
    for (const c of traffic.cars) {
      if (c.missCooldown > 0) continue;
      const dx = car.position.x - c.position.x;
      const dz = car.position.z - c.position.z;
      const d = Math.hypot(dx, dz);
      if (d >= NEAR_MISS_MIN && d <= NEAR_MISS_MAX) {
        c.missCooldown = 2.6; // long enough that tailgating can't farm it
        const speedFrac = car.speed / CAR.boostSpeed;
        const pts = this.state.nearMiss(speedFrac);
        car.addBoost(CAR.boostPerNearMiss);
        this.fx.burst(c.position.x, 1, c.position.z, 0.5, 6, 4);
        const insane = speedFrac > 0.8;
        const label = insane ? "INSANE!" : "NEAR MISS";
        this.hud.announceMinor(
          pts > 0 ? `${label} +$${pts}` : label,
          insane ? "#ff8a3c" : "#aee3ff",
        );
        this.sfx.nearMiss(this.panFor(c.position));
        if (this.heckleCooldown <= 0 && Math.random() < 0.22) {
          this.heckleCooldown = 9;
          const line = this.pickHeckle();
          if (line) this.bubbles.say(c.object3D, line, { lift: 2.3, dur: 4, accent: "#e05c2e" });
        }
      }
    }
  }

  // HUD + minimap redraws, throttled to HUD_HZ on mobile (canvas dial blits
  // and DOM writes at 60Hz are real main-thread cost on phones). Desktop
  // flushes every call, exactly as before. Accumulated dt keeps the minimap
  // pulse animation running at true speed.
  private tickHud(dt: number, car: Car, fares: FareManager, withMinimap: boolean): void {
    this.hudAcc += dt;
    if (this.mobileUi && this.hudAcc < 1 / HUD_HZ) return;
    this.updateHud(car, fares);
    if (withMinimap) this.updateMinimap(this.hudAcc, car, fares);
    this.hudAcc = 0;
  }

  private updateMinimap(dt: number, car: Car, fares: FareManager): void {
    const minimap = this.minimap;
    if (!minimap) return;
    const markers = this.mmMarkers; // persistent — this runs every redraw
    markers.length = 0;
    // Garages at the bottom of the stack: orange pads, drawn only in-window
    // except the nearest one, which pins to the edge as a "swap here" hint.
    const city = this.city;
    if (city) {
      const nearest = this.nearestGarage();
      for (const g of city.garages) {
        markers.push({
          x: g.padX,
          z: g.padZ,
          color: "#ffa63d",
          shape: "square",
          edgeClamp: g === nearest,
        });
      }
    }
    // Other online drivers under the objectives, outlined so they read on
    // road-grey (plain white dots were invisible).
    for (const [id, p] of Object.entries(this.net.players)) {
      if (id === this.net.playerId) continue;
      const t = readTransform(p.state);
      if (t) markers.push({ x: t.x, z: t.z, color: "#ffffff", shape: "player" });
    }
    const carrying = fares.carryingInfo();
    if (carrying) {
      markers.push({ x: carrying.pos.x, z: carrying.pos.z, color: "#49e0ff", ring: true });
    } else {
      for (const w of fares.waitingList()) {
        markers.push({ x: w.x, z: w.z, color: tierHex(w.tier) });
      }
    }
    minimap.update(dt, car.position.x, car.position.z, car.heading, markers);
  }

  private updateSun(): void {
    // Shadows follow the camera in freecam so any inspected spot is lit.
    const raw = this.freecam ? this.rig.camera.position : this.car?.position;
    if (!raw) return;
    const anchor = this.scrSnapAnchor.copy(raw);
    // Cadenced shadow updates (mobile low tiers): snap the shadow camera to a
    // shadow-texel grid in light space, or every 2nd/3rd-frame re-render
    // lands on a sub-texel offset and the whole shadow field swims.
    if (this.quality.shadowEvery > 1) {
      const dir = this.scrSnapDir.copy(this.dayNight.sunOffset).normalize();
      const up = Math.abs(dir.y) > 0.97 ? this.scrSnapUp.set(0, 0, 1) : this.scrSnapUp.set(0, 1, 0);
      const right = this.scrSnapRight.crossVectors(up, dir).normalize();
      const upOrtho = this.scrSnapUp.crossVectors(dir, right); // orthonormal
      const cam = this.sun.shadow.camera;
      const texel = (cam.right - cam.left) / Math.max(1, this.sun.shadow.mapSize.x);
      const rx = anchor.dot(right);
      const ry = anchor.dot(upOrtho);
      anchor
        .addScaledVector(right, Math.round(rx / texel) * texel - rx)
        .addScaledVector(upOrtho, Math.round(ry / texel) * texel - ry);
    }
    this.sun.position.copy(anchor).add(this.dayNight.sunOffset);
    this.sun.target.position.copy(anchor);
    this.sun.target.updateMatrixWorld();
  }

  // DEV-only: jump the day-night cycle (night-look verification).
  debugSetDayPhase(p: number): void {
    this.dayNight.setPhase(p);
  }

  private updateHud(car: Car, fares: FareManager): void {
    this.hud.setTimer(this.state.timeLeft, this.state.timeLeft <= 10);
    this.hud.setScore(this.state.displayScore);
    this.hud.setSpeed(car.speed * MPH_FACTOR);
    this.hud.setBoost(car.boostMeter / CAR.boostMax);
    this.hud.setCombo(this.state.combo, this.state.comboTimer / FARE.comboWindow);

    // The card only shows while CARRYING (destination + patience); while
    // seeking, the beacon, minimap dot and off-screen arrow are enough.
    const carrying = fares.carryingInfo();
    if (carrying) {
      const city = this.city;
      const name = city ? districtAt(carrying.dest.gx, carrying.dest.gz).name : "";
      const distM = Math.hypot(car.position.x - carrying.pos.x, car.position.z - carrying.pos.z);
      this.hud.setFareCard(`TO ${name.toUpperCase()} →`, distM, fares.patienceFrac());
      this.projectArrow(carrying.pos, "#49e0ff");
      return;
    }
    this.hud.hideFareCard();
    const next = fares.nearestWaiting(car.position.x, car.position.z);
    if (!next) {
      this.hud.setArrow(false, 0, 0, 0);
      return;
    }
    this.projectArrow(next.pos, tierHex(next.tier));
  }

  private projectArrow(target: THREE.Vector3, color: string): void {
    const ndc = this.scrArrow.copy(target).project(this.rig.camera);
    const behind = ndc.z > 1;
    let x = ndc.x;
    let y = ndc.y;
    if (behind) {
      x = -x;
      y = -y;
    }
    const onScreen = !behind && x > -0.92 && x < 0.92 && y > -0.92 && y < 0.92;
    if (onScreen) {
      this.hud.setArrow(false, 0, 0, 0);
      return;
    }
    const m = 0.86;
    const cx = THREE.MathUtils.clamp(x, -m, m);
    const cy = THREE.MathUtils.clamp(y, -m, m);
    const sx = (cx * 0.5 + 0.5) * window.innerWidth;
    const sy = (-cy * 0.5 + 0.5) * window.innerHeight;
    const dx = sx - window.innerWidth / 2;
    const dy = sy - window.innerHeight / 2;
    const rot = Math.atan2(dx, -dy);
    this.hud.setArrow(true, sx - 32, sy - 32, rot, color);
  }

  private endRun(): void {
    this.silenceLoops();
    this.sfx.stopMusic();
    this.sfx.gameOver();
    setTouchPlaying(false);
    this.minimap?.setVisible(false);
    this.hud.hideFareCard();
    this.hud.setArrow(false, 0, 0, 0);
    this.hud.setVignette(0);
    this.outro = -1;
    const score = this.state.displayScore;
    const best = readBest();
    const isBest = score > best;
    if (isBest) {
      storageSet(BEST_KEY, String(score));
      this.sfx.fanfare();
    }
    const { rank, next, nextAt } = rankFor(score);
    const tease = next ? ` · next: CLASS ${next} at $${nextAt.toLocaleString("en-US")}` : "";
    this.mode = { kind: "gameover", score, fares: this.state.fares };
    this.hud.showBanner({
      title: isBest ? "NEW BEST!" : "TIME'S UP!",
      sub: `$${score.toLocaleString("en-US")} — CLASS ${rank} LICENSE`,
      stats: `${this.state.fares} fares · best drift ${this.state.bestDrift.toFixed(1)}s · best air ${this.state.bestAir.toFixed(1)}s${tease}`,
      cta: this.touchUi ? "TAP TO RETRY" : "PRESS ENTER TO RETRY",
    });
  }
}

/** Centimeter precision is plenty for remote taxis and trims the 15 Hz
 *  payload (~64 players of full-precision float64 JSON adds up). */
function roundNet(v: number): number {
  return Math.round(v * 100) / 100;
}
