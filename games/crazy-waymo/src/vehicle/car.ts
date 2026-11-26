import * as THREE from "three";

import type { ModelCache } from "../assets/loader";
import { modelUrl, PLAYER_CAR } from "../assets/manifest";
import { ContactShadow, SHADOW_LIFT } from "./contact-shadow";
import { addInkHulls } from "./ink-hull";
import { applyLacquer } from "./lacquer";
import type { RaycastVehicle } from "./raycast-vehicle";
import { applySunRim, applyTrafficSunRim, RIM_HERO } from "./sun-rim";
import { radialGlowTexture } from "../fx/lamp-glow";
import { CAR, ROAD_Y, WORLD_HALF_X, WORLD_HALF_Z } from "../shared/constants";
import type { Solid } from "../world/city";
import type { SolidIndex } from "../world/solid-index";
import { slopeQuaternion } from "../world/terrain";
import { DRY_WATER_CONTACT } from "./water-contact";

export interface CarInput {
  readonly throttle: number;
  readonly brake: number;
  readonly steer: number;
  readonly boost: boolean;
}

export interface Surface {
  heightAt: (x: number, z: number) => number;
  normalInto: (out: THREE.Vector3, x: number, z: number) => THREE.Vector3;
  waterHeightAt?: (x: number, z: number) => number | null;
}

const MODEL_YAW_OFFSET = 0;
const COLLIDE_RADIUS = 1.05;
const WHEEL_RADIUS = 0.35;
const UP = new THREE.Vector3(0, 1, 0);
const X_AXIS = new THREE.Vector3(1, 0, 0);
const RESCUE_INSET = 8;

const clampInsideMap = (v: number, half: number) =>
  Math.min(half - RESCUE_INSET, Math.max(-(half - RESCUE_INSET), v));

const LIDAR_WHITE = new THREE.MeshStandardMaterial({ color: 0xee_f0_f2, roughness: 0.7 });

const LIDAR_DARK = new THREE.MeshStandardMaterial({
  color: 0x24_27_2e,
  metalness: 0.2,
  roughness: 0.5,
});

const LIDAR_BLUE = new THREE.MeshStandardMaterial({
  color: 0x2f_7d_e0,
  emissive: 0x1a_5f_bf,
  emissiveIntensity: 0.4,
  roughness: 0.2,
});

applySunRim(LIDAR_WHITE, RIM_HERO);

applySunRim(LIDAR_DARK, RIM_HERO);

applySunRim(LIDAR_BLUE, RIM_HERO);

const BODY_ROUGHNESS = 0.32;
const BODY_CLEARCOAT_ROUGHNESS = 0.09;

const lacquerMaterial = (src: THREE.MeshStandardMaterial, tint: THREE.Color | null) => {
  const m = new THREE.MeshPhysicalMaterial({
    alphaTest: src.alphaTest,
    clearcoat: 1,
    clearcoatRoughness: BODY_CLEARCOAT_ROUGHNESS,
    color: src.color.clone(),
    map: src.map,
    metalness: 0,
    opacity: src.opacity,
    roughness: BODY_ROUGHNESS,
    side: src.side,
    transparent: src.transparent,
    vertexColors: src.vertexColors,
  });

  if (tint) {
    m.color.multiply(tint).lerp(tint, 0.55);
  }

  applyLacquer(m, RIM_HERO);

  return m;
};

export interface RobotaxiSkin {
  id: string;
  label: string;
  model: string;
  tint?: number;
  lidar: boolean;
  mustache?: boolean;
  /** Generated (non-Kenney) models: normalize to this z-length, ground at
   *  y 0, recenter — plus an extra yaw if the mesh doesn't face +Z. */
  fit?: { length: number; yaw?: number };
  price: number;
  blurb: string;
  accent: string;
  pickupLines: readonly string[];
  dropoffLines: readonly string[];
  heckles: readonly string[];
}

