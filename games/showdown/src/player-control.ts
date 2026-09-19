// Turns raw input into the player's movement, shots and aim preview. Mouse
// aim is a ray against the ground plane; touch aim comes from the right stick
// (drag) or an auto-aim pick (tap) that leads the nearest visible target.

import * as THREE from "three";

import type { AttackDef } from "./config";
import type { Brawler } from "./entities/brawler";
import type { Game } from "./game";
import type { GuideSlot } from "./aim-guide";
import type { Input } from "./input";
import { dist } from "./utils";

export interface Aim {
  dist: number;
  dx: number;
  dz: number;
  x: number;
  z: number;
}

/** A stick or a released touch shot: direction in [-1, 1] plus its magnitude. */
interface StickLike {
  mag: number;
  x: number;
  y: number;
}

const RAYCASTER = new THREE.Raycaster();
const MOUSE_NDC = new THREE.Vector2();
/** Shots aim at shoulder height, half a unit above the floor. */
const AIM_PLANE = new THREE.Plane(new THREE.Vector3(0, 1, 0), -0.5);
/** A guest's shot goes to the host as an intent instead of into the sim; the local
 *  gate mirrors the sim's own checks so the wire is not spammed while holding fire. */
const GUEST_FIRE_COOLDOWN = 0.25;

const guestCanAct = (game: Game, player: Brawler): boolean =>
  player.alive && !player.airborne && game.state !== "countdown";

const fireAttack = (game: Game, player: Brawler, aim: Aim): void => {
  if (game.mode !== "guest") {
    if (player.attack(aim.dx, aim.dz, aim.x, aim.z)) {
      game.hud.playHints.markActed();
    }
    return;
  }
  if (!guestCanAct(game, player) || player.ammo < 1 || player.fireCooldown > 0) {
    return;
  }
  player.fireCooldown = GUEST_FIRE_COOLDOWN;
  player.aimAngle = Math.atan2(aim.dx, aim.dz);
  player.aimHold = 0.55;
  game.hud.playHints.markActed();
  game.session?.sendIntent({ dx: aim.dx, dz: aim.dz, kind: "attack", x: aim.x, z: aim.z });
};

const fireSuper = (game: Game, player: Brawler, aim: Aim): void => {
  if (game.mode !== "guest") {
    if (player.useSuper(aim.dx, aim.dz, aim.x, aim.z)) {
      game.hud.playHints.markActed();
    }
    return;
  }
  if (!guestCanAct(game, player) || !player.superReady) {
    return;
  }
  player.superCharge = 0;
  player.aimAngle = Math.atan2(aim.dx, aim.dz);
  player.aimHold = 0.55;
  game.session?.sendIntent({ dx: aim.dx, dz: aim.dz, kind: "super", x: aim.x, z: aim.z });
};

/** A stick direction from a physical gamepad, as the input layer may report it. */
interface PadAim {
  x: number;
  z: number;
}

/** The input layer with the optional right-stick aim a gamepad build adds. */
interface PadAimSource {
  axis: Input["axis"];
  padAim?: () => PadAim | null;
}

/** A physical gamepad's right stick, when the input layer provides one. */
const padAimOf = (input: Input): PadAim | null => {
  const source: PadAimSource = input;
  const aim = source.padAim?.() ?? null;
  return aim && Number.isFinite(aim.x) && Number.isFinite(aim.z) ? aim : null;
};

/** Lobs and leaps travel as far as the stick is pushed; everything else goes full range. */
const stickAim = (player: Brawler, stick: StickLike, attack: AttackDef): Aim => {
  const len = Math.hypot(stick.x, stick.y) || 1;
  const dx = stick.x / len;
  const dz = stick.y / len;
  let reach = attack.range;
  if (attack.kind === "lob" || attack.kind === "leap") {
    reach = Math.max(attack.kind === "leap" ? 2 : 1, stick.mag * attack.range);
  }
  return { dist: reach, dx, dz, x: player.x + dx * reach, z: player.z + dz * reach };
};

/** Seconds until the attack lands at `distance`, for leading a moving target. */
const travelTime = (attack: AttackDef, distance: number): number => {
  if (attack.kind === "lob") {
    return attack.flight + attack.fuse * 0.6;
  }
  if (attack.kind === "leap") {
    return attack.flight;
  }
  return distance / (attack.speed || 15);
};

