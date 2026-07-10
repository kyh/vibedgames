import * as THREE from "three";

import type { ModelCache } from "../assets/loader";
import { modelUrl, PLAYER_CAR } from "../assets/manifest";
import type { RaycastVehicle } from "./raycast-vehicle";
import { radialGlowTexture } from "../fx/lamp-glow";
import { CAR, ROAD_Y } from "../shared/constants";
import type { Solid } from "../world/city";
import type { SolidIndex } from "../world/solid-index";
import { slopeQuaternion } from "../world/terrain";

export type CarInput = {
  readonly throttle: number; // 0..1 gas
  // 0..1 — the ONE brake pedal (↓/S/Space, racing-game style): slows you,
  // drifts you (brake + steer), reverses you (brake from a stop), and
  // power-drifts with gas held.
  readonly brake: number;
  readonly steer: number; // -1 left .. +1 right
  readonly boost: boolean;
};

// What the car drives on: the terrain height field, possibly overridden by
// flat structures (pier decks). CityModel implements this.
export type Surface = {
  heightAt(x: number, z: number): number;
  normalInto(out: THREE.Vector3, x: number, z: number): THREE.Vector3;
};

// The Kenney car's body faces +Z, which matches our heading-0 forward (sin,cos),
// so no yaw offset is needed. (π here makes it drive rear-first.)
const MODEL_YAW_OFFSET = 0;
const COLLIDE_RADIUS = 1.05;
const WHEEL_RADIUS = 0.35;
const UP = new THREE.Vector3(0, 1, 0);
const X_AXIS = new THREE.Vector3(1, 0, 0);

// The Waymo self-driving sensor suite grafted onto the white crossover: the
// signature rooftop lidar dome, side mirror pods, and front bumper sensors.
// Built in the body's local space (model faces +Z; roof top ≈ y 1.5).
const LIDAR_WHITE = new THREE.MeshStandardMaterial({ color: 0xeef0f2, roughness: 0.7 });
const LIDAR_DARK = new THREE.MeshStandardMaterial({ color: 0x24272e, roughness: 0.5, metalness: 0.2 });
const LIDAR_BLUE = new THREE.MeshStandardMaterial({
  color: 0x2f7de0,
  emissive: 0x1a5fbf,
  emissiveIntensity: 0.4,
  roughness: 0.4,
});

// --- Robotaxi skins: swap the Waymo for other robotaxis. The Waymo body is a
// pre-baked recolor GLB; the others repaint a base car in-engine (cloned
// materials, multiply tint — windows/tires stay dark). Cybercab is camera-only,
// so it pointedly ships without the lidar dome.
export type RobotaxiSkin = {
  id: string;
  label: string;
  model: string;
  tint?: number;
  lidar: boolean;
  price: number; // run earnings; 0 = always owned
  blurb: string;
};

export const ROBOTAXI_SKINS: readonly RobotaxiSkin[] = [
  { id: "waymo", label: "WAYMO", model: PLAYER_CAR, lidar: true, price: 0, blurb: "the original" },
  { id: "cruise", label: "CRUISE", model: "hatchback-sports", tint: 0xff8b3d, lidar: true, price: 500, blurb: "pour one out" },
  { id: "zoox", label: "ZOOX", model: "van", tint: 0x2fbfae, lidar: true, price: 600, blurb: "the toaster" },
  { id: "cybercab", label: "CYBERCAB", model: "sedan-sports", tint: 0xc9cbd1, lidar: false, price: 900, blurb: "cameras only, good luck" },
];

export function skinById(id: string | undefined | null): RobotaxiSkin {
  const first = ROBOTAXI_SKINS[0];
  if (!first) throw new Error("no skins");
  if (!id) return first;
  return ROBOTAXI_SKINS.find((s) => s.id === id) ?? first;
}