export const ROBOTAXI_SKINS: readonly RobotaxiSkin[] = [
  {
    accent: "#4bd1a0",
    blurb: "the original",
    dropoffLines: [
      "smoothest unprotected left ever",
      "rate us in the app!",
      "it just… stopped? ok bye",
      "5 stars for the ghost driver",
    ],
    heckles: ["Not you again, Waymo!", "The cone community sees you!", "Phoenix misses you!"],
    id: "waymo",
    label: "WAYMO",
    lidar: true,
    model: PLAYER_CAR,
    pickupLines: [
      "please keep hands off the wheel",
      "the Waymo Driver is in control",
      "*calming chime*",
      "ooh the wheel turns itself",
    ],
    price: 0,
  },
  {
    accent: "#ff8b3d",
    blurb: "pour one out",
    dropoffLines: [
      "tell no one",
      "5 stars for old times",
      "still smoother than 2023",
      "origin story over",
    ],
    fit: { length: 2.7, yaw: -Math.PI / 2 },
    heckles: ["Aren't you BANNED?!", "Does the DMV know you're out?", "Cruise?! You're alive?!"],
    id: "cruise",
    label: "CRUISE",
    lidar: false,
    model: "robotaxi-cruise",
    pickupLines: [
      "we're back! probably",
      "hi, this car's name is Tostada",
      "ignore the recall notice",
      "the DMV can't see us here",
    ],
    price: 30,
  },
  {
    accent: "#2fbfae",
    blurb: "the toaster",
    dropoffLines: [
      "it's not a car™",
      "exiting the carriage",
      "four-wheel steering flex",
      "Amazon thanks you",
    ],
    fit: { length: 2.55, yaw: -Math.PI / 2 },
    heckles: [
      "Which end is the FRONT?!",
      "The toaster fights back!",
      "It doesn't even have a FACE!",
    ],
    id: "zoox",
    label: "ZOOX",
    lidar: false,
    model: "robotaxi-zoox",
    pickupLines: [
      "no steering wheel, no problem",
      "face-to-face seating, deal with it",
      "this end is the front now",
      "welcome aboard the carriage",
    ],
    price: 130,
  },
  {
    accent: "#ff2db8",
    blurb: "peace, love, carstache",
    dropoffLines: [
      "round up for charity?",
      "peace, love, carstache",
      "tell your friends!",
      "the mustache waves goodbye",
    ],
    heckles: [
      "Nice mustache, jerk!",
      "2014 called, wants its 'stache back",
      "Wait, a HUMAN did that?!",
    ],
    id: "lyft",
    label: "LYFT",
    lidar: false,
    model: "lyft-sedan",
    mustache: true,
    pickupLines: [
      "fist bump!",
      "love the pink 'stache",
      "sit up front, it's the law",
      "the 'stache is load-bearing",
    ],
    price: 600,
  },
  {
    accent: "#e8e8e8",
    blurb: "your driver has arrived",
    dropoffLines: [
      "4.9 stars, don't ruin it",
      "water bottle's on me",
      "quiet ride preference noted",
      "pin dropped… somewhere near here",
    ],
    heckles: ["Surge THIS!", "You drive like a 4.2!", "My Uber driver would NEVER"],
    id: "uber",
    label: "UBER",
    lidar: false,
    model: "uber-sedan",
    pickupLines: [
      "your driver has arrived",
      "surge pricing, sorry",
      "got the aux?",
      "you're not the pin, get in",
    ],
    price: 15_700,
  },
  {
    accent: "#c9cbd1",
    blurb: "cameras only, good luck",
    dropoffLines: [
      "tip in DOGE?",
      "the beta ends eventually",
      "wireless charging, somewhere",
      "*butterfly doors*",
    ],
    fit: { length: 2.75, yaw: Math.PI / 2 },
    heckles: ["Where are your MIRRORS?!", "CAMERAS?! That's it?!", "Elon, come get your car"],
    id: "cybercab",
    label: "CYBERCAB",
    lidar: false,
    model: "robotaxi-cybercab",
    pickupLines: [
      "two seats, zero pedals",
      "cameras only, trust me",
      "doors go up",
      "FSD (Supervised) (by you)",
    ],
    price: 44_000,
  },
];

/** The GLB a skin's body is built from. The generated operator bodies are not
 *  in the boot preload (see manifest GEN_ROBOTAXIS) — await
 *  `cache.ensure(skinModelUrl(skin))` before buildSkinBody or the body comes
 *  back as the loader's fallback box. */
export const skinModelUrl = (skin: RobotaxiSkin) => modelUrl("cars", skin.model);

export const skinById = (id: string | undefined | null) => {
  const [first] = ROBOTAXI_SKINS;

  if (!first) {
    throw new Error("no skins");
  }

  if (id === undefined || id === null || id === "") {
    return first;
  }

  return ROBOTAXI_SKINS.find((s) => s.id === id) ?? first;
};

const STACHE_PINK = new THREE.MeshStandardMaterial({ color: 0xff_2d_b8, roughness: 0.55 });

applySunRim(STACHE_PINK, RIM_HERO);

export const buildCarstache = () => {
  const g = new THREE.Group();

  const lobe = (x: number, y: number, sx: number, sy: number, roll: number) => {
    const m = new THREE.Mesh(new THREE.SphereGeometry(0.5, 12, 8), STACHE_PINK);
    m.scale.set(sx, sy, 0.16);
    m.position.set(x, y, 1.3);
    m.rotation.z = roll;
    m.castShadow = true;
    g.add(m);
  };

  lobe(-0.27, 0.6, 0.62, 0.3, 0.28);
  lobe(0.27, 0.6, 0.62, 0.3, -0.28);
  lobe(-0.62, 0.5, 0.4, 0.2, 0.8);
  lobe(0.62, 0.5, 0.4, 0.2, -0.8);

  return g;
};

export const buildWaymoSensors = () => {
  const g = new THREE.Group();

  const add = (geo: THREE.BufferGeometry, mat: THREE.Material, x: number, y: number, z: number) => {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z);
    m.castShadow = true;
    g.add(m);

    return m;
  };

  const roofY = 1.3;
  add(new THREE.CylinderGeometry(0.15, 0.19, 0.12, 12), LIDAR_WHITE, 0, roofY + 0.05, 0.08);
  add(new THREE.CylinderGeometry(0.24, 0.24, 0.2, 16), LIDAR_DARK, 0, roofY + 0.2, 0.08);
  add(new THREE.CylinderGeometry(0.25, 0.25, 0.04, 16), LIDAR_BLUE, 0, roofY + 0.25, 0.08);
  add(
    new THREE.SphereGeometry(0.24, 16, 8, 0, Math.PI * 2, 0, Math.PI / 2),
    LIDAR_WHITE,
    0,
    roofY + 0.3,
    0.08,
  );

  const doorX = 0.63;
  const podY = 0.9;

  for (const sx of [-1, 1] as const) {
    add(new THREE.BoxGeometry(0.2, 0.15, 0.3), LIDAR_DARK, sx * doorX, podY, 0.42);
    add(
      new THREE.CylinderGeometry(0.055, 0.055, 0.08, 10),
      LIDAR_BLUE,
      sx * (doorX + 0.1),
      podY,
      0.42,
    ).rotateZ(Math.PI / 2);
  }

  for (const z of [1.28, -1.28] as const) {
    add(new THREE.BoxGeometry(0.46, 0.11, 0.09), LIDAR_DARK, 0, 0.42, z);
  }

  return g;
};

