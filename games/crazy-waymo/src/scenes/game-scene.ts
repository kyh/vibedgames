import { choosePlayerSpawn, isPlayerSpawnSafe } from "../world/player-spawn";
import * as THREE from "three";
import { notifyGameStarted, watchControlContext } from "@repo/embed";
import { isPlaytestRequested } from "@vibedgames/playtest";
import { FixedRate } from "@vibedgames/multiplayer";
import type { MultiplayerClient, PlayerMap } from "@vibedgames/multiplayer";

import { ModelCache } from "../assets/loader";
import { bannerControls } from "../controls";
import type { AmbientLife } from "../fx/ambient-life";
import { BeaconLights, collectBeacons } from "../fx/beacon-lights";
import type { Beacon } from "../fx/beacon-lights";
import { ChaseCamera } from "../fx/camera-rig";
import { SkyClouds } from "../fx/clouds";
import { Harbor } from "../fx/harbor";
import { ImpactStars } from "../fx/impact-stars";
import type { SmashCones } from "../fx/cones";
import type { Debris } from "../fx/debris";
import type { LampGlow } from "../fx/lamp-glow";
import { setParcelNight } from "../world/parcel-build";
import { setSalesforceNight } from "../world/sf-salesforce";
import { Fx } from "../fx/particles";
import { Sfx } from "../fx/sfx";
import { SignalLights } from "../fx/signal-lights";
import type { SkidMarks } from "../fx/skids";
import { SpeedLines } from "../fx/speedlines";
import { VehicleFxRig } from "../fx/vehicle-fx";
import { SEA_Y } from "../world/water";
import { VehicleLights } from "../fx/vehicle-lights";
import { Shockwaves } from "../fx/shockwaves";
import type { DriftTrails } from "../fx/trails";
import { GROUND_RING_LIFT, tierColor, tierPayMult } from "../game/fares";
import type { FareEvent, FareManager } from "../game/fares";
import { GameState } from "../game/state";
import type { ParkedCars } from "../game/parked-cars";
import { Traffic } from "../game/traffic";
import type { TrafficCar } from "../game/traffic-car";
import { InputState } from "../input/keyboard";
import { connectRoom, showRoomStatus, watchReadmission } from "../net/session";
import { RemoteCars } from "../net/remote-cars";
import type { PhysicsWorld } from "../physics/physics-world";
import { Autopilot } from "../playtest/autopilot";
import { Navigator } from "../playtest/navigator";
import type { PlaytestView } from "../playtest/navigator";
import { installAerialFog } from "../render/aerial-fog";
import { MarineSky } from "../render/marine-sky";
import { DayNight } from "../render/day-night";
import { setGradeMotion } from "../render/grade";
import { FarTerrain } from "../render/far-terrain";
import { LandmarkSilhouettes } from "../render/landmark-silhouette";
import { releaseDeferredArrays } from "../render/gpu-only-geometry";
import { FULL_QUALITY, isCoarsePointer } from "../render/quality";
import type { QualityFeatures } from "../render/quality";
import { Sky } from "../render/sky";
import { installToonShading } from "../render/toon";
import {
  CAMERA,
  CAR,
  FARE,
  MP_ROOM,
  MPH_FACTOR,
  NET_TICK_HZ,
  WORLD_H,
  WORLD_HALF_X,
  WORLD_HALF_Z,
  WORLD_W,
} from "../shared/constants";
import { isFiniteJsonNumber, isJsonObject, isJsonString, parseJsonText } from "../shared/json";
import { Rng } from "../shared/rng";
import type { GameMode } from "../shared/types";
import { STAGE_MARGIN } from "../trailer/scout";
import { GaragePreview } from "../ui/garage-preview";
import { Hud } from "../ui/hud";
import { MapOverlay } from "../ui/map-overlay";
import type { Minimap, MinimapMarker } from "../ui/minimap";
import { setTouchPlaying, setupTouch } from "../ui/touch";
import type { TouchControls } from "../ui/touch";
import type { Car, CarInput } from "../vehicle/car";
import type { CityModel, Garage } from "../world/city";
import { HECKLES, SpeechBubbles, TRAFFIC_QUIPS } from "../fx/speech-bubbles";
import type { TrafficQuip } from "../fx/speech-bubbles";
import { ROBOTAXI_SKINS, skinById, skinModelUrl } from "../vehicle/car";
import { districtAt, landFactor } from "../world/sf-map";
import { CeilingIndex, deckCeilings, harvestCeilingSpans, SolidIndex } from "../world/solid-index";
import { loadWorld } from "./world-loader";
import type { WorldCoreSystems, WorldSpawn } from "./world-loader";

const HALF_PI = Math.PI / 2;

const GARAGE_PREFETCH_DIST = 140;

const clampToPlayArea = (v: number, half: number) =>
  Math.min(half - STAGE_MARGIN, Math.max(-(half - STAGE_MARGIN), v));

const SHORE_TEX_N = 256;
const SHORE_SPAN = 1.12;

const buildShoreTexture = () => {
  const n = SHORE_TEX_N;
  const data = new Uint8Array(n * n);

  for (let iz = 0; iz < n; iz += 1) {
    const v = (iz / (n - 1) - 0.5) * SHORE_SPAN + 0.5;

    for (let ix = 0; ix < n; ix += 1) {
      const u = (ix / (n - 1) - 0.5) * SHORE_SPAN + 0.5;
      data[iz * n + ix] = Math.round(THREE.MathUtils.clamp(landFactor(u, v), 0, 1) * 255);
    }
  }

  const tex = new THREE.DataTexture(data, n, n, THREE.RedFormat, THREE.UnsignedByteType);
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearFilter;
  tex.needsUpdate = true;

  return tex;
};

const OC_FRES_MAX = 0.6;
const OC_SHALLOW_REFLECT = 0.62;
const OC_PATH_NEAR = 90;
const OC_PATH_FAR = 1100;
const OC_TRACK_EXP_NEAR = 3.5;
const OC_TRACK_EXP_FAR = 15;
const OC_TIGHT_GAIN = 7;
const OC_BROAD_EXP_NEAR = 400;
const OC_BROAD_EXP_FAR = 30;
const OC_BROAD_GAIN_FAR = 4.2;
const OC_OFF_AXIS_FLOOR = 0.15;
const OC_GLINT_GAIN = 3.6;
const OC_SUN_GAIN = 1.35;
const OC_SAT_NEAR = 60;
const OC_SAT_FULL = 480;
const OC_SAT_OUT = 900;
const OC_SAT_GONE = 1900;
const OC_PRESAT = 1.35;
const OC_SKY_NEAR = 800;
const OC_SKY_FAR = 2500;
const OC_SUN_FADE_LO = 0.62;
const OC_SUN_FADE_HI = 1;
const AMBIENCE_HZ = 4;

const SHORE_PROBES: readonly { x: number; z: number }[] = Array.from({ length: 8 }, (_, i) => {
  const a = (i / 8) * Math.PI * 2;

  return { x: Math.sin(a) * 110, z: Math.cos(a) * 110 };
});

const GATE_POS = new THREE.Vector3((0.27 - 0.5) * WORLD_W, 30, (0.02 - 0.5) * WORLD_H);

const PARKED_MARKER_STRIDE = 5;
const PARKED_MARKER_CAP = 420;

const parkedMarkers = (city: CityModel) => {
  const out: Beacon[] = [];
  const specs = city.parkedCarSpecs;

  for (let i = 0; i < specs.length && out.length < PARKED_MARKER_CAP; i += PARKED_MARKER_STRIDE) {
    const s = specs[i];

    if (!s) {
      continue;
    }

    out.push({ color: 0xff_b3_47, size: 0.85, x: s.x, y: city.heightAt(s.x, s.z) + 0.65, z: s.z });
  }

  return out;
};

const SUN_DIR = new THREE.Vector3().setFromSphericalCoords(
  1,
  THREE.MathUtils.degToRad(90 - 32),
  THREE.MathUtils.degToRad(150),
);

const CONTACT_R = 2.6;
const NEAR_MISS_MIN = 2.8;
const NEAR_MISS_MAX = 4.6;
const NEAR_MISS_SPEED = 22;
const CRASH_THRESHOLD = 7;
const COUNTDOWN_STEP = 0.45;
const BEST_KEY = "crazy-waymo:best";
const SOUND_KEY = "crazy-waymo:sound";
const HINT_DRIFT_KEY = "crazy-waymo:hint-drift";
const HINT_BOOST_KEY = "crazy-waymo:hint-boost";

const LAMP_GLOW_BUDGET = { cap: 150, poolScale: 0.75 } as const;
const ARRIVE_DISTANCE = 4;
const ARRIVE_SPEED = 2;
const HUD_HZ = 30;
const SKY_REBAKE_PHASE = 8e-4;
const SKY_BAKE_SIZE = 256;

const TIER_HEX = new Map<string, string>();

const tierHex = (tier: Parameters<typeof tierColor>[0]) => {
  const hit = TIER_HEX.get(tier);

  if (hit !== undefined) {
    return hit;
  }

  const s = `#${tierColor(tier).toString(16).padStart(6, "0")}`;
  TIER_HEX.set(tier, s);

  return s;
};

const storageGet = (key: string) => {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
};

const storedSkinIds = (raw: string | null) => {
  if (raw === null || raw === "") {
    return [];
  }

  try {
    const parsed = parseJsonText(raw);

    return Array.isArray(parsed) ? parsed.filter(isJsonString) : [];
  } catch {
    return [];
  }
};

const storageSet = (key: string, value: string) => {
  try {
    window.localStorage.setItem(key, value);

    return true;
  } catch {
    return false;
  }
};

const startBannerStats = (best: number) =>
  best > 0
    ? `BEST $${best.toLocaleString("en-US")}`
    : `Chain drop-offs to run the combo up to ${FARE.comboMax}×.`;

const SPAWN_KEY = "crazy-waymo:spawn";

const devParams = import.meta.env.DEV ? new URLSearchParams(window.location.search) : null;
const DEV_ROOM = devParams?.get("room") ?? "";
const DEV_ONLINE = devParams?.has("online") === true;
const DEV_ONLINE_START_SEED = 1;

const parseSpawn = (raw: string | null) => {
  if (raw === null || raw === "") {
    return null;
  }

  try {
    const value = parseJsonText(raw);

    if (!isJsonObject(value)) {
      return null;
    }

    const { x, z, yaw, gx, gz } = value;

    return isFiniteJsonNumber(x) &&
      isFiniteJsonNumber(z) &&
      isFiniteJsonNumber(yaw) &&
      isFiniteJsonNumber(gx) &&
      isFiniteJsonNumber(gz)
      ? { gx, gz, x, yaw, z }
      : null;
  } catch {
    return null;
  }
};

const readBest = () => {
  const raw = storageGet(BEST_KEY);
  const n = raw === null ? 0 : Number(raw);

  return Number.isFinite(n) ? n : 0;
};

const roundNet = (v: number) => Math.round(v * 100) / 100;
const roundVel = (v: number) => Math.round(v * 10) / 10;

