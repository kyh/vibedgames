// Turns raw input into the player's movement, shots and aim preview. Mouse
// aim is a ray against the ground plane; touch aim comes from the right stick
// (drag) or an auto-aim pick (tap) that leads the nearest visible target.

import * as THREE from "three";

import type { AttackDef } from "./config";
import type { Brawler } from "./entities/brawler";
import type { Game } from "./game";
import type { GuideSlot } from "./aim-guide";
import { STICK_DEAD_ZONE } from "./input";
import { dist } from "./utils";
import { terrainAimDistance } from "./world/terrain";

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

/**
 * A guest acts on its own body exactly as the host will — the same checks,
 * the same pose, its shots drawn at once — and then tells the host; with no
 * host to tell, it does not act at all, so nothing it shows goes unreplayed.
 */
const offline = (game: Game): boolean => game.netGuest?.link.reachable === false;

const fireAttack = (game: Game, player: Brawler, aim: Aim): void => {
  if (!offline(game) && player.attack(aim.dx, aim.dz, aim.x, aim.z)) {
    game.netGuest?.link.sendAction(player, "attack", aim);
  }
};

const fireSuper = (game: Game, player: Brawler, aim: Aim): void => {
  if (!offline(game) && player.useSuper(aim.dx, aim.dz, aim.x, aim.z)) {
    game.netGuest?.link.sendAction(player, "super", aim);
  }
};

const evade = (game: Game, player: Brawler): void => {
  if (!game.input.consumeEvade() || game.state !== "playing" || offline(game)) {
    return;
  }
  // One roll at a time waits on the host's verdict; it gives up after a second.
  if (player.evadePending) {
    return;
  }
  const moving = Math.hypot(player.moveX, player.moveZ) > 0.001;
  const angle = player.lookAngle ?? player.facing;
  const dx = moving ? player.moveX : Math.sin(angle);
  const dz = moving ? player.moveZ : Math.cos(angle);
  if (player.evade(dx, dz)) {
    game.netGuest?.link.sendEvade(player, dx, dz);
  }
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
  if (attack.kind === "melee") {
    return attack.windup;
  }
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
  player.lookAngle = null;
  let slot: GuideSlot | null = null;
  if (sticks.super.id !== null && sticks.super.mag > STICK_DEAD_ZONE && player.superReady) {
    slot = "super";
  } else if (sticks.aim.id !== null && sticks.aim.mag > STICK_DEAD_ZONE) {
    slot = "attack";
  }
  if (slot && !player.airborne) {
    const stick = slot === "super" ? sticks.super : sticks.aim;
    const aim = stickAim(player, stick, player.def[slot]);
    player.lookAngle = Math.atan2(aim.dx, aim.dz);
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
  evade(game, player);
  if (player.evasion) {
    game.guide.hide();
  }
};

/** Where the mouse (or a pad's right stick) points: the aim point lands on the shoulder plane. */
const readMouseAim = (game: Game, player: Brawler): Aim => {
  const { input, aimPoint } = game;
  const pad = input.padAim();
  if (pad || input.aimMethod === "pad") {
    const reach = player.def.attack.range;
    const angle = player.lookAngle ?? player.facing;
    const dx = pad?.x ?? Math.sin(angle);
    const dz = pad?.z ?? Math.cos(angle);
    aimPoint.set(player.x + dx * reach, player.root.position.y + 0.5, player.z + dz * reach);
  } else {
    MOUSE_NDC.set(input.ndcX, input.ndcY);
    RAYCASTER.setFromCamera(MOUSE_NDC, game.camera);
    const distance = terrainAimDistance(RAYCASTER.ray.origin, RAYCASTER.ray.direction);
    if (distance === null) {
      aimPoint.set(player.x, player.root.position.y + 0.5, player.z + 1);
    } else {
      RAYCASTER.ray.at(distance, aimPoint);
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
  if (Math.hypot(dx, dz) > 0.001 && !player.airborne) {
    player.lookAngle = Math.atan2(dx, dz);
  }
  evade(game, player);
  const released = input.consumeSuperRelease();
  const charging = input.superHeld && player.superReady;
  if (released && player.superReady) {
    fireSuper(game, player, aim);
  } else if (input.fire && !charging) {
    fireAttack(game, player, aim);
  }
  const slot: GuideSlot = charging ? "super" : "attack";
  if (player.airborne || player.evasion) {
    game.guide.hide();
  } else {
    game.guide.show(player, game.world, player.def[slot], slot, dx, dz, len, charging);
  }
};

export const controlPlayer = (game: Game): void => {
  const { player } = game;
  const live = game.state === "playing" || game.state === "countdown";
  if (!game.input.enabled || !player || !player.alive || !live) {
    game.guide.hide();
    if (player) {
      player.moveX = 0;
      player.moveZ = 0;
      player.lookAngle = null;
    }
    game.netGuest?.link.steer(player, 0, 0, null);
    game.input.takeShots();
    game.input.consumeEvade();
    return;
  }
  const axis = game.input.axis();
  player.moveX = axis.x;
  player.moveZ = axis.z;
  if (game.input.touchMode) {
    previewTouchAim(game, player);
  } else {
    controlWithMouse(game, player);
  }
  fireQueuedShots(game, player);
  // A guest moves by the quantized direction it sent, which is what the host runs.
  game.netGuest?.link.steer(player, axis.x, axis.z, player.lookAngle);
};