export const buildSkinBody = (cache: ModelCache, skin: RobotaxiSkin) => {
  let body = cache.instance(modelUrl("cars", skin.model));

  if (skin.fit) {
    const inner = body;
    inner.rotation.y = skin.fit.yaw ?? 0;
    inner.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(inner);
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    const sc = skin.fit.length / Math.max(size.z, 0.001);
    const wrap = new THREE.Group();
    inner.position.set(-center.x * sc, -box.min.y * sc, -center.z * sc);
    inner.scale.setScalar(sc);
    wrap.add(inner);
    body = wrap;
  }

  const tint = skin.tint === undefined ? null : new THREE.Color(skin.tint);

  if (!skin.fit || tint) {
    body.traverse((c) => {
      if (c instanceof THREE.Mesh && c.material instanceof THREE.MeshStandardMaterial) {
        c.material = lacquerMaterial(c.material, tint);
      }
    });
  } else {
    body.traverse((c) => {
      if (
        c instanceof THREE.Mesh &&
        !Array.isArray(c.material) &&
        c.material instanceof THREE.MeshStandardMaterial
      ) {
        applySunRim(c.material, RIM_HERO);
      }
    });
  }

  if (skin.lidar) {
    body.add(buildWaymoSensors());
  }

  if (skin.mustache === true) {
    body.add(buildCarstache());
  }

  addInkHulls(body);

  return body;
};

interface NightRig {
  readonly group: THREE.Group;
  readonly spot: THREE.SpotLight;
  readonly headMats: THREE.SpriteMaterial[];
  readonly tailMats: THREE.SpriteMaterial[];
}

const buildNightRig = () => {
  const group = new THREE.Group();
  const tex = radialGlowTexture();
  const headMats: THREE.SpriteMaterial[] = [];
  const tailMats: THREE.SpriteMaterial[] = [];

  const spot = new THREE.SpotLight(0xff_ed_c9, 0, 70, 0.58, 0.7, 1.1);
  spot.position.set(0, 1, 0.9);
  spot.castShadow = false;
  spot.target.position.set(0, -0.6, 16);
  group.add(spot);
  group.add(spot.target);

  for (const sx of [-1, 1] as const) {
    const head = new THREE.SpriteMaterial({
      blending: THREE.AdditiveBlending,
      color: 0xff_f3_d0,
      depthWrite: false,
      map: tex,
      opacity: 0,
      transparent: true,
    });

    const hs = new THREE.Sprite(head);
    hs.scale.setScalar(0.85);
    hs.position.set(sx * 0.5, 0.58, 1.34);
    group.add(hs);
    headMats.push(head);

    const tail = new THREE.SpriteMaterial({
      blending: THREE.AdditiveBlending,
      color: 0xff_3b_30,
      depthWrite: false,
      map: tex,
      opacity: 0,
      transparent: true,
    });

    const ts = new THREE.Sprite(tail);
    ts.scale.setScalar(0.5);
    ts.position.set(sx * 0.52, 0.6, -1.38);
    group.add(ts);
    tailMats.push(tail);
  }

  return { group, headMats, spot, tailMats };
};

const gripFor = (airborne: boolean, drifting: boolean) => {
  if (airborne) {
    return 0.4;
  }

  return drifting ? CAR.gripDrift : CAR.gripNormal;
};

const pitchFor = (input: CarInput, vForward: number) => {
  if (input.brake > 0.05 && vForward > 1) {
    return 0.05;
  }

  return input.throttle > 0 ? -0.025 : 0;
};

export class Car {
  readonly object3D: THREE.Group;
  private body: THREE.Object3D;
  private readonly wheels: { node: THREE.Object3D; front: boolean; restY: number; phys: number }[] =
    [];
  readonly position = new THREE.Vector3();
  readonly velocity = new THREE.Vector2();
  heading = 0;
  boostMeter: number = CAR.boostMax;
  private driftSustain = 0;
  isDrifting = false;
  isBoosting = false;
  lastWallHit = 0;
  lastWallNormal = new THREE.Vector2();
  wallContact = false;
  miniBoostFired = false;
  miniTurboTier: 0 | 1 | 2 = 0;
  driftTier: 0 | 1 | 2 = 0;
  boostDenied = false;
  private boostArmed = true;
  private boostHeldPrev = false;
  airborne = false;
  airTime = 0;
  justLanded = 0;
  private yVel = 0;
  private vyGround = 0;
  slip = 0;
  private roll = 0;
  private pitch = 0;
  private squash = 0;
  private steerSmoothed = 0;
  private wheelSpin = 0;
  private surface: Surface | null = null;
  private readonly scratchN = new THREE.Vector3();
  private readonly targetQuat = new THREE.Quaternion();
  private readonly pitchQuat = new THREE.Quaternion();