export interface TrailerStage {
  readonly car: Car;
  readonly city: CityModel;
  readonly traffic: Traffic;
  readonly fares: FareManager;
  readonly cones: SmashCones;
  readonly hud: Hud;
  readonly state: GameState;
  readonly camera: THREE.PerspectiveCamera;
  /** Teleport the taxi to an exact world pose (y overrides the drive surface —
   *  elevated decks) with a pre-rolled speed along the heading. */
  placeCar: (x: number, z: number, yaw: number, speed: number, y?: number) => void;
  /** Instantly set the taxi's planar speed along its current heading. */
  setSpeed: (speed: number) => void;
  /** Snap the chase rig behind the car (for chase-cam scenes). */
  snapCamera: () => void;
  /** true = the director owns the camera; false = the game's chase rig. */
  setFreecam: (on: boolean) => void;
  /** Scripted pedals/steer override; null returns control to the keyboard. */
  setScriptedInput: (input: CarInput | null) => void;
  /** Per-frame choreography slot, run inside the game loop after the physics
   *  step and before the draw. The trailer shell's own rAF fires AFTER the
   *  renderer's animation loop, so a camera placed from there frames the car's
   *  PREVIOUS position; with physics on a fixed 60Hz step and the display at
   *  120 the two then advance on alternate frames and the car square-waves
   *  ~0.7u toward and away from the lens. dt is seconds. */
  setFrameHook: (fn: ((dt: number) => void) | null) => void;
  /** Pin the day-night cycle (0.25 noon, 0.40 golden, 0.47 sunset). */
  setDayPhase: (p: number) => void;
  /** Fake multiplayer robotaxis (visual-only remote cars); null = live map. */
  setFakePlayers: (players: PlayerMap | null) => void;
  setFxDim: (dim: number) => void;
  /** Re-park every punted parked car at its curb spec (fresh row per scene). */
  restoreParked: () => void;
  /** Stage `n` parked cars as a curbside row from (x0, z0) along (tx, tz) —
   *  the traffic-chaos plow toy (natural curb rows never exceed ~3 cars). */
  stageParkedRow: (
    x0: number,
    z0: number,
    tx: number,
    tz: number,
    n: number,
    spacing: number,
  ) => void;
  /** Build + unmute the audio graph. Driven by the trailer's first-gesture
   *  hook: the trailer rolls unattended, so a context created at staging time
   *  would stay suspended by the browser. */
  unlockAudio: () => void;
  setGameplayHud: (visible: boolean) => void;
  setCommentary: (visible: boolean) => void;
  /** Stage an existing NPC line on a real fleet car, using the normal bubbles. */
  sayTraffic: (car: TrafficCar, quip: TrafficQuip) => void;
  /** Open the garage showroom over the shot with its pad markers. Every skin
   *  equips without a purchase and nothing reaches saved progress. */
  openShowroom: () => Promise<void>;
  closeShowroom: () => void;
  /** Put the taxi back in a skin between takes (session only). */
  wearSkin: (skinId: string) => void;
}

const LANDING_RING_AIR = 0.35;
const LANDING_RING_IMPACT = 9;

export class GameScene {
  readonly scene = new THREE.Scene();
  private readonly mobileUi = isCoarsePointer();
  private readonly rig: ChaseCamera;
  private readonly cache = new ModelCache();
  private readonly input = new InputState();
  private readonly hud = new Hud(this.mobileUi);
  private readonly fx = new Fx();
  private readonly sfx = new Sfx();
  private readonly state = new GameState();

  private net: MultiplayerClient | null = null;
  private remoteCars: RemoteCars | null = null;
  private readonly bubbles = new SpeechBubbles();
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
  private showroomLoad: Promise<void> | null = null;
  private readonly ownedSkins = new Set<string>(["waymo"]);
  private readonly netRate = new FixedRate(NET_TICK_HZ);
  private netAt = 0;
  private readonly netInfoEl = document.querySelector("#netinfo");

  private city: CityModel | null = null;
  private car: Car | null = null;
  private fares: FareManager | null = null;
  private traffic: Traffic | null = null;
  private signalLights: SignalLights | null = null;
  private skids: SkidMarks | null = null;
  private debris: Debris | null = null;
  private readonly speedLines = this.mobileUi ? new SpeedLines() : null;
  private readonly clouds = new SkyClouds(this.mobileUi);
  private readonly marineSky = new MarineSky();
  private trails: DriftTrails | null = null;
  private readonly vehicleFx = new VehicleFxRig(
    this.fx,
    () => this.trails,
    () => this.skids,
  );
  private readonly wheelSurfaceAt = (x: number, z: number, y: number) =>
    this.city?.surfaceKindAt(x, z, y) ?? "road";
  private readonly shocks = new Shockwaves();
  private readonly impactStars = new ImpactStars();
  private readonly harbor = new Harbor();
  private readonly oceanTime = { value: 0 };
  private readonly dayNight: DayNight;
  private lampGlow: LampGlow | null = null;
  private cones: SmashCones | null = null;
  private parked: ParkedCars | null = null;
  private minimap: Minimap | null = null;
  private mapOverlay: MapOverlay | null = null;
  private readonly mapNav = new Navigator(() => this.playtestView());
  private readonly mapPilot = new Autopilot();
  private ambient: AmbientLife | null = null;
  private beacons: BeaconLights | null = null;
  private readonly vehicleLights = new VehicleLights();
  private readonly farTerrain = new FarTerrain();
  private readonly landmarkSilhouettes = new LandmarkSilhouettes();
  private readonly sceneFog: THREE.Fog;

  private readonly sun = new THREE.DirectionalLight(0xff_f2_d8, 2);
  private readonly hemi = new THREE.HemisphereLight(0xbf_e0_ff, 0x4a_4a_3e, 0.35);
  private readonly sky: Sky;
  private quality: QualityFeatures = FULL_QUALITY;
  private renderer: THREE.WebGLRenderer | null = null;
  private skyBakeRT: THREE.WebGLCubeRenderTarget | null = null;
  private skyBakeCam: THREE.CubeCamera | null = null;
  private skyBakedPhase = -1;
  private hudAcc = 0;
  private readonly mmMarkers: MinimapMarker[] = [];
  private readonly scrSnapDir = new THREE.Vector3();
  private readonly scrRight = new THREE.Vector3();
  private readonly scrToGate = new THREE.Vector3();
  private ambienceAcc = 0;
  private readonly scrSnapRight = new THREE.Vector3();
  private readonly scrSnapUp = new THREE.Vector3();
  private readonly scrSnapAnchor = new THREE.Vector3();
  private shadowExtent = 58;
  private mode: GameMode = { kind: "loading", progress: 0 };
  ready: Promise<void> = Promise.resolve();
  private finishStage = "DOWNLOADING THE CITY…";
  get isReady() {
    return this.loadDone;
  }

  get modeKind() {
    return this.mode.kind;
  }

  private paused = false;
  private frame = 0;

  /** Wrapper asked us to pause: freeze the sim (update() runs only the net
   *  from here) and kill the continuous engine/screech/scrape/boost loops so
   *  nothing drones on under the overlay. */
  requestPause() {
    if (this.paused) {
      return;
    }

    this.paused = true;
    this.mapOverlay?.close();
    this.sfx.stopEngine();
    this.sfx.pause();
    this.musicPausedByWrapper = this.mode.kind === "playing" || this.mode.kind === "countdown";

    if (this.musicPausedByWrapper) {
      this.sfx.stopMusic();
    }
  }

  /** Wrapper resume: update() picks the loops back up on its own next frame. */
  requestResume() {
    if (!this.paused) {
      return;
    }

    this.paused = false;
    this.sfx.resume();

    if (this.musicPausedByWrapper) {
      this.musicPausedByWrapper = false;
      this.sfx.startMusic();
    }
  }
  private musicPausedByWrapper = false;