// Build a skinned robotaxi body (model + optional repaint + sensor suite).
export function buildSkinBody(cache: ModelCache, skin: RobotaxiSkin): THREE.Object3D {
  const body = cache.instance(modelUrl("cars", skin.model));
  if (skin.tint !== undefined) {
    const tint = new THREE.Color(skin.tint);
    body.traverse((c) => {
      if (c instanceof THREE.Mesh && c.material instanceof THREE.MeshStandardMaterial) {
        const m = c.material.clone();
        m.color.multiply(tint).lerp(tint, 0.55);
        c.material = m;
      }
    });
  }
  if (skin.lidar) body.add(buildWaymoSensors());
  return body;
}

export function buildWaymoSensors(): THREE.Group {
  const g = new THREE.Group();
  const add = (
    geo: THREE.BufferGeometry,
    mat: THREE.Material,
    x: number,
    y: number,
    z: number,
  ): THREE.Mesh => {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z);
    m.castShadow = true;
    g.add(m);
    return m;
  };

  // Rooftop lidar (roof top ≈ y 1.3): a short white pylon flush to the roof, a
  // dark drum (the spinning sensor), a thin blue accent ring, and a domed cap —
  // the unmistakable Waymo silhouette, kept compact so it isn't gumball-tall.
  const roofY = 1.3;
  add(new THREE.CylinderGeometry(0.15, 0.19, 0.12, 12), LIDAR_WHITE, 0, roofY + 0.05, 0.08);
  add(new THREE.CylinderGeometry(0.24, 0.24, 0.2, 16), LIDAR_DARK, 0, roofY + 0.2, 0.08);
  add(new THREE.CylinderGeometry(0.25, 0.25, 0.04, 16), LIDAR_BLUE, 0, roofY + 0.25, 0.08);
  add(new THREE.SphereGeometry(0.24, 16, 8, 0, Math.PI * 2, 0, Math.PI / 2), LIDAR_WHITE, 0, roofY + 0.3, 0.08);

  // Perimeter sensor pods mounted on the front-door shoulder. The body side
  // there sits at |x| ≈ 0.65, so the pod centre straddles it (inner half sunk
  // into the door, no floating gap) and the blue lens caps the outer face.
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

  // Front + rear bumper radar nubs.
  for (const z of [1.28, -1.28] as const) {
    add(new THREE.BoxGeometry(0.46, 0.11, 0.09), LIDAR_DARK, 0, 0.42, z);
  }

  return g;
}

// Night lighting rig: one forward spotlight (the actual light on the road),
// plus head/tail glow sprites so the car reads lit from every angle. All off
// by day; setHeadlights(f) ramps the whole rig with the day-night factor.
type NightRig = {
  readonly group: THREE.Group;
  readonly spot: THREE.SpotLight;
  readonly headMats: THREE.SpriteMaterial[];
  readonly tailMats: THREE.SpriteMaterial[];
};