  private readonly nightRig: NightRig;
  private nightFactor = -1;
  private readonly contactShadow: ContactShadow;
  private trafficRimDone = false;
  private trafficRimTimer = 0;
  private vehicle: RaycastVehicle | null = null;
  private readonly prevVelP = new THREE.Vector3();
  private wasAirborne = false;
  private readonly v3a = new THREE.Vector3();
  private readonly v3b = new THREE.Vector3();
  private readonly q3a = new THREE.Quaternion();
  private readonly prevPos = new THREE.Vector3();
  private readonly prevQuat = new THREE.Quaternion();
  private readonly simPos = new THREE.Vector3();
  private readonly simQuat = new THREE.Quaternion();
  private poseSeeded = false;

  private readonly cache: ModelCache;

  constructor(cache: ModelCache, skinId?: string) {
    this.cache = cache;
    this.object3D = new THREE.Group();
    this.object3D.scale.setScalar(1.12);
    this.body = buildSkinBody(cache, skinById(skinId));
    this.collectWheels();
    this.contactShadow = new ContactShadow();
    this.contactShadow.setLayout(this.wheelLayout());
    this.contactShadow.mesh.position.y = SHADOW_LIFT / this.object3D.scale.y;
    this.object3D.add(this.contactShadow.mesh);
    this.nightRig = buildNightRig();
    this.body.add(this.nightRig.group);
    this.setHeadlights(0);
    this.object3D.add(this.body);
    this.trafficRimDone = applyTrafficSunRim(cache);
  }

  private wheelLayout() {
    return this.wheels.map((w) => ({ x: w.node.position.x, z: w.node.position.z }));
  }

  private collectWheels() {
    this.wheels.length = 0;
    this.body.traverse((c) => {
      if (c.name.startsWith("wheel")) {
        const front = c.name.includes("front");
        const phys = (front ? 0 : 2) + (c.position.x < 0 ? 0 : 1);
        this.wheels.push({ front, node: c, phys, restY: c.position.y });
      }
    });
  }

  setSkin(skinId: string) {
    const skin = skinById(skinId);
    this.body.remove(this.nightRig.group);
    this.object3D.remove(this.body);
    this.body = buildSkinBody(this.cache, skin);
    this.collectWheels();
    this.contactShadow.setLayout(this.wheelLayout());
    this.body.add(this.nightRig.group);
    const nf = this.nightFactor;
    this.nightFactor = -1;
    this.setHeadlights(Math.max(0, nf));
    this.object3D.add(this.body);
  }

  setHeadlights(f: number) {
    if (Math.abs(f - this.nightFactor) < 0.005) {
      return;
    }

    this.nightFactor = f;
    const rig = this.nightRig;
    rig.spot.intensity = 70 * f;

    for (const m of rig.headMats) {
      m.opacity = 0.75 * f;
    }

    for (const m of rig.tailMats) {
      m.opacity = 0.55 * f;
    }
  }

  setSurface(s: Surface) {
    this.surface = s;
    this.bindWaterSampler();
  }

  private bindWaterSampler() {
    const { surface } = this;
    const sample = surface?.waterHeightAt;
    this.vehicle?.setWaterSampler(
      surface === null || sample === undefined
        ? null
        : {
            waterHeightAt: (x, z) => sample.call(surface, x, z),
          },
    );
  }

  get waterContact() {
    return this.vehicle?.waterContact ?? DRY_WATER_CONTACT;
  }

  get speed() {
    return this.velocity.length();
  }
  get velX() {
    return this.velocity.x;
  }
  get velZ() {
    return this.velocity.y;
  }
  get forwardSpeed() {
    return this.velocity.x * Math.sin(this.heading) + this.velocity.y * Math.cos(this.heading);
  }
  get velAngle() {
    return this.speed > 0.5 ? Math.atan2(this.velocity.x, this.velocity.y) : null;
  }
  get steer() {
    return this.steerSmoothed;
  }
  get driftCharge() {
    if (this.vehicle) {
      return this.vehicle.driftCharge01;
    }

    return Math.min(1, this.driftSustain / CAR.driftSlingArm);
  }

  reset(x: number, z: number, yaw: number) {
    this.position.set(x, ROAD_Y, z);
    this.velocity.set(0, 0);
    this.heading = yaw;
    this.boostMeter = CAR.boostMax;
    this.driftSustain = 0;
    this.isDrifting = false;
    this.isBoosting = false;
    this.airborne = false;
    this.airTime = 0;
    this.justLanded = 0;
    this.yVel = 0;
    this.vyGround = 0;
    this.slip = 0;
    this.roll = 0;
    this.pitch = 0;
    this.steerSmoothed = 0;

    if (this.surface) {
      this.position.y = this.surface.heightAt(x, z) + ROAD_Y;
    }

    if (this.vehicle) {
      this.vehicle.teleport(x, this.position.y + 1.4, z, yaw);
      this.prevVelP.set(0, 0, 0);
      this.poseSeeded = false;

      return;
    }

    this.syncTransform(1, true);
  }

  addBoost(amount: number) {
    this.boostMeter = Math.min(CAR.boostMax, this.boostMeter + amount);
  }

  attachPhysics(vehicle: RaycastVehicle) {
    this.vehicle = vehicle;
    this.bindWaterSampler();
    vehicle.params.cruiseSpeed = CAR.maxSpeed;
    vehicle.params.maxSpeed = CAR.boostSpeed;

    const y = this.surface
      ? this.surface.heightAt(this.position.x, this.position.z) + 1.4
      : this.position.y + 1.4;

    vehicle.teleport(this.position.x, y, this.position.z, this.heading);
    this.poseSeeded = false;
  }