const autoAim = (game: Game, player: Brawler, attack: AttackDef): Aim => {
  const reach = attack.range * 1.05;
  let tx = 0;
  let tz = 0;
  let best = Number.POSITIVE_INFINITY;
  for (const other of game.brawlers) {
    if (other === player || !other.alive || other.hidden || other.airborne) {
      continue;
    }
    const d = dist(player.x, player.z, other.x, other.z);
    if (d > reach || d >= best) {
      continue;
    }
    const lead = travelTime(attack, d) * 0.7;
    best = d;
    tx = other.x + other.vel.x * lead;
    tz = other.z + other.vel.y * lead;
  }
  if (best === Number.POSITIVE_INFINITY) {
    for (const box of game.combat.boxes) {
      if (!box.alive) {
        continue;
      }
      const d = dist(player.x, player.z, box.x, box.z);
      if (d > reach || d >= best) {
        continue;
      }
      best = d;
      tx = box.x;
      tz = box.z;
    }
  }
  if (best === Number.POSITIVE_INFINITY) {
    // Nothing in reach: fire straight ahead, lobs a little short.
    const ahead =
      attack.kind === "lob" || attack.kind === "leap" ? attack.range * 0.6 : attack.range;
    tx = player.x + Math.sin(player.facing) * ahead;
    tz = player.z + Math.cos(player.facing) * ahead;
  }
  const len = Math.hypot(tx - player.x, tz - player.z) || 1;
  return { dist: len, dx: (tx - player.x) / len, dz: (tz - player.z) / len, x: tx, z: tz };
};

/** Touch shots queued since the last frame: a tap auto-aims, a drag aims by stick. */
const fireQueuedShots = (game: Game, player: Brawler): void => {
  for (const shot of game.input.takeShots()) {
    if (shot.cancelled) {
      continue;
    }
    const attack = shot.kind === "super" ? player.def.super : player.def.attack;
    const aim = shot.tap ? autoAim(game, player, attack) : stickAim(player, shot, attack);
    if (shot.kind === "super") {
      fireSuper(game, player, aim);
    } else {
      fireAttack(game, player, aim);
    }
  }
};

/** While a stick is held, preview where it points and lean the camera that way. */
const previewTouchAim = (game: Game, player: Brawler): void => {
  const { sticks } = game.input;
  let slot: GuideSlot | null = null;
  if (sticks.super.id !== null && sticks.super.moved && player.superReady) {
    slot = "super";
  } else if (sticks.aim.id !== null && sticks.aim.moved) {
    slot = "attack";
  }
  if (slot && !player.airborne) {
    const stick = slot === "super" ? sticks.super : sticks.aim;
    const aim = stickAim(player, stick, player.def[slot]);
    game.aimPoint.set(player.x + aim.dx * 5, 0.5, player.z + aim.dz * 5);
    game.guide.show(
      player,
      game.world,
      player.def[slot],
      slot,
      aim.dx,
      aim.dz,
      aim.dist,
      slot === "super",
    );
  } else {
    game.aimPoint.set(player.x, 0.5, player.z);
    game.guide.hide();
  }
};

/** Where the mouse (or a pad's right stick) points: the aim point lands on the shoulder plane. */
const readMouseAim = (game: Game, player: Brawler): Aim => {
  const { input, aimPoint } = game;
  const pad = padAimOf(input);
  if (pad) {
    const reach = player.def.attack.range;
    aimPoint.set(player.x + pad.x * reach, 0.5, player.z + pad.z * reach);
  } else {
    MOUSE_NDC.set(input.ndcX, input.ndcY);
    RAYCASTER.setFromCamera(MOUSE_NDC, game.camera);
    if (!RAYCASTER.ray.intersectPlane(AIM_PLANE, aimPoint)) {
      aimPoint.set(player.x, 0.5, player.z + 1);
    }
  }
  const dx = aimPoint.x - player.x;
  const dz = aimPoint.z - player.z;
  const len = Math.hypot(dx, dz) || 1;
  return { dist: len, dx: dx / len, dz: dz / len, x: aimPoint.x, z: aimPoint.z };
};

const controlWithMouse = (game: Game, player: Brawler): void => {
  const { input } = game;
  const aim = readMouseAim(game, player);
  const { dx, dz, dist: len } = aim;
  const released = input.consumeSuperRelease();
  const charging = input.superHeld && player.superReady;
  if (released && player.superReady) {
    fireSuper(game, player, aim);
  } else if (input.fire && !charging) {
    fireAttack(game, player, aim);
  }
  const slot: GuideSlot = charging ? "super" : "attack";
  if (player.airborne) {
    game.guide.hide();
  } else {
    game.guide.show(player, game.world, player.def[slot], slot, dx, dz, len, charging);
  }
};

export const controlPlayer = (game: Game): void => {
  const { player } = game;
  const live = game.state === "playing" || game.state === "countdown";
  if (!player || !player.alive || !live) {
    game.guide.hide();
    if (player) {
      player.moveX = 0;
      player.moveZ = 0;
    }
    if (game.mode === "guest") {
      game.session?.sendInput(0, 0);
    }
    game.input.takeShots();
    return;
  }
  const axis = game.input.axis();
  player.moveX = axis.x;
  player.moveZ = axis.z;
  if (game.mode === "guest") {
    game.session?.sendInput(axis.x, axis.z);
  }
  fireQueuedShots(game, player);
  if (game.input.touchMode) {
    previewTouchAim(game, player);
    return;
  }
  controlWithMouse(game, player);
};