function buildNightRig(): NightRig {
  const group = new THREE.Group();
  const tex = radialGlowTexture();
  const headMats: THREE.SpriteMaterial[] = [];
  const tailMats: THREE.SpriteMaterial[] = [];

  // Wide-ish beam: at night the headlights are most of what lights the road,
  // so the cone covers the near street, not just a strip ahead of the hood.
  const spot = new THREE.SpotLight(0xffedc9, 0, 70, 0.58, 0.7, 1.1);
  spot.position.set(0, 1.0, 0.9);
  spot.castShadow = false;
  spot.target.position.set(0, -0.6, 16);
  group.add(spot);
  group.add(spot.target);

  for (const sx of [-1, 1] as const) {
    const head = new THREE.SpriteMaterial({
      map: tex,
      color: 0xfff3d0,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const hs = new THREE.Sprite(head);
    hs.scale.setScalar(0.85);
    hs.position.set(sx * 0.5, 0.58, 1.34);
    group.add(hs);
    headMats.push(head);

    const tail = new THREE.SpriteMaterial({
      map: tex,
      color: 0xff3b30,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const ts = new THREE.Sprite(tail);
    ts.scale.setScalar(0.5);
    ts.position.set(sx * 0.52, 0.6, -1.38);
    group.add(ts);
    tailMats.push(tail);
  }
  return { group, spot, headMats, tailMats };
}

export class Car {
  readonly object3D: THREE.Group;
  private body: THREE.Object3D;
  private wheels: { node: THREE.Object3D; front: boolean }[] = [];
  readonly position = new THREE.Vector3();
  private velocity = new THREE.Vector2(); // world XZ
  heading = 0; // yaw; forward = (sin, cos)
  boostMeter: number = CAR.boostMax;
  private driftSustain = 0; // seconds the current drift has lasted
  isDrifting = false;
  isBoosting = false;
  lastWallHit = 0; // impact speed of the last collision this frame (for fx)
  lastWallNormal = new THREE.Vector2(); // normal of the last wall contact
  wallContact = false; // touching a wall this frame (scrape detection)
  miniBoostFired = false; // true on the frame a charged drift is released
  miniTurboTier: 0 | 1 | 2 = 0; // tier of that release (physics drift; 1 in fallback)
  driftTier: 0 | 1 | 2 = 0; // current charge tier while drifting (FX color)
  boostDenied = false; // boost pressed with an empty meter (edge, one frame)
  private boostArmed = true; // hysteresis: off at 0.5, re-arms at 15
  private boostHeldPrev = false;
  // --- Airtime (hill jumps) ---
  airborne = false;
  airTime = 0; // seconds of the current/last flight
  justLanded = 0; // landing impact speed (v/s), one frame only
  private yVel = 0;
  private vyGround = 0; // vertical rate while following the ground
  // --- Feel exposures (fx / camera / audio read these) ---
  slip = 0; // signed angle between velocity and heading (radians)
  private roll = 0; // visual body lean
  private pitch = 0; // visual dive/squat
  private squash = 0; // landing suspension squash (1 = full)
  private steerSmoothed = 0; // ramped steering input
  private wheelSpin = 0;
  private surface: Surface | null = null;
  private scratchN = new THREE.Vector3();
  // Chassis attitude is slerped toward its target: smooths terrain-normal
  // jitter into suspension feel, and blends launches/landings.
  private targetQuat = new THREE.Quaternion();
  private pitchQuat = new THREE.Quaternion();

  private nightRig: NightRig;
  private nightFactor = -1; // last applied value; skip redundant writes
  // Physics mode: when attached, a Rapier raycast-vehicle drives the car and
  // the kinematic sim below is bypassed entirely.
  private vehicle: RaycastVehicle | null = null;
  private prevVelP = new THREE.Vector3();
  private wasAirborne = false;
  private v3a = new THREE.Vector3();
  private q3a = new THREE.Quaternion();

  constructor(
    private readonly cache: ModelCache,
    skinId?: string,
  ) {
    this.object3D = new THREE.Group();
    // Hero scale: the player car reads slightly larger than traffic so it owns
    // the frame.
    this.object3D.scale.setScalar(1.12);
    this.body = buildSkinBody(cache, skinById(skinId));
    this.collectWheels();
    this.nightRig = buildNightRig();
    this.body.add(this.nightRig.group);
    this.setHeadlights(0);
    this.object3D.add(this.body);
  }

  private collectWheels(): void {
    this.wheels.length = 0;
    this.body.traverse((c) => {
      if (c.name.startsWith("wheel")) {
        this.wheels.push({ node: c, front: c.name.includes("front") });
      }
    });
  }

  // Swap the robotaxi skin in place (V key). Keeps physics/pose; rebuilds the
  // visual body and carries the night rig over.
  setSkin(skinId: string): void {
    const skin = skinById(skinId);
    this.body.remove(this.nightRig.group);
    this.object3D.remove(this.body);
    this.body = buildSkinBody(this.cache, skin);
    this.collectWheels();
    this.body.add(this.nightRig.group);
    const nf = this.nightFactor;
    this.nightFactor = -1;
    this.setHeadlights(Math.max(0, nf));
    this.object3D.add(this.body);
  }

  // Ramp the night rig with the day-night lamp factor (0 day .. 1 night).
  // The spotlight stays IN the scene at all times (intensity fades to 0) —
  // toggling a light's presence churns every shader program against the
  // manually-updated shadow map and floods GL sampler-mismatch errors,
  // leaving the clear color where the city should be.
  setHeadlights(f: number): void {
    if (Math.abs(f - this.nightFactor) < 0.005) return;
    this.nightFactor = f;
    const rig = this.nightRig;
    rig.spot.intensity = 160 * f;
    for (const m of rig.headMats) m.opacity = 0.75 * f;
    for (const m of rig.tailMats) m.opacity = 0.55 * f;
  }

  setSurface(s: Surface): void {
    this.surface = s;
  }

  get speed(): number {
    return this.velocity.length();
  }
  // World-space planar velocity components (x = world X, z = world Z) — the
  // collision handlers read these to project the taxi's closing speed onto a
  // contact normal.
  get velX(): number {
    return this.velocity.x;
  }
  get velZ(): number {
    return this.velocity.y;
  }
  get forwardSpeed(): number {
    return this.velocity.x * Math.sin(this.heading) + this.velocity.y * Math.cos(this.heading);
  }
  // Heading of the velocity vector (for the drift-swing camera); null when slow.
  get velAngle(): number | null {
    return this.speed > 0.5 ? Math.atan2(this.velocity.x, this.velocity.y) : null;
  }
  get steer(): number {
    return this.steerSmoothed;
  }
  // 0..1 — how close the current drift is to its first mini-turbo tier.
  get driftCharge(): number {
    if (this.vehicle) return this.vehicle.driftCharge01;
    return Math.min(1, this.driftSustain / CAR.driftSlingArm);
  }

  reset(x: number, z: number, yaw: number): void {
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
    if (this.surface) this.position.y = this.surface.heightAt(x, z) + ROAD_Y;
    if (this.vehicle) {
      this.vehicle.teleport(x, this.position.y + 1.4, z, yaw);
      this.prevVelP.set(0, 0, 0);
      return;
    }
    this.syncTransform(1, true);
  }

  addBoost(amount: number): void {
    this.boostMeter = Math.min(CAR.boostMax, this.boostMeter + amount);
  }

  attachPhysics(vehicle: RaycastVehicle): void {
    this.vehicle = vehicle;
    // The game's pacing stays authoritative: physics caps mirror CAR speeds.
    vehicle.params.cruiseSpeed = CAR.maxSpeed;
    vehicle.params.maxSpeed = CAR.boostSpeed;
    const y = this.surface
      ? this.surface.heightAt(this.position.x, this.position.z) + 1.4
      : this.position.y + 1.4;
    vehicle.teleport(this.position.x, y, this.position.z, this.heading);
  }

  get physicsVehicle(): RaycastVehicle | null {
    return this.vehicle;
  }

  physicsFixedStep(fixedDt: number): void {
    this.vehicle?.fixedStep(fixedDt);
  }

  // Physics mode, phase 1 (before the world steps): translate game input into
  // vehicle controls + keep the arcade meters (boost, drift charge) alive.
  private updatePhysicsControls(dt: number, input: CarInput, solids: SolidIndex): void {
    const veh = this.vehicle;
    if (!veh) return;
    this.miniBoostFired = false;
    this.miniTurboTier = 0;
    this.boostDenied = false;

    if (this.boostMeter <= 0.5) this.boostArmed = false;
    else if (this.boostMeter >= 15) this.boostArmed = true;
    // Boost stands on its own: no throttle required, so NOS from a standstill
    // launches you (setControls pins the throttle open while boosting).
    const boostHeld = input.boost;
    const wantBoost = boostHeld && this.boostArmed;
    this.boostDenied = boostHeld && !this.boostArmed && !this.boostHeldPrev;
    this.boostHeldPrev = boostHeld;
    this.isBoosting = wantBoost;
    if (wantBoost) this.boostMeter = Math.max(0, this.boostMeter - CAR.boostDrain * dt);
    else this.boostMeter = Math.min(CAR.boostMax, this.boostMeter + CAR.boostRefill * dt);

    this.steerSmoothed += (input.steer - this.steerSmoothed) * Math.min(1, dt / CAR.steerRamp);
    veh.steerInput = input.steer;
    veh.setControls(input, wantBoost);

    // Drift state lives in the vehicle (Mario Kart state machine) — we just
    // mirror it for scoring/FX and bank the release mini-turbo.
    this.isDrifting = veh.isDrifting;
    this.driftTier = veh.driftTier;
    if (this.isDrifting) this.addBoost(CAR.boostPerDriftSec * dt);
    const turbo = veh.consumeMiniTurbo();
    if (turbo > 0) {
      this.miniBoostFired = true;
      this.miniTurboTier = turbo;
    }

    // Arcade-only obstacles (tree trunks etc) have no Rapier body — bounce
    // the chassis off them by impulse so they still stop the car.
    const r = 1.6;
    solids.forEachIn(
      this.position.x - r,
      this.position.x + r,
      this.position.z - r,
      this.position.z + r,
      this.noBodyBounce,
    );
  }

  private readonly noBodyBounce = (s: Solid): void => {
    const veh = this.vehicle;
    if (!veh || !s.noBody) return;
    if (s.maxY !== undefined && this.position.y > s.maxY) return;
    const cx = THREE.MathUtils.clamp(this.position.x, s.minX, s.maxX);
    const cz = THREE.MathUtils.clamp(this.position.z, s.minZ, s.maxZ);
    const dx = this.position.x - cx;
    const dz = this.position.z - cz;
    const d2 = dx * dx + dz * dz;
    if (d2 >= 1.2 * 1.2 || d2 < 1e-6) return;
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
      if (-vn > this.lastWallHit) this.lastWallHit = -vn;
    }
  };

  // Physics mode, phase 2 (after the world steps): pull the chassis pose back
  // into the game-facing state every other system reads.
  syncFromPhysics(dt: number): void {
    const veh = this.vehicle;
    if (!veh) return;
    this.lastWallHit = 0;
    this.wallContact = false;
    this.justLanded = 0;

    const t = veh.chassis.translation();
    veh.quaternion(this.q3a);
    const fwd = this.v3a.set(0, 0, 1).applyQuaternion(this.q3a);
    this.heading = Math.atan2(fwd.x, fwd.z);
    // Visual origin (wheel bottoms) hangs below the chassis centre.
    this.position.set(t.x, t.y - 0.62, t.z);
    this.object3D.position.copy(this.position);
    this.object3D.quaternion.copy(this.q3a);

    const lv = veh.chassis.linvel();
    const prevSpeed = Math.hypot(this.prevVelP.x, this.prevVelP.z);
    const curSpeed = Math.hypot(lv.x, lv.z);
    // A hard horizontal velocity loss in one frame = we hit something.
    const deltaV = prevSpeed - curSpeed;
    if (deltaV > 7 && prevSpeed > 8) {
      this.lastWallHit = deltaV;
      this.wallContact = true;
      const inv = prevSpeed > 1e-3 ? 1 / prevSpeed : 0;
      this.lastWallNormal.set(-this.prevVelP.x * inv, -this.prevVelP.z * inv);
    }
    this.prevVelP.set(lv.x, lv.y, lv.z);

    this.velocity.set(lv.x, lv.z);
    const va = this.velAngle;
    this.slip = va === null ? 0 : ((va - this.heading + Math.PI * 3) % (Math.PI * 2)) - Math.PI;

    const airborneNow = veh.groundedWheels() === 0 && veh.airTimeSeconds > 0.12;
    if (airborneNow) this.airTime = veh.airTimeSeconds;
    if (this.wasAirborne && !airborneNow) {
      this.justLanded = Math.max(0, -lv.y * 0.5 + 4);
      this.squash = Math.min(1, 0.45 + this.justLanded * 0.035);
    }
    this.airborne = airborneNow;
    this.wasAirborne = airborneNow;
    this.yVel = lv.y;

    // Wheels: spin with speed, fronts steer with the physics steering angle.
    const fwdSpeed = this.forwardSpeed;
    this.wheelSpin += (fwdSpeed / WHEEL_RADIUS) * dt;
    const steerAngle = veh.wheelVisual(0).steering;
    for (const w of this.wheels) {
      w.node.rotation.x = this.wheelSpin;
      if (w.front) w.node.rotation.y = steerAngle;
    }
    this.squash = Math.max(0, this.squash - dt * 5.5);
    const sq = this.squash;
    this.body.scale.set(1 + 0.12 * sq, 1 - 0.26 * sq, 1 + 0.12 * sq);

    // Fell through the world / off the map — bounce back to the last spot.
    if (t.y < -20 && this.surface) {
      const gy = this.surface.heightAt(t.x, t.z) + 1.4;
      veh.teleport(t.x, gy, t.z, this.heading);
    }
  }

  update(dt: number, input: CarInput, solids: SolidIndex): void {
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

    let vForward = this.velocity.dot(fwd);
    const vLateral = this.velocity.dot(perp);

    // --- Longitudinal ---
    // Boost hysteresis: cut out when the meter empties and stay off until it
    // rebuilds — without this the trickle refill flaps boost on/off at ~15Hz.
    if (this.boostMeter <= 0.5) this.boostArmed = false;
    else if (this.boostMeter >= 15) this.boostArmed = true;
    // Boost stands on its own — NOS from a standstill drives you forward.
    const boostHeld = input.boost;
    const wantBoost = boostHeld && this.boostArmed;
    // Denied feedback fires once per press, not once per frame.
    this.boostDenied = boostHeld && !this.boostArmed && !this.boostHeldPrev;
    this.boostHeldPrev = boostHeld;
    this.isBoosting = wantBoost;
    const topSpeed = wantBoost ? CAR.boostSpeed : CAR.maxSpeed;
    // Brake wins at (near) standstill even with the gas held — a thumb resting
    // on GAS must never block the reverse gear.
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

    // Slope gravity — crawl up SF hills, plunge down them (not while flying).
    if (this.surface && !this.airborne) {
      const n = this.surface.normalInto(this.scratchN, this.position.x, this.position.z);
      const ny = Math.max(n.y, 0.05);
      const slope = (-n.x / ny) * Math.sin(this.heading) + (-n.z / ny) * Math.cos(this.heading);
      vForward -= CAR.slopeGravity * slope * dt;
      vForward = THREE.MathUtils.clamp(vForward, -CAR.reverseMax * 1.5, topSpeed * 1.35);
    }

    if (wantBoost) this.boostMeter = Math.max(0, this.boostMeter - CAR.boostDrain * dt);
    else this.boostMeter = Math.min(CAR.boostMax, this.boostMeter + CAR.boostRefill * dt);

    // --- Steering ---
    const absF = Math.abs(vForward);
    // Slip: how far the velocity vector points away from the nose. Drifting
    // "counts" (score, smoke, screech, charge) only with real slip — holding
    // the button on a straight is just a low-grip setting, not a drift.
    const va = this.velAngle;
    this.slip =
      va === null ? 0 : ((va - this.heading + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
    const physicsDrift = input.brake > 0.05 && absF > CAR.driftMinSpeed && !this.airborne;
    this.isDrifting =
      physicsDrift && (Math.abs(this.slip) > CAR.driftMinSlip || Math.abs(this.steerSmoothed) > 0.35);
    const speedFrac = THREE.MathUtils.clamp(absF / CAR.maxSpeed, 0, 1);
    let authority = THREE.MathUtils.lerp(1, CAR.turnSpeedFalloff, speedFrac);
    if (this.airborne) authority *= CAR.airSteerFactor;
    const startFade = THREE.MathUtils.clamp(absF / 3, 0, 1); // no spin-in-place
    const driftMul = physicsDrift ? CAR.driftTurnBoost : 1;
    const dir = vForward >= 0 ? 1 : -1;
    this.steerSmoothed += (input.steer - this.steerSmoothed) * Math.min(1, dt / CAR.steerRamp);
    // Subtract: with the chase cam looking along +forward, increasing heading
    // veers screen-left, so steer-right (+1) must decrease heading.
    this.heading -= this.steerSmoothed * CAR.turnRate * authority * startFade * driftMul * dir * dt;

    // Drift boost is EASY: the meter fills continuously the whole time you're
    // drifting (no threshold to clear first), and a brief drift also arms the
    // slingshot pop on release.
    if (this.isDrifting) {
      this.driftSustain += dt;
      this.addBoost(CAR.boostPerDriftSec * dt);
    } else if (!physicsDrift) {
      if (this.driftSustain > CAR.driftSlingArm) {
        vForward = Math.min(topSpeed, vForward + CAR.miniBoostImpulse); // slingshot out of a drift
        this.miniBoostFired = true;
        this.miniTurboTier = 1;
      }
      this.driftSustain = 0;
    }
    this.driftTier = this.isDrifting && this.driftCharge >= 1 ? 1 : 0;

    // --- Reassemble velocity; low grip while drifting keeps the slide ---
    const nf = new THREE.Vector2(Math.sin(this.heading), Math.cos(this.heading));
    const np = new THREE.Vector2(nf.y, -nf.x);
    const grip = this.airborne ? 0.4 : physicsDrift ? CAR.gripDrift : CAR.gripNormal;
    const latRetain = Math.exp(-grip * dt);
    this.velocity
      .copy(nf)
      .multiplyScalar(vForward)
      .addScaledVector(np, vLateral * latRetain);

    // --- Integrate + collide, sub-stepped so high speed can't tunnel walls ---
    let remaining = dt;
    while (remaining > 1e-5) {
      const sp = this.velocity.length();
      const stepDt = sp > 1e-4 ? Math.min(remaining, 0.5 / sp) : remaining;
      this.position.x += this.velocity.x * stepDt;
      this.position.z += this.velocity.y * stepDt;
      this.resolveCollisions(solids);
      remaining -= stepDt;
    }

    // --- Vertical: follow the ground until it falls away faster than gravity
    // could pull us — then go ballistic and fly the hill crest. ---
    if (this.surface) {
      // Sample under both axles, not just the centre — on convex crests a
      // single centre sample buries the nose/tail in the hill.
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
        const vyNeeded = (g - prevY) / safeDt; // rate the ground demands this frame
        const groundAccel = (vyNeeded - this.vyGround) / safeDt;
        // Launch when following the ground would need us to accelerate downward
        // harder than gravity can pull (crest falling away under the wheels).
        if (groundAccel < -(CAR.gravity + 8) && this.speed > CAR.minAirSpeed) {
          this.airborne = true;
          this.airTime = 0;
          // Cap the launch pop — a steep crest at boost speed shouldn't put
          // the taxi into orbit.
          this.yVel = Math.min(this.vyGround, CAR.maxLaunchVy) - CAR.gravity * dt;
          this.position.y = Math.max(g, prevY + this.yVel * dt);
        } else {
          this.position.y = g;
          this.vyGround = THREE.MathUtils.clamp(vyNeeded, -40, 40);
        }
      }
    }

    // --- Visual lean (roll into turns, dive under braking, squat on throttle) ---
    const targetRoll = -input.steer * speedFrac * (physicsDrift ? 0.34 : 0.18);
    this.roll += (targetRoll - this.roll) * Math.min(1, dt * 10);
    const targetPitch = input.brake > 0.05 && vForward > 1 ? 0.05 : input.throttle > 0 ? -0.025 : 0;
    this.pitch += (targetPitch - this.pitch) * Math.min(1, dt * 8);
    this.squash = Math.max(0, this.squash - dt * 5.5); // springs back ~180ms

    // --- Wheels: spin with speed, fronts steer ---
    this.wheelSpin += (vForward / WHEEL_RADIUS) * dt;
    for (const w of this.wheels) {
      w.node.rotation.x = this.wheelSpin;
      if (w.front) w.node.rotation.y = this.steerSmoothed * -0.42;
    }

    this.syncTransform(dt);
  }

  // The taxi rammed something dynamic: shed some velocity along the contact
  // normal (n points taxi→object) and separate. Returns the closing speed.
  contactPunt(nx: number, nz: number, separation: number): number {
    const vn = this.velocity.x * nx + this.velocity.y * nz;
    if (this.vehicle) return Math.max(0, vn); // Rapier resolves the contact
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

  // One bound callback (no per-substep closure) — hot path via SolidIndex.
  // Resolves in the box's LOCAL frame so rotated solids (avenue-aligned
  // buildings) collide exactly; yaw 0 reduces to the plain AABB test.
  private readonly collideOne = (s: Solid): void => {
    // Airborne taxis fly clean over height-capped obstacles (traffic).
    if (s.maxY !== undefined && this.position.y > s.maxY) return;
    const bx = (s.minX + s.maxX) / 2;
    const bz = (s.minZ + s.maxZ) / 2;
    const hx = (s.maxX - s.minX) / 2;
    const hz = (s.maxZ - s.minZ) / 2;
    const yaw = s.yaw ?? 0;
    const cos = Math.cos(yaw);
    const sin = Math.sin(yaw);
    // world → local (inverse of three's rotateY(yaw))
    const wdx = this.position.x - bx;
    const wdz = this.position.z - bz;
    const lx = wdx * cos - wdz * sin;
    const lz = wdx * sin + wdz * cos;
    const qx = THREE.MathUtils.clamp(lx, -hx, hx);
    const qz = THREE.MathUtils.clamp(lz, -hz, hz);
    const dx = lx - qx;
    const dz = lz - qz;
    const d2 = dx * dx + dz * dz;
    if (d2 >= COLLIDE_RADIUS * COLLIDE_RADIUS) return;

    let nlx: number;
    let nlz: number;
    let pen: number;
    if (d2 > 1e-6) {
      const d = Math.sqrt(d2);
      nlx = dx / d;
      nlz = dz / d;
      pen = COLLIDE_RADIUS - d;
    } else {
      // Center inside the box — push out along the nearest face.
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

    // local → world normal
    const nx = nlx * cos + nlz * sin;
    const nz = -nlx * sin + nlz * cos;
    this.position.x += nx * pen;
    this.position.z += nz * pen;
    this.wallContact = true;
    this.lastWallNormal.set(nx, nz);
    const vn = this.velocity.x * nx + this.velocity.y * nz;
    if (vn < 0) {
      const impact = -vn;
      if (impact > this.lastWallHit) this.lastWallHit = impact;
      this.velocity.x -= (1 + CAR.bounce) * vn * nx;
      this.velocity.y -= (1 + CAR.bounce) * vn * nz;
    }
  };

  private resolveCollisions(solids: SolidIndex): void {
    const r = COLLIDE_RADIUS + 0.1;
    solids.forEachIn(
      this.position.x - r,
      this.position.x + r,
      this.position.z - r,
      this.position.z + r,
      this.collideOne,
    );
  }

  // `snap = true` (resets) copies the target attitude instead of blending.
  private syncTransform(dt: number, snap = false): void {
    if (this.surface && !this.airborne) {
      const n = this.surface.normalInto(this.scratchN, this.position.x, this.position.z);
      slopeQuaternion(this.targetQuat, this.heading + MODEL_YAW_OFFSET, n);
    } else if (this.airborne) {
      // The nose follows the flight arc: up off the crest, down as it falls.
      slopeQuaternion(this.targetQuat, this.heading + MODEL_YAW_OFFSET, UP);
      const arc = THREE.MathUtils.clamp(
        Math.atan2(-this.yVel, Math.max(this.speed, 8)),
        -0.5,
        0.6,
      );
      this.pitchQuat.setFromAxisAngle(X_AXIS, arc);
      this.targetQuat.multiply(this.pitchQuat);
    } else {
      slopeQuaternion(this.targetQuat, this.heading + MODEL_YAW_OFFSET, UP);
    }
    // Slerp instead of snapping — terrain-normal jitter becomes suspension
    // travel; launches and landings blend instead of popping.
    if (snap) this.object3D.quaternion.copy(this.targetQuat);
    else {
      const rate = this.airborne ? 6 : 13;
      this.object3D.quaternion.slerp(this.targetQuat, Math.min(1, dt * rate));
    }
    this.object3D.position.copy(this.position);
    this.body.rotation.z = this.roll;
    this.body.rotation.x = this.pitch;
    // Landing squash: volume-conserving squish that springs back.
    const sq = this.squash;
    this.body.scale.set(1 + 0.12 * sq, 1 - 0.26 * sq, 1 + 0.12 * sq);
  }
}