  get physicsVehicle() {
    return this.vehicle;
  }

  physicsFixedStep(fixedDt: number) {
    this.vehicle?.fixedStep(fixedDt);
  }

  private updatePhysicsControls(dt: number, input: CarInput, solids: SolidIndex) {
    const veh = this.vehicle;

    if (!veh) {
      return;
    }

    this.miniBoostFired = false;
    this.miniTurboTier = 0;
    this.boostDenied = false;

    if (this.boostMeter <= 0.5) {
      this.boostArmed = false;
    } else if (this.boostMeter >= 15) {
      this.boostArmed = true;
    }

    const boostHeld = input.boost;
    const wantBoost = boostHeld && this.boostArmed;
    this.boostDenied = boostHeld && !this.boostArmed && !this.boostHeldPrev;
    this.boostHeldPrev = boostHeld;
    this.isBoosting = wantBoost;
    this.drainBoost(dt, wantBoost);

    this.steerSmoothed += (input.steer - this.steerSmoothed) * Math.min(1, dt / CAR.steerRamp);
    veh.steerInput = input.steer;
    veh.setControls(input, wantBoost);

    this.isDrifting = veh.isDrifting;
    this.driftTier = veh.driftTier;

    if (this.isDrifting) {
      this.addBoost(CAR.boostPerDriftSec * dt);
    }

    const turbo = veh.consumeMiniTurbo();

    if (turbo > 0) {
      this.miniBoostFired = true;
      this.miniTurboTier = turbo;
    }

    const r = 1.6;
    solids.forEachIn(
      this.position.x - r,
      this.position.x + r,
      this.position.z - r,
      this.position.z + r,
      this.noBodyBounce,
    );
  }

  private readonly noBodyBounce = (s: Solid) => {
    const veh = this.vehicle;

    if (!veh || s.noBody !== true) {
      return;
    }

    if (s.maxY !== undefined && this.position.y > s.maxY) {
      return;
    }

    const cx = THREE.MathUtils.clamp(this.position.x, s.minX, s.maxX);
    const cz = THREE.MathUtils.clamp(this.position.z, s.minZ, s.maxZ);
    const dx = this.position.x - cx;
    const dz = this.position.z - cz;
    const d2 = dx * dx + dz * dz;

    if (d2 >= 1.2 * 1.2 || d2 < 1e-6) {
      return;
    }

    const d = Math.sqrt(d2);
    const nx = dx / d;
    const nz = dz / d;
    const lv = veh.chassis.linvel();
    const vn = lv.x * nx + lv.z * nz;

    if (vn < 0) {
      const m = veh.params.mass;
      veh.chassis.applyImpulse({ x: -nx * vn * 1.4 * m, y: 0, z: -nz * vn * 1.4 * m }, true);
      this.wallContact = true;
      this.lastWallNormal.set(nx, nz);

      if (-vn > this.lastWallHit) {
        this.lastWallHit = -vn;
      }
    }
  };

  /** Snapshot the chassis after each fixed step. Called from inside the
   *  physics loop, so the pair always straddles the render clock. A teleport
   *  clears the seed (see reset) — without that the car would be lerped across
   *  the map from wherever it used to be. */
  captureStep() {
    const veh = this.vehicle;

    if (!veh) {
      return;
    }

    if (this.poseSeeded) {
      this.prevPos.copy(this.simPos);
      this.prevQuat.copy(this.simQuat);
    }

    const t = veh.chassis.translation();
    this.simPos.set(t.x, t.y, t.z);
    veh.quaternion(this.simQuat);

    if (!this.poseSeeded) {
      this.prevPos.copy(this.simPos);
      this.prevQuat.copy(this.simQuat);
      this.poseSeeded = true;
    }
  }

  syncFromPhysics(dt: number, alpha = 1) {
    const veh = this.vehicle;

    if (!veh) {
      return;
    }

    const floating = veh.waterContact.kind === "floating";
    this.lastWallHit = 0;
    this.wallContact = false;
    this.justLanded = 0;

    if (!this.poseSeeded) {
      this.captureStep();
    }

    const t = this.v3b.lerpVectors(this.prevPos, this.simPos, alpha);
    this.q3a.slerpQuaternions(this.prevQuat, this.simQuat, alpha);
    const fwd = this.v3a.set(0, 0, 1).applyQuaternion(this.q3a);
    this.heading = Math.atan2(fwd.x, fwd.z);
    this.position.set(t.x, t.y - 0.62, t.z);
    this.object3D.position.copy(this.position);
    this.object3D.quaternion.copy(this.q3a);

    const lv = veh.chassis.linvel();
    const prevSpeed = Math.hypot(this.prevVelP.x, this.prevVelP.z);
    const curSpeed = Math.hypot(lv.x, lv.z);
    const deltaV = prevSpeed - curSpeed;

    if (!floating && deltaV > 7 && prevSpeed > 8) {
      this.lastWallHit = deltaV;
      this.wallContact = true;
      const inv = prevSpeed > 1e-3 ? 1 / prevSpeed : 0;
      this.lastWallNormal.set(-this.prevVelP.x * inv, -this.prevVelP.z * inv);
    }

    this.prevVelP.set(lv.x, lv.y, lv.z);

    this.velocity.set(lv.x, lv.z);
    const va = this.velAngle;
    this.slip = va === null ? 0 : ((va - this.heading + Math.PI * 3) % (Math.PI * 2)) - Math.PI;

    const airborneNow = !floating && veh.groundedWheels() === 0 && veh.airTimeSeconds > 0.12;

    if (airborneNow) {
      this.airTime = veh.airTimeSeconds;
    }

    if (!floating && this.wasAirborne && !airborneNow) {
      this.justLanded = Math.max(0, -lv.y * 0.5 + 4);
      this.squash = Math.min(1, 0.45 + this.justLanded * 0.035);
    }

    this.airborne = airborneNow;

    if (floating) {
      this.airTime = 0;
      this.isDrifting = false;
      this.driftTier = 0;
      this.miniTurboTier = 0;
      this.miniBoostFired = false;
    }

    this.wasAirborne = airborneNow;
    this.yVel = lv.y;

    this.syncWheelsFromPhysics(dt, veh);
    this.contactShadow.update(dt, !airborneNow && !floating);
    this.squash = Math.max(0, this.squash - dt * 5.5);
    const sq = this.squash;
    this.body.scale.set(1 + 0.12 * sq, 1 - 0.26 * sq, 1 + 0.12 * sq);

    if (t.y < -20 && this.surface) {
      const x = clampInsideMap(t.x, WORLD_HALF_X);
      const z = clampInsideMap(t.z, WORLD_HALF_Z);
      veh.teleport(x, this.surface.heightAt(x, z) + 1.4, z, this.heading);
      this.poseSeeded = false;
    }
  }