  rebuildStreets() {
    const { city } = this;

    if (!city) {
      return;
    }

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

  private rebuildSignalLights() {
    if (this.signalLights) {
      this.scene.remove(this.signalLights.mesh);
      this.signalLights.dispose();
      this.signalLights = null;
    }

    const { city } = this;

    if (!city) {
      return;
    }

    this.signalLights = new SignalLights(city.network, (x, z) => city.heightAt(x, z));
    this.scene.add(this.signalLights.mesh);
  }

  editorLighting = false;
  enableEditorLighting() {
    this.editorLighting = true;
    this.dayNight.setPhase(0.25);
  }
  private loadDone = false;
  private pendingStart = false;
  private readonly touchUi: boolean = false;
  private readonly touch: TouchControls | null = null;
  private titleT = 0;
  private flameAccum = 0;
  private scrapeFrames = 0;
  private wasBoosting = false;
  private wasFloating = false;
  private wasAirborne = false;
  private boostWasFull = true;
  private lastPatience = 1;
  private lastDriftTier: 0 | 1 | 2 = 0;
  private countdownShown = -1;
  private readonly camFrom = new THREE.Vector3();
  private hintDriftShown = storageGet(HINT_DRIFT_KEY) !== null;
  private hintBoostShown = storageGet(HINT_BOOST_KEY) !== null;
  private turnHold = 0;
  private solidIndex: SolidIndex | null = null;
  private physics: PhysicsWorld | null = null;
  private hitStop = 0;
  private spawn: WorldSpawn = { gx: 0, gz: 0, x: 0, yaw: 0, z: 0 };
  private lastDistrict = "";
  private readonly scrArrow = new THREE.Vector3();
  freecam = false;
  private readonly trailerMode: boolean;

  constructor(aspect: number, trailerMode = false) {
    this.trailerMode = trailerMode;
    this.rig = new ChaseCamera(aspect);

    watchControlContext(() => {
      if (this.mode.kind === "title") {
        this.toTitle();
      }
    });

    installAerialFog();
    installToonShading();

    const sky = new Sky();
    sky.scale.setScalar(12_000);
    const su = sky.material.uniforms;

    const setU = (name: string, value: number) => {
      const u = su[name];

      if (u) {
        u.value = value;
      }
    };

    setU("turbidity", 2.5);
    setU("rayleigh", 1.1);
    setU("mieCoefficient", 0.003);
    setU("mieDirectionalG", 0.85);
    const sunU = su.sunPosition;

    if (sunU && sunU.value instanceof THREE.Vector3) {
      sunU.value.copy(SUN_DIR);
    }

    sky.renderOrder = -2;
    this.scene.add(sky);
    this.sky = sky;
    this.scene.add(this.farTerrain.mesh);
    this.scene.add(this.landmarkSilhouettes.object);
    this.scene.add(this.vehicleLights.group);
    this.scene.add(this.bubbles.group);

    const fog = new THREE.Fog(0xbc_d7_ea, 420, 960);
    this.scene.fog = fog;
    this.sceneFog = fog;

    this.scene.add(this.hemi);
    const ambient = new THREE.AmbientLight(0xff_ff_ff, 0.08);
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

    const oceanMat = new THREE.MeshStandardMaterial({
      color: 0x2e_7f_c0,
      metalness: 0.3,
      roughness: 0.32,
    });

    const { oceanTime } = this;
    const shoreTex = buildShoreTexture();
    const oceanSunDir = { value: new THREE.Vector3(0, 1, 0) };
    const oceanSunCol = { value: new THREE.Color(0x00_00_00) };
    const oceanDayW = { value: 1 };
    const spanX = (WORLD_W * SHORE_SPAN).toFixed(1);
    const surfFull = ((0.09 - 0.5) * WORLD_W).toFixed(1);
    const surfNone = ((0.28 - 0.5) * WORLD_W).toFixed(1);
    const spanZ = (WORLD_H * SHORE_SPAN).toFixed(1);
    oceanMat.onBeforeCompile = (shader) => {
      shader.uniforms.uOceanTime = oceanTime;
      shader.uniforms.uShore = { value: shoreTex };
      shader.uniforms.uOcSunDir = oceanSunDir;
      shader.uniforms.uOcSunCol = oceanSunCol;
      shader.uniforms.uOcDayW = oceanDayW;
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
uniform vec3 uOcSunDir;
uniform vec3 uOcSunCol;
uniform float uOcDayW;
varying vec3 vOceanPos;
// Cross-stage scratch: written in the color block, read by the Fresnel cap
// and the sun-path/dissolve blocks further down the template.
float ocShallowG = 0.0;
float ocViewDistG = 0.0;
float ocHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float ocNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = p - i;
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(ocHash(i), ocHash(i + vec2(1.0, 0.0)), u.x),
    mix(ocHash(i + vec2(0.0, 1.0)), ocHash(i + vec2(1.0, 1.0)), u.x),
    u.y);
}
// One Gerstner wave's contribution to the surface derivatives, evaluated at
// the undisplaced position: xz are the normal-tilt terms (dir * w*A * cos),
// y is the crest-pinch term (q*w*A * sin) that approaches 1 where the
// trochoid sharpens. d must be normalized; wa = w*A, qwa = q*w*A.
vec3 ocWave(vec2 d, float w, float wa, float qwa, float sp, vec2 p, float t) {
  float th = w * dot(d, p) - sp * t;
  return vec3(d.x * wa * cos(th), qwa * sin(th), d.y * wa * cos(th));
}
// Four waves: one long primary swell, a secondary at ~50 degrees, and two
// shorter cross-chops. Frequencies/speeds sit in the same band as the old
// sine fields so the overall tempo of the shimmer is unchanged.
vec3 ocGerstner(vec2 p, float t) {
  return ocWave(vec2(0.94, 0.34), 0.042, 0.34, 0.26, 0.55, p, t)
       + ocWave(vec2(0.81, -0.59), 0.071, 0.30, 0.20, 0.83, p, t)
       + ocWave(vec2(0.99, 0.10), 0.118, 0.24, 0.13, 1.22, p, t)
       + ocWave(vec2(0.56, 0.83), 0.157, 0.18, 0.08, 1.61, p, t);
}`,
        )
        .replace(
          "#include <normal_fragment_begin>",
          `#include <normal_fragment_begin>
          {
            vec3 g = ocGerstner(vOceanPos.xz, uOceanTime);
            // Dividing the tilt by (1 - pinch) is what makes this read as
            // Gerstner rather than summed sines: the normal steepens sharply
            // at crests and flattens across troughs, so highlights collect
            // in thin bright lines instead of soft interference blobs.
            // Flatten the swell only where one pixel already spans 2-14u —
            // out there the steepened normal is pure specular banding. Inside
            // ~300u this term is 1 and the crest lines are untouched.
            float ocPxN = fwidth(vOceanPos.x) + fwidth(vOceanPos.z);
            float ocFlat = 1.0 - smoothstep(2.0, 14.0, ocPxN);
            normal = normalize(normal + vec3(-g.x, 0.0, -g.z) * (0.28 * ocFlat / max(1.0 - g.y, 0.35)));
          }`,
        )
        .replace(
          "#include <color_fragment>",
          `#include <color_fragment>
          {
            vec2 wp = vOceanPos.xz;
            float t = uOceanTime;
            ocViewDistG = length(vOceanPos - cameraPosition);
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
            ocShallowG = shallow;
            diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.36, 0.78, 0.72), shallow * 0.75);
            // Lapping foam: an animated band just off the waterline plus a
            // solid white line hugging it. The visible waterline sits near
            // s ≈ 0.40 (terrain crosses the ocean plane there), so both bands
            // live below that, not at the land-mask 0.5 edge.
            float lap = 0.5 + 0.5 * sin(t * 1.7 + (wp.x + wp.y) * 0.16 + s * 30.0);
            float foam = smoothstep(0.26, 0.38, s) * (0.30 + 0.45 * lap);
            foam += smoothstep(0.36, 0.42, s) * 0.9;
            // OCEAN BEACH SURF. The Pacific side gets breakers the bay never
            // does: three swell lines whose phase marches up the shore
            // gradient, so they travel inshore and pile up at the waterline.
            // Weighted west of the peninsula only — the bay stays glassy,
            // which is also what SF actually looks like.
            float ocean = 1.0 - smoothstep(${surfFull}, ${surfNone}, wp.x);
            // The whole Ocean Beach shore gradient is only ~45u wide, so the
            // set has to live in almost all of it to read at all.
            float march = fract(s * 4.0 - t * 0.11);
            float crestLine = smoothstep(0.55, 0.93, march) * (1.0 - smoothstep(0.93, 1.0, march));
            float inSurf = smoothstep(0.03, 0.14, s) * (1.0 - smoothstep(0.33, 0.42, s));
            foam += crestLine * inSurf * ocean * 1.6;
            // Whitewater: the shore break itself never goes back to open blue.
            foam += smoothstep(0.20, 0.40, s) * ocean * 0.55;
            // Sun glints: HASH twinkles — sparse random cells that flicker in
            // and out. (The old sine-product crossings landed on a visible
            // regular lattice: the "grid of white dots" read.)
            // Pixel footprint in world units. Past ~one glint cell per pixel
            // the 2.38u lattice stops reading as sparkle and starts reading as
            // a regular dot grid across the mid-distance bay — the moire was
            // this term, not the Gerstner normals (their 40-150u wavelengths
            // cannot alias).
            float ocPx = fwidth(wp.x) + fwidth(wp.y);
            float ocSharp = 1.0 - smoothstep(0.5, 1.35, ocPx * 0.42);
            vec2 gcell = floor(wp * 0.42);
            float seed = ocHash(gcell);
            float tw = fract(seed * 7.13 + t * (0.10 + seed * 0.14));
            float glint = smoothstep(0.965, 0.995, seed) * smoothstep(0.30, 0.5, tw) * smoothstep(0.7, 0.5, tw);
            // Sub-cell jitter so lit cells read as points, not squares.
            vec2 sub = fract(wp * 0.42) - vec2(ocHash(gcell + 19.7), ocHash(gcell + 7.3));
            glint *= smoothstep(0.30, 0.08, length(sub));
            // Glints favor wave crests (and crests pick up a faint sheen),
            // so the sparkle travels with the swell instead of sitting in a
            // static random field.
            float crest = smoothstep(0.15, 0.60, ocGerstner(wp, t).y);
            glint *= 0.35 + 0.65 * crest;
            diffuseColor.rgb *= 1.0 + crest * 0.05;
            diffuseColor.rgb += vec3(glint * 3.2 * ocSharp);
            diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.93, 0.97, 0.98), clamp(foam, 0.0, 0.9));
          }`,
        )
        .replace(
          "#include <lights_fragment_end>",
          `#include <lights_fragment_end>
          {
            // FRESNEL CAP: scale the accumulated env reflection so the
            // effective grazing response tops out at OC_FRES_MAX instead of
            // the physical 1.0, and hand shallows back their body color.
            float ocP5 = pow(1.0 - saturate(dot(geometryNormal, geometryViewDir)), 5.0);
            float ocCap = (0.02 + ${OC_FRES_MAX.toFixed(2)} * ocP5) / (0.02 + 0.98 * ocP5);
            reflectedLight.indirectSpecular *=
              ocCap * mix(1.0, ${OC_SHALLOW_REFLECT.toFixed(2)}, ocShallowG);
          }`,
        )
        .replace(
          "#include <opaque_fragment>",
          `{
            // THE SUN PATH (kart-royale water, re-derived for exposure 0.62):
            // three hand-clamped lobes stretched along the sun azimuth. The
            // tight lobe rides the real Gerstner normals near the camera; the
            // broad lobe stands in for the flattened far wavelets; the glint
            // lobe is hash-grid sparkle so the far lane stays points of
            // light, not airbrush. Cats-paw streaks modulate the whole lane.
            vec3 ocV = normalize(cameraPosition - vOceanPos);
            vec3 ocN = normalize((vec4(normal, 0.0) * viewMatrix).xyz);
            float ocFlat01 = smoothstep(${OC_PATH_NEAR.toFixed(1)}, ${OC_PATH_FAR.toFixed(1)}, ocViewDistG);
            float ocNdl = saturate(dot(ocN, uOcSunDir));
            float ocNdh = saturate(dot(ocN, normalize(ocV + uOcSunDir)));
            vec3 ocR = reflect(-ocV, ocN);
            vec2 ocRxz = ocR.xz / max(length(ocR.xz), 1e-4);
            vec2 ocSxz = uOcSunDir.xz / max(length(uOcSunDir.xz), 1e-4);
            float ocTrack = pow(max(dot(ocRxz, ocSxz), 0.0),
              mix(${OC_TRACK_EXP_NEAR.toFixed(1)}, ${OC_TRACK_EXP_FAR.toFixed(1)}, ocFlat01));
            float ocStreak = 0.72
              + 0.28 * sin(dot(vOceanPos.xz, vec2(0.86, 0.51)) * 0.013 + uOceanTime * 0.09)
                     * sin(dot(vOceanPos.xz, vec2(-0.51, 0.86)) * 0.021 - uOceanTime * 0.05);
            float ocTight = pow(ocNdh, 1500.0) * ocNdl * ${OC_TIGHT_GAIN.toFixed(1)} * (1.0 - ocFlat01);
            float ocBroad = pow(ocNdh, mix(${OC_BROAD_EXP_NEAR.toFixed(1)}, ${OC_BROAD_EXP_FAR.toFixed(1)}, ocFlat01))
              * ocNdl * mix(1.0, ${OC_BROAD_GAIN_FAR.toFixed(1)}, ocFlat01);
            ocBroad *= (${OC_OFF_AXIS_FLOOR.toFixed(2)} + ${(1 - OC_OFF_AXIS_FLOOR).toFixed(2)} * ocTrack) * ocStreak;
            float ocGlint = pow(ocNdh, mix(240.0, 70.0, ocFlat01))
              * step(0.82, ocHash(floor(vOceanPos.xz * 0.06)))
              * ${OC_GLINT_GAIN.toFixed(1)} * ocFlat01 * (0.12 + 0.88 * ocTrack);
            outgoingLight += uOcSunCol * (ocTight + ocBroad + ocGlint);
            // PRE-SATURATION against the fog's chroma drain, banded to the
            // exact range the drain works over, then clamped: negative
            // radiance from the extrapolation would detonate bloom.
            float ocBand = smoothstep(${OC_SAT_NEAR.toFixed(1)}, ${OC_SAT_FULL.toFixed(1)}, ocViewDistG)
              * (1.0 - smoothstep(${OC_SAT_OUT.toFixed(1)}, ${OC_SAT_GONE.toFixed(1)}, ocViewDistG));
            float ocLum = dot(outgoingLight, vec3(0.2126, 0.7152, 0.0722));
            outgoingLight = max(
              mix(vec3(ocLum), outgoingLight, 1.0 + ${OC_PRESAT.toFixed(2)} * ocBand * uOcDayW),
              vec3(0.0));
          }
          #include <opaque_fragment>`,
        )
        .replace(
          "#include <fog_fragment>",
          `#include <fog_fragment>
          #ifdef USE_FOG
            // HORIZON DISSOLVE: walk the last 8% (aerial-fog FOG_MAX residual)
            // onto hazeColor — the exact asymptote the fog chunk above was
            // converging to, marine layer included — so sea and sky meet on
            // the same number and the seam has nothing left to be.
            gl_FragColor.rgb = mix(gl_FragColor.rgb, hazeColor,
              smoothstep(${OC_SKY_NEAR.toFixed(1)}, ${OC_SKY_FAR.toFixed(1)}, ocViewDistG));
          #endif`,
        );
    };

    const ocean = new THREE.Mesh(new THREE.PlaneGeometry(9000, 9000), oceanMat);
    ocean.rotation.x = -HALF_PI;
    ocean.position.y = SEA_Y;
    ocean.onBeforeRender = () => {
      const dayW =
        1 - THREE.MathUtils.smoothstep(this.dayNight.lamp, OC_SUN_FADE_LO, OC_SUN_FADE_HI);

      oceanDayW.value = dayW;
      oceanSunDir.value.copy(this.dayNight.sunOffset).normalize();
      oceanSunCol.value
        .copy(this.sun.color)
        .multiplyScalar(this.sun.intensity * OC_SUN_GAIN * dayW);
    };

    this.scene.add(ocean);

    this.fx.addTo(this.scene);

    if (this.speedLines) {
      this.scene.add(this.speedLines.object3D);
    }

    this.scene.add(this.clouds.group);
    this.scene.add(this.marineSky.mesh);
    this.scene.add(this.shocks.group);
    this.scene.add(this.impactStars.group);
    this.scene.add(this.harbor.group);

    this.dayNight = new DayNight({
      ambient,
      fog,
      hemi: this.hemi,
      scene: this.scene,
      sky: this.sky,
      sun: this.sun,
    });
    this.touch = setupTouch(this.input, () => {
      if (this.mode.kind === "playing") {
        this.openChat();
      }
    });
    this.touchUi = this.touch.isTouch;
    window.addEventListener("keydown", (e) => {
      if (e.key !== "Tab" || e.repeat || this.input.typing || this.paused) {
        return;
      }

      if (this.mapOpen) {
        e.preventDefault();
        this.mapOverlay?.close();
      } else if (this.mode.kind === "playing") {
        e.preventDefault();
        this.openMap();
      }
    });
    this.hud.onCta(() => {
      this.handleStartPress();
    });
    this.sfx.setMuted(storageGet(SOUND_KEY) !== "1");
  }

  get camera() {
    return this.rig.camera;
  }

  get sunLight() {
    return this.sun;
  }

  get shadowsOn() {
    return this.dayNight.shadowsActive;
  }

  applyQuality(q: QualityFeatures) {
    const prev = this.quality;
    this.quality = q;
    const r = this.renderer;

    if (r) {
      if (this.sun.castShadow !== q.shadowCast) {
        this.sun.castShadow = q.shadowCast;

        if (q.shadowCast) {
          r.shadowMap.needsUpdate = true;
        }
      }

      if (q.shadowCast && q.shadowEvery <= 1 && prev.shadowEvery > 1) {
        r.shadowMap.autoUpdate = this.dayNight.shadowsActive || !this.sun.shadow.map;
        r.shadowMap.needsUpdate = true;
      }
    }

    this.clouds.setQuality(q.clouds);

    if (!q.skyBake && prev.skyBake) {
      this.dayNight.setBakedBackground(null);
      this.skyBakedPhase = -1;
    }
  }

  getCity() {
    return this.city;
  }
  getCache() {
    return this.cache;
  }

  applyEnvironment(renderer: THREE.WebGLRenderer) {
    const SIZE = 64;
    const SKY_TOP = "#7fb2e0";
    const HORIZON = "#dde6ea";
    const WARM = "#f2ddc4";
    const GROUND = "#55534a";

    const face = (paint: (g: CanvasRenderingContext2D) => void) => {
      const c = document.createElement("canvas");
      c.width = SIZE;
      c.height = SIZE;
      const g = c.getContext("2d");

      if (g) {
        paint(g);
      }

      return c;
    };

    const flat = (color: string) =>
      face((g) => {
        g.fillStyle = color;
        g.fillRect(0, 0, SIZE, SIZE);
      });

    const sideGradient = (g: CanvasRenderingContext2D) => {
      const grad = g.createLinearGradient(0, 0, 0, SIZE);
      grad.addColorStop(0, SKY_TOP);
      grad.addColorStop(0.47, HORIZON);
      grad.addColorStop(0.56, WARM);
      grad.addColorStop(0.66, "#9b8d78");
      grad.addColorStop(1, GROUND);
      g.fillStyle = grad;
      g.fillRect(0, 0, SIZE, SIZE);
    };

    const side = () => face(sideGradient);

    const sunSide = () =>
      face((g) => {
        sideGradient(g);

        const lobe = g.createRadialGradient(
          SIZE * 0.5,
          SIZE * 0.42,
          0,
          SIZE * 0.5,
          SIZE * 0.42,
          SIZE * 0.55,
        );

        lobe.addColorStop(0, "rgba(255, 240, 214, 0.45)");
        lobe.addColorStop(1, "rgba(255, 240, 214, 0)");
        g.fillStyle = lobe;
        g.fillRect(0, 0, SIZE, SIZE);
      });

    const cube = new THREE.CubeTexture([
      sunSide(),
      side(),
      flat(SKY_TOP),
      flat(GROUND),
      side(),
      side(),
    ]);

    cube.colorSpace = THREE.SRGBColorSpace;
    cube.needsUpdate = true;
    this.scene.environment = cube;
    this.scene.environmentIntensity = 0.32;
    this.dayNight.attachRenderer(renderer);
    this.renderer = renderer;
  }

  private maybeBakeSky() {
    if (!this.quality.skyBake) {
      return;
    }

    const r = this.renderer;

    if (!r) {
      return;
    }

    const p = this.dayNight.getPhase();

    if (this.skyBakedPhase >= 0) {
      const d = Math.abs(p - this.skyBakedPhase);

      if (Math.min(d, 1 - d) < SKY_REBAKE_PHASE) {
        return;
      }
    }

    let rt = this.skyBakeRT;
    let cam = this.skyBakeCam;

    if (!rt || !cam) {
      rt = new THREE.WebGLCubeRenderTarget(SKY_BAKE_SIZE, {
        generateMipmaps: false,
        magFilter: THREE.LinearFilter,
        minFilter: THREE.LinearFilter,
        type: THREE.HalfFloatType,
      });
      cam = new THREE.CubeCamera(1, 20_000, rt);
      this.skyBakeRT = rt;
      this.skyBakeCam = cam;
    }

    const wasVisible = this.sky.visible;
    const tone = r.toneMapping;
    r.toneMapping = THREE.NoToneMapping;
    this.sky.visible = true;
    const tmp = new THREE.Scene();
    tmp.add(this.sky);
    cam.position.set(0, 0, 0);
    cam.update(r, tmp);
    this.scene.add(this.sky);
    this.sky.visible = wasVisible;
    r.toneMapping = tone;
    this.skyBakedPhase = p;
    this.dayNight.setBakedBackground(rt.texture);
  }

  async load() {
    if (DEV_ONLINE && !this.trailerMode) {
      this.start();
    }

    const loaded = await loadWorld({
      cache: this.cache,
      computeSpawn: (city) => this.computeSpawn(city),
      getCamera: () => this.rig.camera,
      getRenderer: () => this.renderer,
      glideLoading: (progress, seconds, label) => {
        this.mode = { kind: "loading", progress };
        this.hud.glideLoading(progress, seconds, label);
      },
      hideLoading: () => {
        this.hud.hideLoading();
      },
      lampGlowBudget: this.mobileUi ? LAMP_GLOW_BUDGET : null,
      onAmbient: (ambient, city) => {
        this.ambient = ambient;
        this.attachNightAndLife(city);
        this.rig.setCeilings(new CeilingIndex(deckCeilings(city.getDecks())));
      },
      onCones: (cones) => {
        this.cones = cones;
      },
      onCoreSystems: (systems) => {
        this.assignCoreSystems(systems);
      },
      onDebris: (debris) => {
        this.debris = debris;
      },
      onParked: (parked) => {
        this.parked = parked;
        parked.cullAll(this.rig.camera.position.x, this.rig.camera.position.z);
      },
      onPhysics: (physics) => {
        this.physics = physics;
      },
      onPlayable: () => {
        this.markLoadDone();
      },
      onTraffic: (traffic) => {
        this.traffic = traffic;
        this.rebuildSignalLights();
      },
      scene: this.scene,
      sceneFog: this.sceneFog,
      setLoading: (progress, label) => {
        this.mode = { kind: "loading", progress };
        this.hud.setLoading(progress, label);
      },
      setStage: (label) => {
        this.setFinishStage(label);
      },
      setupGarages: (city) => {
        this.setupGarages(city);
      },
      shadowlessWarmup: this.mobileUi ? this.sun : null,
      showTitle: () => {
        this.toTitle();
      },
      snapToCar: (car) => {
        this.rig.snapTo(car);
      },
    });

    const { city } = loaded;
    this.city = city;
    this.spawn = loaded.spawn;
    this.rig.setGround((x, z, y) => city.cameraFloorAt(x, z, y));
    this.skinId = loaded.skinId;
    this.car = loaded.car;
    this.ready = loaded.ready;
    void this.buildCeilingIndex(city, loaded.ready);
  }

  private async buildCeilingIndex(city: CityModel, ready: Promise<void>) {
    await ready;
    const t0 = performance.now();

    try {
      const spans = await harvestCeilingSpans(city.group, city.terrain, city.network, async () => {
        const { promise, resolve } = Promise.withResolvers<void>();
        setTimeout(resolve, 0);

        await promise;
      });

      spans.push(...deckCeilings(city.getDecks()));
      const index = new CeilingIndex(spans);
      this.rig.setCeilings(index);
      console.log(`[city] ceilings ${index.size} spans in ${Math.round(performance.now() - t0)}ms`);
    } finally {
      releaseDeferredArrays();
    }
  }

  private attachNightAndLife(city: CityModel) {
    this.ambient?.populatePerches(city.lampHeads);
    const beacons = new BeaconLights([...collectBeacons(), ...parkedMarkers(city)]);
    this.beacons = beacons;
    this.scene.add(beacons.group);
  }

  private setFinishStage(label: string) {
    this.finishStage = label;

    if (this.pendingStart && !this.loadDone) {
      this.hud.setCta(label);
    }
  }

  private assignCoreSystems(systems: WorldCoreSystems) {
    this.solidIndex = systems.solidIndex;
    this.fares = systems.fares;
    this.skids = systems.skids;
    this.trails = systems.trails;
    this.lampGlow = systems.lampGlow;
    this.minimap = systems.minimap;
    systems.minimap.onClick(() => {
      this.openMap();
    });
  }

  /** True while the full-screen map is up (Escape closes it, not pause). */
  get mapOpen() {
    return this.mapOverlay?.isOpen ?? false;
  }

  /** The corner minimap was clicked: open the whole city full screen. */
  openMap() {
    const { city } = this;

    if (this.mode.kind !== "playing" || !city) {
      return;
    }

    this.mapOverlay ??= new MapOverlay({
      decks: city.getDecks(),
      network: city.network,
      pick: (x, z) => {
        this.driveTo(x, z);
      },
      plan: city.plan,
      snapshot: () => ({
        carX: this.car?.position.x ?? 0,
        carZ: this.car?.position.z ?? 0,
        destination: this.mapNav.destination,
        heading: this.car?.heading ?? 0,
        markers: this.mmMarkers,
        route: this.mapNav.destination ? this.mapNav.remainingRoute : null,
      }),
    });
    this.sfx.ui("select");
    this.mapOverlay.open();
  }

  /** Hand the wheel to the autopilot until the taxi reaches this street point. */
  driveTo(x: number, z: number) {
    this.mapNav.destination = { x, z };
    this.hud.announceMinor("AUTOPILOT ENGAGED", "#6bff8e");
  }

  private stopAutopilot(message?: string) {
    if (!this.mapNav.destination) {
      return;
    }

    this.mapNav.destination = null;

    if (message !== undefined && message !== "") {
      this.hud.announceMinor(message, "#6bff8e");
    }
  }

  private autopilotInput(human: CarInput, car: Car) {
    if (!this.mapNav.destination) {
      return human;
    }

    if (human.throttle > 0 || human.brake > 0 || human.steer !== 0 || human.boost) {
      this.stopAutopilot("MANUAL CONTROL");

      return human;
    }

    const nav = this.mapNav.read();

    if (!nav) {
      this.stopAutopilot("NO ROUTE THERE");

      return human;
    }

    const speed = car.forwardSpeed;

    if (nav.routeDistance <= ARRIVE_DISTANCE) {
      if (Math.abs(speed) < ARRIVE_SPEED) {
        this.stopAutopilot("ARRIVED");

        return human;
      }

      return speed > 0
        ? { boost: false, brake: 1, steer: 0, throttle: 0 }
        : { boost: false, brake: 0, steer: 0, throttle: 1 };
    }

    return this.mapPilot.drive(
      {
        boostReady: false,
        nav,
        phase: this.mode.kind,
        speed,
        stuckSeconds: this.mapNav.stuckSeconds,
      },
      false,
    );
  }

  private closeMap() {
    this.mapOverlay?.close();
    this.stopAutopilot();
  }

  private markLoadDone() {
    this.loadDone = true;
    this.joinRoom();

    if (this.pendingStart) {
      this.pendingStart = false;
      this.start();
    }
  }

  private joinRoom() {
    const { city } = this;

    if (this.net || !city) {
      return;
    }

    const localTrailerPeers =
      import.meta.env.DEV &&
      this.trailerMode &&
      new URLSearchParams(window.location.search).has("trailer-online");

    const net = connectRoom({
      offline: (this.trailerMode && !localTrailerPeers) || isPlaytestRequested(),
      room: localTrailerPeers ? "crazy-waymo-trailer-local" : DEV_ROOM || MP_ROOM,
    });

    const remoteCars = new RemoteCars(this.cache, city, net.serverClock, (anchor, text) => {
      this.bubbles.say(anchor, text, { lift: 3 });
    });

    watchReadmission(net, () => {
      remoteCars.relearn();
    });
    this.scene.add(remoteCars.group);
    this.net = net;
    this.remoteCars = remoteCars;
  }

  resize(aspect: number, scalePx: number) {
    this.rig.resize(aspect);
    this.fx.setScale(scalePx);
  }

  private toTitle() {
    if (this.trailerMode) {
      return;
    }

    this.mode = { kind: "title" };
    setTouchPlaying(false);
    this.minimap?.setVisible(false);
    this.closeMap();
    this.hud.hideFareCard();
    this.hud.setArrow(false, 0, 0, 0);
    this.hud.setTimer(FARE.startTime, false);
    this.hud.setVignette(0);
    this.hud.setCombo(1, 0);
    const best = readBest();
    this.hud.setLanding(true);
    this.hud.showBanner({
      controls: bannerControls(),
      cta: this.touchUi ? "START DRIVING" : "START DRIVING ⏎",
      stats: startBannerStats(best),
      sub: "Pick up fares, chain combos, drive like a maniac.",
      title: "CRAZY WAYMO",
    });
  }

  private setupGarages(city: CityModel) {
    this.hud.setOperator(skinById(this.skinId).label, skinById(this.skinId).accent);

    for (const id of storedSkinIds(storageGet("crazy-waymo:skins-owned"))) {
      this.ownedSkins.add(id);
    }

    const rings = new THREE.Group();
    const ringGeo = new THREE.RingGeometry(4.4, 5.4, 28).rotateX(-Math.PI / 2);

    const ringMat = new THREE.MeshBasicMaterial({
      color: 0xff_a6_3d,
      depthWrite: false,
      opacity: 0.55,
      transparent: true,
    });

    for (const g of city.garages) {
      const ring = new THREE.Mesh(ringGeo, ringMat);
      ring.position.set(g.padX, city.heightAt(g.padX, g.padZ) + GROUND_RING_LIFT, g.padZ);
      rings.add(ring);
    }

    this.scene.add(rings);
    this.garageRings = rings;

    const pillarMat = new THREE.MeshBasicMaterial({
      color: 0xff_a6_3d,
      depthWrite: false,
      opacity: 0.4,
      side: THREE.DoubleSide,
      transparent: true,
    });

    const pillar = new THREE.Mesh(new THREE.CylinderGeometry(0.7, 0.7, 18, 12, 1, true), pillarMat);
    pillar.position.y = 9;
    this.scene.add(pillar);
    this.garagePillar = pillar;
  }

  private nearestGarage() {
    const { city } = this;
    const { car } = this;

    if (!city || !car) {
      return null;
    }

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

  private updateGarages(dt: number) {
    if (this.garageOpen) {
      this.garagePreview?.update(dt);
    }

    if (this.trailerMode) {
      return;
    }

    const { city } = this;
    const { car } = this;

    if (!city || !car || this.mode.kind !== "playing") {
      if (this.garageOpen) {
        this.closeGarage();
      }

      return;
    }

    const g = this.nearestGarage();

    if (!g) {
      return;
    }

    if (this.garagePillar) {
      this.garagePillar.position.set(g.padX, city.heightAt(g.padX, g.padZ) + 9, g.padZ);
      const pm = this.garagePillar.material;

      if (pm instanceof THREE.MeshBasicMaterial) {
        pm.opacity = 0.3 + 0.15 * Math.sin(performance.now() / 300);
      }
    }

    const d = Math.hypot(g.padX - car.position.x, g.padZ - car.position.z);

    if (d < GARAGE_PREFETCH_DIST) {
      void this.loadShowroom();
    }

    if (!this.garageOpen && d < 5.5 && car.speed < 4) {
      this.openGarage();
    } else if (this.garageOpen && d > 8) {
      this.closeGarage();
    }
  }

  private async loadShowroom() {
    this.showroomLoad ??= this.cache.preload(ROBOTAXI_SKINS.map(skinModelUrl), () => null);

    await this.showroomLoad;
  }

  private garageCardsHtml() {
    return ROBOTAXI_SKINS.map((sk) => {
      const owned = this.ownedSkins.has(sk.id) || sk.price === 0;
      const equipped = sk.id === this.skinId;
      let tag = `$${sk.price.toLocaleString("en-US")}`;
      let cls = "gcard";

      if (equipped) {
        tag = "EQUIPPED";
        cls = "gcard on";
      } else if (owned) {
        tag = "EQUIP";
        cls = "gcard owned";
      }

      return `<button class="${cls}" data-skin="${sk.id}"><canvas class="gprev" data-prev="${sk.id}"></canvas><b>${sk.label}</b><small>${sk.blurb}</small><span>${tag}</span></button>`;
    }).join("");
  }

  private openGarage() {
    this.garageOpen = true;
    this.sfx.ui("open");
    let el = this.garageEl;

    if (!el) {
      el = document.createElement("div");
      el.id = "garage";
      document.body.append(el);
      this.garageEl = el;
      let browsedSkin: string | undefined;

      const browse = (e: Event) => {
        const card = e.target instanceof Element ? e.target.closest("[data-skin]") : null;

        if (!(card instanceof HTMLElement)) {
          return;
        }

        const id = card.dataset.skin;

        if (id === undefined || id === "" || id === browsedSkin) {
          return;
        }

        browsedSkin = id;
        this.sfx.ui("move");
      };

      el.addEventListener("pointerover", browse);
      el.addEventListener("focusin", browse);
      el.addEventListener("pointerleave", () => {
        browsedSkin = undefined;
      });
      el.addEventListener("click", (e) => {
        const btn = e.target instanceof Element ? e.target.closest("[data-skin]") : null;

        if (!(btn instanceof HTMLElement)) {
          return;
        }

        const id = btn.dataset.skin;
        const sk = ROBOTAXI_SKINS.find((k) => k.id === id);

        if (!sk || !this.car) {
          return;
        }

        const owned = this.trailerMode || this.ownedSkins.has(sk.id) || sk.price === 0;

        if (owned) {
          this.sfx.ui("select");
        } else {
          if (this.state.score < sk.price) {
            this.sfx.denied();
            this.hud.announceMinor(`NEED $${sk.price}`, "#ff6a5e");

            return;
          }

          this.state.score -= sk.price;
          this.ownedSkins.add(sk.id);
          storageSet("crazy-waymo:skins-owned", JSON.stringify([...this.ownedSkins]));
          this.hud.announceMinor(`${sk.label} UNLOCKED −$${sk.price}`, "#ffd24a");
          this.sfx.unlock();
        }

        this.skinId = sk.id;

        if (!this.trailerMode) {
          storageSet("crazy-waymo:skin", sk.id);
        }

        void this.wearSkin(sk.id);
        this.hud.setOperator(sk.label, sk.accent);
        this.renderGarage();
      });
    }

    this.renderGarage();
    el.style.display = "flex";

    if (!this.garagePreview) {
      void this.mountShowroom(el);
    }
  }

  private async wearSkin(skinId: string) {
    await this.loadShowroom();

    if (this.skinId === skinId) {
      this.car?.setSkin(skinId);
    }
  }

  private async mountShowroom(container: HTMLDivElement) {
    await this.loadShowroom();

    if (this.garagePreview) {
      return;
    }

    const preview = new GaragePreview(this.cache);
    preview.bind(container);
    this.garagePreview = preview;

    if (this.garageOpen) {
      this.renderGarage();
    }
  }

  private renderGarage() {
    const el = this.garageEl;

    if (!el) {
      return;
    }

    el.innerHTML = `<div class="gtitle">✦ ROBOTAXI SHOWROOM ✦</div><div class="gcards">${this.garageCardsHtml()}</div><div class="ghint">drive away to close</div>`;
    this.garagePreview?.attach(el);
  }

  private closeGarage(announce = true) {
    if (announce && this.garageOpen) {
      this.sfx.ui("back");
    }

    this.garageOpen = false;

    if (this.garageEl) {
      this.garageEl.style.display = "none";
    }
  }

  private openChat() {
    let el = this.chatEl;

    if (!el) {
      const found = document.querySelector("#chat");

      if (!(found instanceof HTMLInputElement)) {
        return;
      }

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
            this.bubbles.say(this.car.object3D, text, { lift: 3 });
          }

          this.closeChat(text ? "select" : "back");
        } else if (e.key === "Escape") {
          this.closeChat();
        }
      });
      el.addEventListener("blur", () => {
        this.closeChat();
      });
    }

    el.style.display = "block";
    this.sfx.ui("open");
    el.value = "";
    this.input.setTyping(true);
    document.body.classList.add("chatting");
    el.focus();
  }

  private closeChat(cue: "select" | "back" = "back") {
    const el = this.chatEl;

    if (!el || el.style.display === "none") {
      return;
    }

    el.style.display = "none";
    this.sfx.ui(cue);
    el.blur();
    document.body.classList.remove("chatting");
    this.input.setTyping(false);
  }

  private exhaustFlash(hue: number) {
    const { car } = this;

    if (!car) {
      return;
    }

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

  private handleStartPress() {
    if (this.mode.kind !== "title") {
      return;
    }

    this.sfx.ensure();
    this.sfx.ui("select");
    this.start();
  }

  /** Restart the run — R, and the pause overlay's button for players with no
   *  keyboard. Trailer mode owns its run and must never be reset from UI. */
  restartRun() {
    if (this.trailerMode) {
      return;
    }

    this.sfx.ensure();
    this.sfx.reset();
    this.start();
  }

  get muted() {
    return this.sfx.muted;
  }

  /** M, and the pause overlay's sound toggle. Session-only in trailer mode:
   *  the trailer now solicits a keypress to unlock audio, and that key landing
   *  on M must not rewrite the player's saved sound preference for the real
   *  game. */
  toggleMute() {
    this.sfx.setMuted(!this.sfx.muted);

    if (!this.sfx.muted) {
      this.sfx.ui("select");
    }

    if (!this.trailerMode) {
      storageSet(SOUND_KEY, this.sfx.muted ? "0" : "1");
    }
  }

  private start() {
    if (!this.loadDone) {
      this.pendingStart = true;
      this.hud.setCta(this.finishStage);

      return;
    }

    const { car } = this;
    const { fares } = this;

    if (!car || !fares) {
      return;
    }

    this.sfx.setPaused(this.paused);
    this.sfx.stopEngine();
    this.wasBoosting = false;
    this.wasFloating = false;
    this.wasAirborne = false;
    this.boostWasFull = true;
    this.lastPatience = 1;
    this.lastDriftTier = 0;
    this.scrapeFrames = 0;
    this.closeGarage(false);
    notifyGameStarted();

    const lapS = (() => {
      let t = performance.now();

      return (label: string) => {
        const now = performance.now();

        if (now - t > 300) {
          console.log(`[start] ${label} ${Math.round(now - t)}ms`);
        }

        t = now;
      };
    })();

    this.sfx.ensure();
    this.sfx.startMusic();
    lapS("sfx");
    this.state.reset();
    this.hud.resetScore(0);
    const { city } = this;

    if (city) {
      this.spawn = this.computeSpawn(city);
    }

    lapS("spawn");
    car.reset(this.spawn.x, this.spawn.z, this.spawn.yaw);
    this.traffic?.reset({ gx: this.spawn.gx, gz: this.spawn.gz }, 4);
    lapS("traffic reset");
    fares.reset(car.position.x, car.position.z);
    lapS("fares reset");
    this.cones?.reset();
    this.hud.hideBanner();
    this.hud.setLanding(false);
    this.hud.setTimer(FARE.startTime, false);
    this.hud.setCombo(1, 0);
    this.hud.setArrow(false, 0, 0, 0);
    this.hud.setVignette(0);
    this.hitStop = 0;
    this.lastDistrict = "";
    this.countdownShown = -1;
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
    this.closeMap();
    setTouchPlaying(true);
    this.mode = { kind: "countdown", t: 0 };
  }

  private computeSpawn(city: CityModel) {
    const world = {
      decks: city.getDecks(),
      heightAt: (x: number, z: number) => city.heightAt(x, z),
      network: city.network,
      solids: this.solidIndex ?? new SolidIndex(city.solids),
    };

    const remember = !this.trailerMode && !DEV_ONLINE;
    const remembered = remember ? parseSpawn(storageGet(SPAWN_KEY)) : null;

    if (remembered && isPlayerSpawnSafe(world, remembered)) {
      return remembered;
    }

    const shared = DEV_ONLINE ? new Rng(DEV_ONLINE_START_SEED) : null;
    const spawn = choosePlayerSpawn(world, shared ? () => shared.next() : Math.random);

    if (!spawn) {
      throw new Error("No safe player start exists in the street network");
    }

    if (remember) {
      storageSet(SPAWN_KEY, JSON.stringify(spawn));
    }

    return spawn;
  }

  /** What src/playtest reads; null until the world is in. */
  playtestView() {
    const { car, city, fares } = this;

    if (!car || !city || !fares) {
      return null satisfies PlaytestView | null;
    }

    return {
      car,
      fares,
      frame: this.frame,
      phase: this.mode.kind,
      state: this.state,
      traffic: this.traffic,
      world: { heightAt: (x, z) => city.heightAt(x, z), network: city.network },
    } satisfies PlaytestView | null;
  }

  /** Playtest hook: reseed what a run rolls, then restart it. */
  playtestSeed(seed: number) {
    this.fares?.reseed(seed);
    this.traffic?.reseed(seed);
    this.restartRun();
  }

  /** Playtest hook: a fresh run, already past the title and the countdown. */
  playtestStart() {
    this.start();

    if (this.mode.kind !== "countdown" || !this.car) {
      return false;
    }

    this.rig.snapTo(this.car);
    this.mode = { kind: "playing" };

    return true;
  }

  debugTeleport(u: number, v: number, yaw: number) {
    const { car } = this;
    const { city } = this;

    if (!car || !city) {
      return;
    }

    const x = (u - 0.5) * WORLD_W;
    const z = (v - 0.5) * WORLD_H;
    let hit = null;

    for (const r of [60, 240, 1200, 6000]) {
      hit = city.network.nearest(x, z, r);

      if (hit) {
        break;
      }
    }

    if (!hit) {
      return;
    }

    const along = Math.atan2(hit.tx, hit.tz);
    const flip = Math.abs(((along - yaw + Math.PI * 3) % (Math.PI * 2)) - Math.PI) > HALF_PI;
    car.reset(hit.x, hit.z, flip ? along + Math.PI : along);
    this.rig.snapTo(car);
  }

  debugSetTime(seconds: number) {
    this.state.timeLeft = seconds;
  }

  debugSmashNearestCone() {
    const { cones } = this;
    const { car } = this;

    if (!cones || !car) {
      return false;
    }

    const [p] = cones.restingPositions();

    if (!p) {
      return false;
    }

    return cones.tryHit(p.x, p.z, 30, 12) > 0;
  }

  debugNearestCone() {
    const { car } = this;

    if (!car || !this.cones) {
      return null;
    }

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

  debugProbe() {
    const { car } = this;

    if (!car) {
      return null;
    }

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
      airTime: car.airTime,
      airborne: car.airborne,
      boosting: car.isBoosting,
      carrying: this.fares?.carryingInfo() !== null && this.fares !== null,
      drifting: car.isDrifting,
      fares: this.state.fares,
      heading: car.heading,
      nearestTraffic,
      network: {
        players: this.net ? Object.keys(this.net.players).length : 0,
        status: this.net?.connectionStatus ?? "loading",
        visible: this.remoteCars?.count() ?? 0,
      },
      objective: obj ? { u: obj.pos.x / WORLD_W + 0.5, v: obj.pos.z / WORLD_H + 0.5 } : null,
      speed: car.speed,
      waterContact: car.waterContact,
      wreckedCount: this.traffic ? this.traffic.cars.filter((c) => c.wrecked).length : 0,
      x: car.position.x,
      y: car.position.y,
      z: car.position.z,
    };
  }

  /** While paused the frame pacer stops advancing the game (main.ts), but the
   *  room still sees this taxi: the pose keeps going out flagged as paused, so
   *  peers neither freeze it nor drop it. */
  updatePaused() {
    if (this.paused) {
      this.updateNet();
    }
  }

  update(dt: number) {
    if (this.paused) {
      this.updatePaused();

      return;
    }

    this.frame += 1;
    this.pollInput();
    this.updateGarages(dt);
    this.heckleCooldown = Math.max(0, this.heckleCooldown - dt);
    this.bubbles.update(dt, this.rig.camera);
    this.hud.update(dt);
    this.fx.update(dt);
    this.impactStars.update(dt);
    const chase = this.car?.position ?? this.rig.camera.position;
    this.ambient?.update(dt, this.dayNight.lamp, this.sceneFog, chase.x, chase.z);
    this.skids?.update(dt);
    this.trails?.update(dt);
    this.shocks.update(dt);
    this.clouds.update(dt);
    this.oceanTime.value += dt;
    this.dayNight.update(dt);
    this.maybeBakeSky();

    if (this.editorLighting && this.scene.fog instanceof THREE.Fog) {
      this.scene.fog.near = 4000;
      this.scene.fog.far = 12_000;
    }

    this.updateNightSystems(dt);

    switch (this.mode.kind) {
      case "loading": {
        break;
      }

      case "title": {
        this.updateTitle(dt);
        break;
      }

      case "countdown": {
        this.updateCountdown(this.mode, dt);
        break;
      }

      case "playing": {
        this.updatePlaying(dt);
        break;
      }

      default: {
        break;
      }
    }

    this.trailerFrame?.(dt);

    this.updateSun();
    this.city?.updateStreaming(this.rig.camera, this.editorLighting);

    this.updateNet();
  }

  private pollInput() {
    this.touch?.update();

    if (this.input.consumeStart() && !this.trailerMode) {
      if (this.mode.kind === "playing" && !this.input.typing) {
        this.openChat();
      } else {
        this.handleStartPress();
      }
    }

    if (this.input.consumeRestart()) {
      this.restartRun();
    }

    if (this.input.consumeMute()) {
      this.toggleMute();
    }
  }

  private updateNightSystems(dt: number) {
    const night = this.dayNight.lamp;
    this.fx.setLighting(
      this.sun.color,
      this.sun.intensity,
      this.hemi.color,
      this.hemi.intensity,
      1 - night,
    );
    this.lampGlow?.setIntensity(night);
    setParcelNight(night);
    setSalesforceNight(night);
    this.lampGlow?.updateNear(this.rig.camera.position.x, this.rig.camera.position.z, dt);
    this.beacons?.setIntensity(night);
    this.beacons?.update(dt);
    this.harbor.setIntensity(night);
    this.harbor.update(dt, this.rig.camera.position.x, this.rig.camera.position.z);
    this.vehicleLights.setIntensity(night);

    if (this.traffic) {
      const cam = this.rig.camera.position;
      this.vehicleLights.update(this.traffic.cars, cam.x, cam.z);
    }

    this.farTerrain.update(this.sceneFog.color, night);
    this.marineSky.update(this.sceneFog.color, !this.editorLighting);
    this.landmarkSilhouettes.update(this.sceneFog.color, night, this.sceneFog);
    this.clouds.setNight(night);
    this.car?.setHeadlights(night);
    this.updateAmbience(dt, night);
    this.debris?.update(dt);
    this.cones?.update(dt);
  }

  private updateNet() {
    const { car, net } = this;
    const remote = this.remoteCars;

    if (!car || !net || !remote) {
      return;
    }

    const now = performance.now();
    const elapsed = this.netAt === 0 ? 0 : now - this.netAt;
    this.netAt = now;

    const driving = this.mode.kind === "countdown" || this.mode.kind === "playing";

    if (this.netRate.due(elapsed) && driving && net.serverClock.synced) {
      net.updateMyState({
        h: roundNet(car.heading),
        msg: this.chatText,
        msgAt: this.chatAt,
        p: this.paused ? 1 : 0,
        skin: this.skinId,
        t: Math.round(net.serverNow()),
        vx: this.paused ? 0 : roundVel(car.velX),
        vz: this.paused ? 0 : roundVel(car.velZ),
        x: roundNet(car.position.x),
        y: roundNet(car.position.y),
        z: roundNet(car.position.z),
      });
    }

    const staged = this.trailerFakes !== null;
    remote.sync(this.trailerFakes ?? net.players, net.playerId, { now, staged });

    if (!this.paused) {
      remote.update(car.position, now);
    }

    if (this.netInfoEl) {
      showRoomStatus(this.netInfoEl, net);
    }
  }

  private updateTitle(dt: number) {
    this.titleT += dt;
    const { car } = this;

    if (!car) {
      return;
    }

    if (this.freecam) {
      return;
    }

    const r = 30;
    const a = this.titleT * 0.2;
    this.rig.camera.position.set(
      car.position.x + Math.cos(a) * r,
      car.position.y + 17,
      car.position.z + Math.sin(a) * r,
    );
    this.rig.camera.lookAt(car.position.x, car.position.y + 1, car.position.z);
    this.parked?.updateCulling(this.rig.camera.position.x, this.rig.camera.position.z);
    this.speedLines?.update(dt, this.rig.camera, 0);
    setGradeMotion(0, false);
  }

  private updateCountdown(mode: { kind: "countdown"; t: number }, dt: number) {
    const { car } = this;

    if (!car) {
      return;
    }

    mode.t += dt;
    const total = COUNTDOWN_STEP * 3;
    const step = Math.min(2, Math.floor(mode.t / COUNTDOWN_STEP));

    if (step !== this.countdownShown) {
      this.countdownShown = step;
      this.hud.showCountdown(String(3 - step), false);
      this.sfx.countdown(3 - step);
    }

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

  private updatePlaying(dt: number) {
    const { car } = this;
    const { city } = this;
    const { fares } = this;
    const { traffic } = this;

    if (!car || !city || !fares || !traffic) {
      return;
    }

    const solids = this.solidIndex;

    if (!solids) {
      return;
    }

    if (this.hitStop > 0) {
      this.hitStop = Math.max(0, this.hitStop - dt);

      if (!this.freecam) {
        this.rig.update(dt, car, solids);
      }

      this.tickHud(dt, car, fares, false);

      return;
    }

    const input = this.autopilotInput(this.input.carInput(), car);

    this.stepSim(dt, car, city, traffic, input, solids);

    const ev = fares.update(dt, car);
    this.handleFareEvent(ev);
    this.state.update(dt, fares.carryingInfo() !== null);
    const patience = fares.patienceFrac();

    if (patience <= 0.25 && this.lastPatience > 0.25) {
      this.sfx.passengerWarning();
    }

    this.lastPatience = patience;

    const drifting = this.updateDriftFx(dt, car, input);
    this.updateMiniTurbo(car, drifting);
    this.updateBoostFx(dt, car, input);
    this.updateLandingFx(car);
    this.updateWallFx(car);
    this.updateHints(dt, car, input);

    const eye = this.freecam ? this.rig.camera.position : car.position;
    const dist = districtAt(city.gridX(eye.x), city.gridZ(eye.z));

    if (dist.name !== this.lastDistrict) {
      this.lastDistrict = dist.name;
      this.hud.setArea(dist.name);
      this.hud.showDistrict(dist.name);
    }

    if (!this.freecam) {
      this.rig.update(dt, car, solids);
    }

    this.speedLines?.update(dt, this.rig.camera, this.freecam ? 0 : car.speed / CAR.boostSpeed);
    setGradeMotion(this.freecam ? 0 : car.speed / CAR.boostSpeed, !this.freecam && car.isBoosting);
    this.hud.setVignette(THREE.MathUtils.clamp((car.speed - 45) / 40, 0, 1) * 0.6);
    this.tickHud(dt, car, fares, true);
  }

  private stepSim(
    dt: number,
    car: Car,
    city: CityModel,
    traffic: Traffic,
    input: CarInput,
    solids: SolidIndex,
  ) {
    car.update(dt, input, solids);
    this.handleTrafficImpacts(car, traffic, dt);
    this.handleParkedImpacts(car, dt);
    traffic.setHour(this.dayNight.hour);
    traffic.update(dt, city, car.position.x, car.position.z, car.heading);
    this.signalLights?.update(traffic.time);
    this.physics?.streamSolids(car.position.x, car.position.z);
    this.physics?.step(
      dt,
      (fdt) => {
        car.physicsFixedStep(fdt);
      },
      () => {
        car.captureStep();
      },
    );
    car.syncFromPhysics(dt, this.physics?.alpha ?? 1);
    this.touch?.setReverseHint(car.forwardSpeed <= 0.5);
    traffic.syncWrecked();
    this.parked?.sync();
    this.parked?.updateCulling(this.rig.camera.position.x, this.rig.camera.position.z);
    this.handleNearMiss(car, traffic);
    this.handleHonks(traffic);
    this.handleCones(car);
  }

  private updateDriftFx(dt: number, car: Car, input: CarInput) {
    const water = car.waterContact;
    const floating = water.kind === "floating";

    if (water.kind === "floating" && !this.wasFloating) {
      this.sfx.waterSplash(water.entrySpeed, water.entryVerticalSpeed);
    }

    this.wasFloating = floating;
    this.sfx.setWaterMotion(floating ? car.speed : 0);
    const drifting = !floating && car.isDrifting && car.speed > 8;

    if (drifting) {
      this.state.addDrift(dt);
    } else {
      this.state.endDrift();
    }

    const brakingHard =
      !floating && !drifting && !car.airborne && input.brake > 0.05 && car.forwardSpeed > 8;

    const slipAmt = Math.min(1, Math.abs(car.slip) / 0.6);
    let screech = 0;

    if (drifting && !car.airborne) {
      screech = Math.max(0.25, slipAmt);
    } else if (brakingHard) {
      screech = 0.3;
    }

    this.sfx.setScreech(screech, car.speed / CAR.maxSpeed);
    this.vehicleFx.update(dt, car, drifting, brakingHard, this.wheelSurfaceAt);

    return drifting;
  }

  private updateMiniTurbo(car: Car, drifting: boolean) {
    const tier = drifting ? car.driftTier : 0;

    if (tier > this.lastDriftTier && (tier === 1 || tier === 2)) {
      this.sfx.driftArm(tier);
    }

    this.lastDriftTier = tier;

    if (car.miniBoostFired) {
      const superTurbo = car.miniTurboTier >= 2;
      this.sfx.miniTurbo(superTurbo ? 2 : 1);
      this.rig.addTrauma(superTurbo ? 0.26 : 0.18);
      this.hud.flash(superTurbo ? "#ffa726" : "#8fe8ff", 0.16);
      this.hud.showCombo(superTurbo ? "SUPER MINI-TURBO!" : "MINI-TURBO!");
    }
  }

  private updateBoostFx(dt: number, car: Car, input: CarInput) {
    if (car.isBoosting && !this.wasBoosting) {
      if (!car.miniBoostFired) {
        this.sfx.boost();
      }

      this.rig.addTrauma(0.12);
    } else if (!car.isBoosting && this.wasBoosting) {
      this.sfx.boostEnd();
    }

    this.wasBoosting = car.isBoosting;
    const boostFull = car.boostMeter >= CAR.boostMax;

    if (boostFull && !this.boostWasFull) {
      this.sfx.boostReady();
    }

    this.boostWasFull = boostFull;
    this.sfx.setBoostLoop(car.isBoosting);

    if (car.isBoosting) {
      this.flameAccum += dt;

      if (this.flameAccum >= 0.05) {
        this.flameAccum = 0;
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
      input.throttle - input.brake,
      car.isBoosting,
      car.airborne,
    );

    if (car.airborne && !this.wasAirborne && car.speed > 8) {
      this.sfx.jump();
    }

    this.wasAirborne = car.airborne;
  }

  private updateLandingFx(car: Car) {
    if (car.justLanded > 0) {
      if (car.airTime > LANDING_RING_AIR || car.justLanded > LANDING_RING_IMPACT) {
        this.fx.dustRing(car.position.x, car.position.y + 0.15, car.position.z, 10);
      }

      this.sfx.landThud(Math.min(1, car.justLanded / 12));
      this.rig.addTrauma(Math.min(0.45, 0.15 + car.justLanded * 0.015));

      if (car.airTime > 0.45) {
        const pts = this.state.landAir(car.airTime);
        const air = `AIR ${car.airTime.toFixed(1)}s`;
        this.hud.announceMinor(pts > 0 ? `${air} +$${pts}` : air, "#8fd9ff");
      }
    }
  }

  private updateWallFx(car: Car) {
    if (car.lastWallHit > CRASH_THRESHOLD) {
      const impact = car.lastWallHit;
      const p = Math.min(1, (impact - CRASH_THRESHOLD) / 20);
      this.rig.addTrauma(0.35 + p * 0.5);
      this.hud.flash("#ffffff", 0.25 + p * 0.3);
      this.fx.burst(car.position.x, 1, car.position.z, 0.07, 10, 6 + p * 8);
      this.impactStars.burst(car.position.x, car.position.y, car.position.z, p);
      this.sfx.crash(impact);
      this.debris?.burst(
        car.position.x,
        car.position.z,
        car.lastWallNormal.x,
        car.lastWallNormal.y,
        impact,
      );

      if (this.skids) {
        for (let i = 0; i < 4; i += 1) {
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

    this.scrapeFrames =
      car.wallContact && car.lastWallHit <= CRASH_THRESHOLD && car.speed > 7
        ? Math.min(this.scrapeFrames + 1, 10)
        : Math.max(this.scrapeFrames - 1, 0);
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
  }

  private updateHints(dt: number, car: Car, input: CarInput) {
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
  }

  private handleCones(car: Car) {
    const { cones } = this;

    if (!cones) {
      return;
    }

    const vx = Math.sin(car.heading) * car.speed;
    const vz = Math.cos(car.heading) * car.speed;
    const hits = cones.tryHit(car.position.x, car.position.z, vx, vz);

    if (hits > 0) {
      let cash = 0;

      for (let i = 0; i < hits; i += 1) {
        cash += this.state.smash();
      }

      this.hud.announceMinor(cash > 0 ? `SMASH +$${cash}` : "SMASH", "#ffb64d");
      this.sfx.thud();
      this.fx.burst(car.position.x, 0.8, car.position.z, 0.07, 5, 4);
    }
  }

  private handleTrafficImpacts(car: Car, traffic: Traffic, dt: number) {
    const { physics } = this;

    if (!physics) {
      return;
    }

    for (const c of traffic.cars) {
      if (c.wrecked) {
        continue;
      }

      if (c.puntCooldown > 0) {
        continue;
      }

      if (car.position.y > c.position.y + 1.9) {
        continue;
      }

      const dx = c.position.x - car.position.x;
      const dz = c.position.z - car.position.z;
      const d = Math.hypot(dx, dz);

      if (d < 1e-4) {
        continue;
      }

      const nx = dx / d;
      const nz = dz / d;
      const impact = car.contactPunt(nx, nz, 0);
      const reach = CONTACT_R + Math.max(0, impact) * dt;

      if (d > reach) {
        continue;
      }

      if (impact < 0.4 && d > CONTACT_R) {
        continue;
      }

      c.puntCooldown = 0.25;
      c.punt(physics);
      car.lastWallHit = Math.max(car.lastWallHit, impact * 0.5);

      if (impact > 4 && this.heckleCooldown <= 0 && Math.random() < 0.65) {
        this.heckleCooldown = 7;
        const line = this.pickHeckle();

        if (line !== undefined && line !== "") {
          this.bubbles.say(c.object3D, line, { accent: "#e05c2e", dur: 4.5, lift: 2.3 });
        }
      }

      if (impact > 7) {
        const pen = this.state.trafficHit(impact);
        this.hud.announceMinor(`TRAFFIC HIT −$${pen}`, "#ff5a52");
      }
    }
  }

  private handleParkedImpacts(car: Car, dt: number) {
    const { parked } = this;

    if (!parked) {
      return;
    }

    const impact = parked.tryPunt(car.position.x, car.position.z, car.velX, car.velZ, dt);

    if (impact > 0) {
      car.lastWallHit = Math.max(car.lastWallHit, impact * 0.5);
    }
  }

  private handleHonks(traffic: Traffic) {
    for (const c of traffic.cars) {
      if (!c.wantsHonk) {
        continue;
      }

      c.wantsHonk = false;
      this.sfx.honk(this.panFor(c.position));
    }
  }

  private updateAmbience(dt: number, night: number) {
    this.ambienceAcc += dt;

    if (this.ambienceAcc < 1 / AMBIENCE_HZ) {
      return;
    }

    this.ambienceAcc = 0;
    const p = this.car?.position ?? this.rig.camera.position;
    let water = 0;

    for (const probe of SHORE_PROBES) {
      const u = (p.x + probe.x) / WORLD_W + 0.5;
      const v = (p.z + probe.z) / WORLD_H + 0.5;
      water = Math.max(water, 1 - THREE.MathUtils.clamp(landFactor(u, v), 0, 1));
    }

    const right = this.scrRight.setFromMatrixColumn(this.rig.camera.matrixWorld, 0);
    const toGate = this.scrToGate.subVectors(GATE_POS, this.rig.camera.position).normalize();
    this.sfx.setAmbience({
      exposure: THREE.MathUtils.clamp((p.y - 14) / 70, 0, 1),
      gatePan: THREE.MathUtils.clamp(toGate.dot(right) * 1.3, -1, 1),
      night,
      shore: water,
    });
  }

  private panFor(pos: THREE.Vector3) {
    const cam = this.rig.camera;
    const right = new THREE.Vector3().setFromMatrixColumn(cam.matrixWorld, 0);
    const rel = new THREE.Vector3().subVectors(pos, cam.position);

    return THREE.MathUtils.clamp(rel.dot(right) / 14, -1, 1);
  }

  private handleFareEvent(ev: FareEvent) {
    const { car } = this;
    const { city } = this;

    if (ev.kind === "pickup") {
      this.sfx.pickup();
      this.fx.burst(ev.pos.x, 1.2, ev.pos.z, 0.5, 10, 5);
      const destName = city ? districtAt(ev.dest.gx, ev.dest.gz).name : "";
      this.hud.showCombo(destName ? `TO ${destName.toUpperCase()}!` : "GO GO GO!");
      this.sayRiderLine("pickup");

      if (car) {
        car.addBoost(20);
      }
    } else if (ev.kind === "dropoff") {
      const reward = this.state.dropoff(ev.tiles, ev.rideTime, tierPayMult(ev.tier));
      this.sfx.dropoff(reward.combo);
      this.fx.burst(ev.pos.x, 1.2, ev.pos.z, 0, 9, 8);
      this.fx.burst(ev.pos.x, 1.7, ev.pos.z, 0.33, 9, 7);
      this.fx.burst(ev.pos.x, 2.1, ev.pos.z, 0.6, 9, 6);
      this.shocks.fire(ev.pos.x, 1, ev.pos.z, 0xff_d1_47);
      this.hud.flash("#6bff8e", 0.22);
      this.rig.addTrauma(0.25);

      const lines: { text: string; color: string }[] = [
        { color: "#ffffff", text: `FARE $${reward.fare}` },
      ];

      if (reward.tip > 0) {
        lines.push({ color: "#6bff8e", text: `TIP $${reward.tip} SPEEDY!` });
      }

      if (reward.combo > 1) {
        lines.push({ color: "#ffd147", text: `${reward.combo}× COMBO` });
      }

      if (reward.overflowCash > 0) {
        lines.push({ color: "#8fd9ff", text: `LONG HAUL +$${reward.overflowCash}` });
      }

      this.hud.showReceipt(lines);
      this.hud.showCombo(`+$${reward.gross}`);
      const score = this.state.displayScore;

      if (!this.trailerMode && score > readBest()) {
        storageSet(BEST_KEY, String(score));
      }

      this.sayRiderLine("dropoff");

      if (car) {
        car.addBoost(30);
      }
    } else if (ev.kind === "bail") {
      this.state.bail();
      this.sfx.passengerBail();
      this.hud.flash("#ff5a52", 0.2);
      this.hud.announceMinor("PASSENGER BAILED!", "#ff5a52");
    }
  }

  private pickHeckle() {
    if (this.trailerMode) {
      return;
    }

    const sk = skinById(this.skinId);
    const pool = sk.heckles.length > 0 && Math.random() < 0.45 ? sk.heckles : HECKLES;

    return pool[Math.floor(Math.random() * pool.length)];
  }

  private sayRiderLine(kind: "pickup" | "dropoff") {
    const { car } = this;

    if (!car) {
      return;
    }

    const sk = skinById(this.skinId);
    const pool = kind === "pickup" ? sk.pickupLines : sk.dropoffLines;
    const line = pool[Math.floor(Math.random() * pool.length)];

    if (line !== undefined && line !== "") {
      this.bubbles.say(car.object3D, line, { accent: sk.accent, dur: 3.5, lift: 3 });
    }
  }

  private handleNearMiss(car: Car, traffic: Traffic) {
    if (car.speed < NEAR_MISS_SPEED) {
      return;
    }

    if (car.lastWallHit > 0) {
      return;
    }

    for (const c of traffic.cars) {
      if (c.missCooldown > 0) {
        continue;
      }

      const dx = car.position.x - c.position.x;
      const dz = car.position.z - c.position.z;
      const d = Math.hypot(dx, dz);

      if (d >= NEAR_MISS_MIN && d <= NEAR_MISS_MAX) {
        c.missCooldown = 2.6;
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

          if (line !== undefined && line !== "") {
            this.bubbles.say(c.object3D, line, { accent: "#e05c2e", dur: 4, lift: 2.3 });
          }
        }
      }
    }
  }

  private tickHud(dt: number, car: Car, fares: FareManager, withMinimap: boolean) {
    this.hudAcc += dt;

    if (this.mobileUi && this.hudAcc < 1 / HUD_HZ) {
      return;
    }

    this.updateHud(car, fares);

    if (withMinimap) {
      this.updateMinimap(this.hudAcc, car, fares);
    }

    this.hudAcc = 0;
  }

  private updateMinimap(dt: number, car: Car, fares: FareManager) {
    const { minimap } = this;

    if (!minimap) {
      return;
    }

    const markers = this.mmMarkers;
    markers.length = 0;
    const { city } = this;

    if (city) {
      const nearest = this.nearestGarage();

      for (const g of city.garages) {
        markers.push({
          color: "#ffa63d",
          edgeClamp: g === nearest,
          glyph: "square",
          x: g.padX,
          z: g.padZ,
        });
      }
    }

    if (!this.trailerFakes) {
      this.remoteCars?.forEachPresent((x, z) => {
        markers.push({ color: "#ffffff", glyph: "player", x, z });
      });
    }

    const carrying = fares.carryingInfo();

    if (carrying) {
      markers.push({ color: "#49e0ff", ring: true, x: carrying.pos.x, z: carrying.pos.z });
    } else {
      for (const w of fares.waitingList()) {
        markers.push({ color: tierHex(w.tier), x: w.x, z: w.z });
      }
    }

    const { destination } = this.mapNav;

    if (destination) {
      markers.push({ color: "#6bff8e", ring: true, x: destination.x, z: destination.z });
    }

    const route = destination ? this.mapNav.remainingRoute : null;
    minimap.update(dt, car.position.x, car.position.z, car.heading, markers, route);
  }

  private updateSun() {
    const raw = this.freecam ? this.rig.camera.position : this.car?.position;

    if (!raw) {
      return;
    }

    if (this.quality.shadowEvery === 1 && !isCoarsePointer()) {
      const elevY = this.scrSnapDir.copy(this.dayNight.sunOffset).normalize().y;
      const ext = 58 + 16 * (1 - THREE.MathUtils.smoothstep(elevY, 0.15, 0.45));

      if (Math.abs(ext - this.shadowExtent) > 0.25) {
        this.shadowExtent = ext;
        const sc = this.sun.shadow.camera;
        sc.left = -ext;
        sc.right = ext;
        sc.top = ext;
        sc.bottom = -ext;
        sc.updateProjectionMatrix();
        const k = ext / 58;
        this.sun.shadow.normalBias = 0.04 * k * k;
        this.sun.shadow.bias = -0.0005 / (k * k);
      }
    }

    const anchor = this.scrSnapAnchor.copy(raw);

    if (this.quality.shadowEvery > 1) {
      const dir = this.scrSnapDir.copy(this.dayNight.sunOffset).normalize();
      const up = Math.abs(dir.y) > 0.97 ? this.scrSnapUp.set(0, 0, 1) : this.scrSnapUp.set(0, 1, 0);
      const right = this.scrSnapRight.crossVectors(up, dir).normalize();
      const upOrtho = this.scrSnapUp.crossVectors(dir, right);
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

  debugSetDayPhase(p: number) {
    this.dayNight.setPhase(p);
  }

  private trailerFakes: PlayerMap | null = null;
  private trailerStage: TrailerStage | null = null;
  private trailerFrame: ((dt: number) => void) | null = null;

  /** Load the trailer's taxi before revealing footage; leave saved equipment alone. */
  async prepareTrailer() {
    if (!this.trailerMode) {
      return;
    }

    await this.cache.ensure(skinModelUrl(skinById("waymo")));
    this.skinId = "waymo";
    this.car?.setSkin(this.skinId);
  }

  /** Enter gameplay and expose staging controls after `ready`; idempotent and
   *  restricted to trailer boots. A trusted gesture unlocks audio through the shell. */
  beginTrailer() {
    if (this.trailerStage) {
      return this.trailerStage;
    }

    if (!this.trailerMode || !this.loadDone) {
      return null;
    }

    const { car } = this;
    const { city } = this;
    const { fares } = this;
    const { traffic } = this;
    const { cones } = this;

    if (!car || !city || !fares || !traffic || !cones) {
      return null;
    }

    this.hud.hideBanner();
    this.hud.setLanding(false);
    this.minimap?.setVisible(false);
    this.closeMap();
    this.hintDriftShown = true;
    this.hintBoostShown = true;

    if (this.garagePillar) {
      this.garagePillar.visible = false;
    }

    if (this.garageRings) {
      this.garageRings.visible = false;
    }

    this.bubbles.clear();
    this.state.reset();
    this.mode = { kind: "playing" };
    this.trailerStage = {
      camera: this.rig.camera,
      car,
      city,
      closeShowroom: () => {
        this.closeGarage(false);

        if (this.garageRings) {
          this.garageRings.visible = false;
        }
      },
      cones,
      fares,
      hud: this.hud,
      openShowroom: async () => {
        await this.loadShowroom();

        if (this.garageRings) {
          this.garageRings.visible = true;
        }

        this.openGarage();

        if (this.garageEl) {
          await this.mountShowroom(this.garageEl);
        }
      },
      placeCar: (x, z, yaw, speed, y) => {
        const sx = clampToPlayArea(x, WORLD_HALF_X);
        const sz = clampToPlayArea(z, WORLD_HALF_Z);

        if (sx !== x || sz !== z) {
          console.error(`trailer: staged (${x.toFixed(0)}, ${z.toFixed(0)}) outside the play area`);
        }

        car.reset(sx, sz, yaw);
        const veh = car.physicsVehicle;

        if (veh) {
          if (y !== undefined) {
            veh.teleport(sx, y + 1.4, sz, yaw);
            car.position.y = y;
          }

          veh.chassis.setLinvel({ x: Math.sin(yaw) * speed, y: 0, z: Math.cos(yaw) * speed }, true);
        }

        this.rig.snapTo(car);
      },
      restoreParked: () => this.parked?.restore(),
      sayTraffic: (actor, quip) => {
        if (this.bubbles.group.visible && traffic.cars.includes(actor)) {
          this.bubbles.say(actor.object3D, TRAFFIC_QUIPS[quip], {
            accent: "#e05c2e",
            dur: 3,
            lift: 2.3,
            screenWidth: 0.22,
          });
        }
      },
      setCommentary: (visible) => {
        this.bubbles.clear();
        this.bubbles.group.visible = visible;
      },
      setDayPhase: (p) => {
        this.dayNight.setPhase(p);
      },
      setFakePlayers: (players) => {
        this.trailerFakes = players;

        if (this.remoteCars) {
          this.remoteCars.showBeacons = players === null;
        }
      },
      setFrameHook: (fn) => {
        this.trailerFrame = fn;
      },
      setFreecam: (on) => {
        this.freecam = on;
      },
      setFxDim: (dim) => {
        this.fx.setFxDim(dim);
      },
      setGameplayHud: (visible) => this.minimap?.setVisible(visible),
      setScriptedInput: (input) => {
        this.input.setScripted(input);
      },
      setSpeed: (speed) => {
        const veh = car.physicsVehicle;

        if (!veh) {
          return;
        }

        const vy = veh.chassis.linvel().y;
        veh.chassis.setLinvel(
          { x: Math.sin(car.heading) * speed, y: vy, z: Math.cos(car.heading) * speed },
          true,
        );
      },
      snapCamera: () => {
        this.rig.snapTo(car);
      },
      stageParkedRow: (x0, z0, tx, tz, n, spacing) =>
        this.parked?.stageRow(x0, z0, tx, tz, n, spacing),
      state: this.state,
      traffic,
      unlockAudio: () => {
        this.sfx.ensure();
        this.sfx.setMuted(false);
        this.sfx.startMusic();
      },
      wearSkin: (skinId) => {
        this.skinId = skinId;
        this.car?.setSkin(skinId);
      },
    };

    return this.trailerStage;
  }

  private updateHud(car: Car, fares: FareManager) {
    this.hud.setTimer(this.state.timeLeft, this.state.timeLeft <= 10);
    this.hud.setScore(this.state.displayScore);
    this.hud.setSpeed(car.speed * MPH_FACTOR);
    this.hud.setBoost(car.boostMeter / CAR.boostMax);
    this.hud.setDrift(car.driftTier, car.driftCharge);
    this.hud.setCombo(this.state.combo, this.state.comboTimer / FARE.comboWindow);

    const carrying = fares.carryingInfo();

    if (carrying) {
      const { city } = this;
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

  private projectArrow(target: THREE.Vector3, color: string) {
    const ndc = this.scrArrow.copy(target).project(this.rig.camera);
    const behind = ndc.z > 1;
    const x = behind ? -ndc.x : ndc.x;
    const y = behind ? -ndc.y : ndc.y;
    const onScreen = !behind && x > -0.92 && x < 0.92 && y > -0.92 && y < 0.92;

    if (onScreen) {
      this.hud.setArrow(false, 0, 0, 0);

      return;
    }

    const box = this.hud.arrowBounds();
    const cx = (box.minX + box.maxX) / 2;
    const cy = (box.minY + box.maxY) / 2;
    const dx = (x * 0.5 + 0.5) * window.innerWidth - cx;
    const dy = (-y * 0.5 + 0.5) * window.innerHeight - cy;

    if (dx === 0 && dy === 0) {
      this.hud.setArrow(false, 0, 0, 0);

      return;
    }

    const hitX = dx === 0 ? Infinity : (box.maxX - cx) / Math.abs(dx);
    const hitY = dy === 0 ? Infinity : (box.maxY - cy) / Math.abs(dy);
    const t = Math.min(hitX, hitY);
    const rot = Math.atan2(dx, -dy);
    this.hud.setArrow(true, cx + dx * t - 32, cy + dy * t - 32, rot, color);
  }
}