  update(dt: number, input: CarInput, solids: SolidIndex) {
    this.tickTrafficRim(dt);

    if (this.vehicle) {
      this.updatePhysicsControls(dt, input, solids);

      return;
    }

    this.lastWallHit = 0;
    this.wallContact = false;
    this.miniBoostFired = false;
    this.miniTurboTier = 0;
    this.justLanded = 0;
    this.boostDenied = false;
    const fwd = new THREE.Vector2(Math.sin(this.heading), Math.cos(this.heading));
    const perp = new THREE.Vector2(fwd.y, -fwd.x);

    const vForward0 = this.velocity.dot(fwd);
    const vLateral = this.velocity.dot(perp);

    const wantBoost = this.updateBoostState(input);
    const topSpeed = wantBoost ? CAR.boostSpeed : CAR.maxSpeed;
    let vForward = this.longitudinalSpeed(dt, input, vForward0, wantBoost, topSpeed);

    this.drainBoost(dt, wantBoost);

    const absF = Math.abs(vForward);
    const va = this.velAngle;
    this.slip = va === null ? 0 : ((va - this.heading + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
    const physicsDrift = input.brake > 0.05 && absF > CAR.driftMinSpeed && !this.airborne;
    this.isDrifting =
      physicsDrift &&
      (Math.abs(this.slip) > CAR.driftMinSlip || Math.abs(this.steerSmoothed) > 0.35);
    const speedFrac = THREE.MathUtils.clamp(absF / CAR.maxSpeed, 0, 1);
    this.applySteering(dt, input, vForward, absF, speedFrac, physicsDrift);
    vForward = this.driftBoost(dt, physicsDrift, vForward, topSpeed);

    const nf = new THREE.Vector2(Math.sin(this.heading), Math.cos(this.heading));
    const np = new THREE.Vector2(nf.y, -nf.x);
    const grip = gripFor(this.airborne, physicsDrift);
    const latRetain = Math.exp(-grip * dt);
    this.velocity
      .copy(nf)
      .multiplyScalar(vForward)
      .addScaledVector(np, vLateral * latRetain);

    this.integrateAndCollide(dt, solids);
    this.verticalStep(dt);
    this.visualLean(dt, input, speedFrac, physicsDrift, vForward);
    this.spinWheels(dt, vForward);
    this.contactShadow.update(dt, !this.airborne);

    this.syncTransform(dt);
  }

  private tickTrafficRim(dt: number) {
    if (!this.trafficRimDone) {
      this.trafficRimTimer -= dt;

      if (this.trafficRimTimer <= 0) {
        this.trafficRimTimer = 1;
        this.trafficRimDone = applyTrafficSunRim(this.cache);
      }
    }
  }

  private updateBoostState(input: CarInput) {
    if (this.boostMeter <= 0.5) {
      this.boostArmed = false;
    } else if (this.boostMeter >= 15) {
      this.boostArmed = true;
    }

    const boostHeld = input.boost;
    const wantBoost = boostHeld && this.boostArmed;
    this.boostDenied = boostHeld && !this.boostArmed && !this.boostHeldPrev;
    this.boostHeldPrev = boostHeld;
    this.isBoosting = wantBoost;

    return wantBoost;
  }

  private longitudinalSpeed(
    dt: number,
    input: CarInput,
    forward: number,
    wantBoost: boolean,
    topSpeed: number,
  ) {
    let vForward = forward;

    if (input.brake > 0.05 && vForward <= 0.5) {
      vForward = Math.max(vForward - CAR.reverseAccel * dt, -CAR.reverseMax);
    } else if (input.throttle > 0 || wantBoost) {
      vForward += CAR.accel * dt;
    } else if (input.brake > 0.05) {
      vForward -= CAR.brakeDecel * dt;
    } else {
      const drop = CAR.coastDecel * dt;
      vForward = vForward > 0 ? Math.max(0, vForward - drop) : Math.min(0, vForward + drop);
    }

    vForward = THREE.MathUtils.clamp(vForward, -CAR.reverseMax, topSpeed);

    if (this.surface && !this.airborne) {
      const n = this.surface.normalInto(this.scratchN, this.position.x, this.position.z);
      const ny = Math.max(n.y, 0.05);
      const slope = (-n.x / ny) * Math.sin(this.heading) + (-n.z / ny) * Math.cos(this.heading);
      vForward -= CAR.slopeGravity * slope * dt;
      vForward = THREE.MathUtils.clamp(vForward, -CAR.reverseMax * 1.5, topSpeed * 1.35);
    }

    return vForward;
  }

  private drainBoost(dt: number, wantBoost: boolean) {
    this.boostMeter = wantBoost
      ? Math.max(0, this.boostMeter - CAR.boostDrain * dt)
      : Math.min(CAR.boostMax, this.boostMeter + CAR.boostRefill * dt);
  }

  private applySteering(
    dt: number,
    input: CarInput,
    vForward: number,
    absF: number,
    speedFrac: number,
    physicsDrift: boolean,
  ) {
    let authority = THREE.MathUtils.lerp(1, CAR.turnSpeedFalloff, speedFrac);

    if (this.airborne) {
      authority *= CAR.airSteerFactor;
    }

    const startFade = THREE.MathUtils.clamp(absF / 3, 0, 1);
    const driftMul = physicsDrift ? CAR.driftTurnBoost : 1;
    const dir = vForward >= 0 ? 1 : -1;
    this.steerSmoothed += (input.steer - this.steerSmoothed) * Math.min(1, dt / CAR.steerRamp);
    this.heading -= this.steerSmoothed * CAR.turnRate * authority * startFade * driftMul * dir * dt;
  }

  private driftBoost(dt: number, physicsDrift: boolean, forward: number, topSpeed: number) {
    let vForward = forward;

    if (this.isDrifting) {
      this.driftSustain += dt;
      this.addBoost(CAR.boostPerDriftSec * dt);
    } else if (!physicsDrift) {
      if (this.driftSustain > CAR.driftSlingArm) {
        vForward = Math.min(topSpeed, vForward + CAR.miniBoostImpulse);
        this.miniBoostFired = true;
        this.miniTurboTier = 1;
      }

      this.driftSustain = 0;
    }

    this.driftTier = this.isDrifting && this.driftCharge >= 1 ? 1 : 0;

    return vForward;
  }

  private integrateAndCollide(dt: number, solids: SolidIndex) {
    let remaining = dt;

    while (remaining > 1e-5) {
      const sp = this.velocity.length();
      const stepDt = sp > 1e-4 ? Math.min(remaining, 0.5 / sp) : remaining;
      this.position.x += this.velocity.x * stepDt;
      this.position.z += this.velocity.y * stepDt;
      this.resolveCollisions(solids);
      remaining -= stepDt;
    }
  }

  private verticalStep(dt: number) {
    if (this.surface) {
      const s = this.surface;
      const axX = Math.sin(this.heading) * 1.2;
      const axZ = Math.cos(this.heading) * 1.2;

      const g =
        Math.max(
          s.heightAt(this.position.x, this.position.z),
          (s.heightAt(this.position.x + axX, this.position.z + axZ) +
            s.heightAt(this.position.x - axX, this.position.z - axZ)) /
            2,
        ) + ROAD_Y;

      if (this.airborne) {
        this.yVel -= CAR.gravity * dt;
        this.position.y += this.yVel * dt;
        this.airTime += dt;

        if (this.position.y <= g) {
          this.justLanded = Math.max(0, -this.yVel);
          this.squash = Math.min(1, 0.45 + this.justLanded * 0.035);
          this.position.y = g;
          this.airborne = false;
          this.yVel = 0;
          this.vyGround = 0;
        }
      } else {
        const prevY = this.position.y;
        const safeDt = Math.max(dt, 1e-4);
        const vyNeeded = (g - prevY) / safeDt;
        const groundAccel = (vyNeeded - this.vyGround) / safeDt;

        if (groundAccel < -(CAR.gravity + 8) && this.speed > CAR.minAirSpeed) {
          this.airborne = true;
          this.airTime = 0;
          this.yVel = Math.min(this.vyGround, CAR.maxLaunchVy) - CAR.gravity * dt;
          this.position.y = Math.max(g, prevY + this.yVel * dt);
        } else {
          this.position.y = g;
          this.vyGround = THREE.MathUtils.clamp(vyNeeded, -40, 40);
        }
      }
    }
  }

  private visualLean(
    dt: number,
    input: CarInput,
    speedFrac: number,
    physicsDrift: boolean,
    vForward: number,
  ) {
    const targetRoll = -input.steer * speedFrac * (physicsDrift ? 0.34 : 0.18);
    this.roll += (targetRoll - this.roll) * Math.min(1, dt * 10);
    const targetPitch = pitchFor(input, vForward);
    this.pitch += (targetPitch - this.pitch) * Math.min(1, dt * 8);
    this.squash = Math.max(0, this.squash - dt * 5.5);
  }

  private spinWheels(dt: number, vForward: number) {
    this.wheelSpin += (vForward / WHEEL_RADIUS) * dt;

    for (const w of this.wheels) {
      w.node.rotation.x = this.wheelSpin;

      if (w.front) {
        w.node.rotation.y = this.steerSmoothed * -0.42;
      }
    }
  }

  private syncWheelsFromPhysics(dt: number, veh: RaycastVehicle) {
    const fwdSpeed = this.forwardSpeed;
    this.wheelSpin += (fwdSpeed / WHEEL_RADIUS) * dt;
    const steerAngle = veh.wheelVisual(0).steering;
    const rest = veh.params.suspensionRestLength;
    const invScale = 1 / this.object3D.scale.y;

    for (let i = 0; i < this.wheels.length; i += 1) {
      const w = this.wheels[i];

      if (!w) {
        continue;
      }

      w.node.rotation.x = this.wheelSpin;

      if (w.front) {
        w.node.rotation.y = steerAngle;
      }

      const travel = rest - veh.wheelVisual(w.phys).suspension;
      w.node.position.y = w.restY + THREE.MathUtils.clamp(travel, -0.12, 0.2) * invScale;
      this.contactShadow.setWheelTravel(i, travel);
    }
  }

  contactPunt(nx: number, nz: number, separation: number) {
    const vn = this.velocity.x * nx + this.velocity.y * nz;

    if (this.vehicle) {
      return Math.max(0, vn);
    }

    if (separation > 0) {
      this.position.x -= nx * separation;
      this.position.z -= nz * separation;
    }

    if (vn > 0) {
      this.velocity.x -= nx * vn * 0.55;
      this.velocity.y -= nz * vn * 0.55;
    }

    return Math.max(0, vn);
  }

  private readonly collideOne = (s: Solid) => {
    if (s.maxY !== undefined && this.position.y > s.maxY) {
      return;
    }

    const bx = (s.minX + s.maxX) / 2;
    const bz = (s.minZ + s.maxZ) / 2;
    const hx = (s.maxX - s.minX) / 2;
    const hz = (s.maxZ - s.minZ) / 2;
    const yaw = s.yaw ?? 0;
    const cos = Math.cos(yaw);
    const sin = Math.sin(yaw);
    const wdx = this.position.x - bx;
    const wdz = this.position.z - bz;
    const lx = wdx * cos - wdz * sin;
    const lz = wdx * sin + wdz * cos;
    const qx = THREE.MathUtils.clamp(lx, -hx, hx);
    const qz = THREE.MathUtils.clamp(lz, -hz, hz);
    const dx = lx - qx;
    const dz = lz - qz;
    const d2 = dx * dx + dz * dz;

    if (d2 >= COLLIDE_RADIUS * COLLIDE_RADIUS) {
      return;
    }

    let nlx: number;
    let nlz: number;
    let pen: number;

    if (d2 > 1e-6) {
      const d = Math.sqrt(d2);
      nlx = dx / d;
      nlz = dz / d;
      pen = COLLIDE_RADIUS - d;
    } else {
      const toLeft = lx + hx;
      const toRight = hx - lx;
      const toTop = lz + hz;
      const toBot = hz - lz;
      const m = Math.min(toLeft, toRight, toTop, toBot);

      if (m === toLeft) {
        nlx = -1;
        nlz = 0;
      } else if (m === toRight) {
        nlx = 1;
        nlz = 0;
      } else if (m === toTop) {
        nlx = 0;
        nlz = -1;
      } else {
        nlx = 0;
        nlz = 1;
      }

      pen = COLLIDE_RADIUS + m;
    }

    const nx = nlx * cos + nlz * sin;
    const nz = -nlx * sin + nlz * cos;
    this.position.x += nx * pen;
    this.position.z += nz * pen;
    this.wallContact = true;
    this.lastWallNormal.set(nx, nz);
    const vn = this.velocity.x * nx + this.velocity.y * nz;

    if (vn < 0) {
      const impact = -vn;

      if (impact > this.lastWallHit) {
        this.lastWallHit = impact;
      }

      this.velocity.x -= (1 + CAR.bounce) * vn * nx;
      this.velocity.y -= (1 + CAR.bounce) * vn * nz;
    }
  };

  private resolveCollisions(solids: SolidIndex) {
    const r = COLLIDE_RADIUS + 0.1;
    solids.forEachIn(
      this.position.x - r,
      this.position.x + r,
      this.position.z - r,
      this.position.z + r,
      this.collideOne,
    );
  }

  private syncTransform(dt: number, snap = false) {
    if (this.surface && !this.airborne) {
      const n = this.surface.normalInto(this.scratchN, this.position.x, this.position.z);
      slopeQuaternion(this.targetQuat, this.heading + MODEL_YAW_OFFSET, n);
    } else if (this.airborne) {
      slopeQuaternion(this.targetQuat, this.heading + MODEL_YAW_OFFSET, UP);
      const arc = THREE.MathUtils.clamp(Math.atan2(-this.yVel, Math.max(this.speed, 8)), -0.5, 0.6);
      this.pitchQuat.setFromAxisAngle(X_AXIS, arc);
      this.targetQuat.multiply(this.pitchQuat);
    } else {
      slopeQuaternion(this.targetQuat, this.heading + MODEL_YAW_OFFSET, UP);
    }

    if (snap) {
      this.object3D.quaternion.copy(this.targetQuat);
    } else {
      const rate = this.airborne ? 6 : 13;
      this.object3D.quaternion.slerp(this.targetQuat, Math.min(1, dt * rate));
    }

    this.object3D.position.copy(this.position);
    this.body.rotation.z = this.roll;
    this.body.rotation.x = this.pitch;
    const sq = this.squash;
    this.body.scale.set(1 + 0.12 * sq, 1 - 0.26 * sq, 1 + 0.12 * sq);
  }
}
