// The host's sim ↔ wire snapshot. Plain JSON only: brawlers, projectiles and
// loot as numbers, colours as hex ints. Guests rebuild puppets from it; a
// promoted host rebuilds its sim from it. FX ride separately (fx/fxSeq).
import type { Bomb, Bullet, Combat, LootBox } from "../combat/combat";
import type { BrawlerId, LobStyle, ProjectileStyle } from "../config";
import { BRAWLERS, isBrawlerId } from "../config";
import type { Brawler } from "../entities/brawler";
import { EVADE } from "../entities/evasion";
import { rangedPoseDuration } from "../entities/ranged-pose";
import type { Game } from "../game";
import { clamp } from "../utils";
import type { World } from "../world/world";
import type { JsonObject, JsonValue } from "./json";
import {
  isJsonBoolean as isBool,
  isJsonNumber as isNum,
  isJsonObject as isObj,
  isJsonString as isStr,
} from "./json";

export type NetPhase = "countdown" | "playing" | "ended";

export type NetLeap = { t: number; sx: number; sz: number; tx: number; tz: number };
export type NetMelee = { angle: number; elapsed: number; windup: number; recovery: number };
export type NetRanged = { elapsed: number; isSuper: boolean };
export type NetEvasion = { angle: number; elapsed: number };

export type NetBrawler = {
  /** `p:<playerId>` for a human seat, `bot:<n>` for a bot. */
  id: string;
  /** The owning player's id, or null for a bot. */
  owner: string | null;
  kit: BrawlerId;
  name: string;
  hue: number;
  x: number;
  z: number;
  /** World height, including terrain elevation. */
  y: number;
  /** Explicit airborne state; progress and endpoints survive host promotion. */
  leap: NetLeap | null;
  /** Accepted attack pose, sampled at its current age by every client. */
  melee: NetMelee | null;
  /** Optional while older hosts still publish snapshots without ranged poses. */
  ranged?: NetRanged | null;
  evasion: NetEvasion | null;
  evadeCooldown: number;
  /** Last processed request, including rejected requests. */
  evadeAck: number;
  evadeAccepted: boolean;
  facing: number;
  hp: number;
  maxHp: number;
  ammo: number;
  charge: number;
  alive: boolean;
  /** Concealed in a bush (in a bush and not recently revealed). */
  bush: boolean;
  cubes: number;
  kills: number;
  rank: number;
  vx: number;
  vz: number;
};

export type NetBullet = {
  style: ProjectileStyle;
  x: number;
  z: number;
  dx: number;
  dz: number;
  /** Radius. */
  r: number;
  /** Colour as a hex int. */
  c: number;
  /** Fired by a super. */
  s: boolean;
  /** A melee swing (short fat shape). */
  m: boolean;
  /** Speed, so guests extrapolate between snapshots. */
  v: number;
  /** Range left before the shot dies (drives the fade). */
  l: number;
};

export type NetBomb = {
  style: LobStyle;
  x: number;
  y: number;
  z: number;
  c: number;
  s: boolean;
  big: boolean;
  /** Landing marker. */
  tx: number;
  tz: number;
  /** Blast radius (marker scale). */
  r: number;
  /** 0 in flight → 1 as the fuse runs out. */
  u: number;
};

export type NetBox = {
  /** Index into `world.boxSpots`. */
  i: number;
  hp: number;
};

export type NetCube = { x: number; z: number };

export type NetGas = { half: number; round: number; active: boolean };

export type Snapshot = {
  seq: number;
  /** Match generation: bumps on every restart so guests rebuild. */
  gen: number;
  phase: NetPhase;
  countdownT: number;
  matchTime: number;
  /** Hour of day on the host's clock. */
  hour: number;
  seed: number;
  gas: NetGas;
  brawlers: NetBrawler[];
  bullets: NetBullet[];
  bombs: NetBomb[];
  boxes: NetBox[];
  cubes: NetCube[];
  /** Cumulative destroyed tile indices this match. */
  broken: number[];
  winner: string | null;
};

const round2 = (n: number): number => Math.round(n * 100) / 100;
const round3 = (n: number): number => Math.round(n * 1000) / 1000;

const encodeBrawler = (b: Brawler): NetBrawler => ({
  alive: b.alive,
  ammo: round2(b.ammo),
  bush: b.inBush && b.revealT <= 0,
  charge: round3(b.superCharge),
  cubes: b.cubes,
  evadeAccepted: b.netTarget.evadeAccepted,
  evadeAck: b.netTarget.evadeAck,
  evadeCooldown: round3(b.evadeCooldown),
  evasion: b.evasion
    ? { angle: round3(b.evasion.angle), elapsed: round3(b.evasion.elapsed) }
    : null,
  facing: round3(b.facing),
  hp: Math.round(b.hp),
  hue: round3(b.hueShift),
  id: b.netId,
  kills: b.kills,
  kit: b.def.id,
  leap: b.leap
    ? {
        sx: round3(b.leap.sx),
        sz: round3(b.leap.sz),
        t: round3(b.leap.t),
        tx: round3(b.leap.tx),
        tz: round3(b.leap.tz),
      }
    : null,
  maxHp: b.maxHp,
  melee: b.meleeCue
    ? {
        angle: round3(b.meleeCue.angle),
        elapsed: round3(b.meleeCue.elapsed),
        recovery: round3(b.meleeCue.recovery),
        windup: round3(b.meleeCue.windup),
      }
    : null,
  name: b.name,
  owner: b.owner,
  ranged: b.rangedCue
    ? { elapsed: round3(b.rangedCue.elapsed), isSuper: b.rangedCue.isSuper }
    : null,
  rank: b.rank,
  vx: round2(b.vel.x),
  vz: round2(b.vel.y),
  x: round3(b.x),
  y: round2(b.root.position.y),
  z: round3(b.z),
});

const encodeBullet = (bullet: Bullet): NetBullet => ({
  c: bullet.color.getHex(),
  dx: round3(bullet.dx),
  dz: round3(bullet.dz),
  l: round2(bullet.range - bullet.travel),
  m: bullet.melee,
  r: bullet.radius,
  s: bullet.isSuper,
  style: bullet.a.style,
  v: round2(bullet.speed),
  x: round3(bullet.x),
  z: round3(bullet.z),
});

const encodeBomb = (bomb: Bomb): NetBomb => {
  const p = bomb.slot.group.position;
  return {
    big: bomb.a.big === true,
    c: bomb.color.getHex(),
    r: bomb.a.blast,
    s: bomb.isSuper,
    style: bomb.a.style,
    tx: round3(bomb.tx),
    tz: round3(bomb.tz),
    u: bomb.landed ? round2(1 - clamp(bomb.fuse / bomb.a.fuse, 0, 1)) : 0,
    x: round3(p.x),
    y: round3(p.y),
    z: round3(p.z),
  };
};

const encodeBoxes = (world: World, boxes: readonly LootBox[]): NetBox[] => {
  const out: NetBox[] = [];
  for (const box of boxes) {
    if (!box.alive) {
      continue;
    }
    const i = world.boxSpots.findIndex(([tx, ty]) => tx === box.tx && ty === box.ty);
    if (i !== -1) {
      out.push({ hp: Math.round(box.hp), i });
    }
  }
  return out;
};

const encodeCombat = (combat: Combat, world: World) => ({
  bombs: combat.bombs.filter((bomb) => !bomb.done).map(encodeBomb),
  boxes: encodeBoxes(world, combat.boxes),
  bullets: combat.bullets.filter((bullet) => bullet.alive).map(encodeBullet),
  cubes: combat.cubes.filter((cube) => cube.alive).map((cube) => ({ x: cube.x, z: cube.z })),
});

const netPhase = (game: Game): NetPhase => {
  if (game.state === "countdown") {
    return "countdown";
  }
  return game.state === "ended" ? "ended" : "playing";
};

export const encodeSnapshot = (game: Game, seq: number): Snapshot => ({
  ...encodeCombat(game.combat, game.world),
  brawlers: game.brawlers.map(encodeBrawler),
  broken: [...game.world.broken],
  countdownT: round3(game.countdownT),
  gas: { active: game.gas.active, half: round3(game.gas.half), round: round3(game.gas.round) },
  gen: game.generation,
  hour: round3(game.lighting.time),
  matchTime: round3(game.matchTime),
  phase: netPhase(game),
  seed: game.world.seed,
  seq,
  winner: game.winner,
});

const isNetIdentity = (v: JsonObject): boolean =>
  isStr(v["id"]) &&
  (v["owner"] === null || isStr(v["owner"])) &&
  isStr(v["kit"]) &&
  isBrawlerId(v["kit"]) &&
  isStr(v["name"]) &&
  isNum(v["hue"]);

const isNetPose = (v: JsonObject): boolean =>
  isNum(v["x"]) &&
  isNum(v["z"]) &&
  isNum(v["y"]) &&
  isNum(v["facing"]) &&
  isNum(v["vx"]) &&
  isNum(v["vz"]) &&
  isBool(v["bush"]);

const isNetVitals = (v: JsonObject): boolean =>
  isNum(v["hp"]) &&
  isNum(v["maxHp"]) &&
  isNum(v["ammo"]) &&
  isNum(v["charge"]) &&
  isBool(v["alive"]) &&
  isNum(v["cubes"]) &&
  isNum(v["kills"]) &&
  isNum(v["rank"]);

const isNetLeap = (v: JsonValue | undefined): v is NetLeap | null =>
  v === null ||
  (isObj(v) &&
    isNum(v["t"]) &&
    v["t"] >= 0 &&
    isNum(v["sx"]) &&
    isNum(v["sz"]) &&
    isNum(v["tx"]) &&
    isNum(v["tz"]));

const isNetMelee = (v: JsonValue | undefined): v is NetMelee | null =>
  v === null ||
  (isObj(v) &&
    isNum(v["angle"]) &&
    Math.abs(v["angle"]) <= Math.PI + 0.001 &&
    isNum(v["windup"]) &&
    v["windup"] > 0 &&
    v["windup"] <= 2 &&
    isNum(v["recovery"]) &&
    v["recovery"] >= 0 &&
    v["recovery"] <= 2 &&
    isNum(v["elapsed"]) &&
    v["elapsed"] >= 0 &&
    v["elapsed"] <= v["windup"] + v["recovery"] + 0.001);

const isNetRanged = (v: JsonObject): boolean => {
  const pose = v["ranged"];
  if (pose === undefined || pose === null) {
    return true;
  }
  const { kit } = v;
  if (!isObj(pose) || !isStr(kit) || !isBrawlerId(kit)) {
    return false;
  }
  const { elapsed, isSuper } = pose;
  if (!isNum(elapsed) || !isBool(isSuper)) {
    return false;
  }
  const attack = isSuper ? BRAWLERS[kit].super : BRAWLERS[kit].attack;
  return (
    (attack.kind === "burst" || attack.kind === "spread" || attack.kind === "lob") &&
    v["alive"] === true &&
    v["evasion"] === null &&
    v["leap"] === null &&
    v["melee"] === null &&
    elapsed >= 0 &&
    elapsed <= rangedPoseDuration(kit, isSuper) + 0.001
  );
};

const isNetEvasion = (v: JsonObject): boolean => {
  const pose = v["evasion"];
  const cooldown = v["evadeCooldown"];
  const ack = v["evadeAck"];
  if (
    !isNum(cooldown) ||
    cooldown < 0 ||
    cooldown > EVADE.cooldown + 0.001 ||
    !isNum(ack) ||
    !Number.isSafeInteger(ack) ||
    ack < 0 ||
    !isBool(v["evadeAccepted"]) ||
    (ack === 0 && v["evadeAccepted"])
  ) {
    return false;
  }
  return (
    pose === null ||
    (isObj(pose) &&
      v["alive"] === true &&
      v["leap"] === null &&
      cooldown > 0 &&
      isNum(pose["angle"]) &&
      Math.abs(pose["angle"]) <= Math.PI + 0.001 &&
      isNum(pose["elapsed"]) &&
      pose["elapsed"] >= 0 &&
      pose["elapsed"] <= EVADE.duration + 0.001)
  );
};

const isNetBrawler = (v: JsonValue): v is NetBrawler =>
  isObj(v) &&
  isNetIdentity(v) &&
  isNetPose(v) &&
  isNetVitals(v) &&
  isNetEvasion(v) &&
  isNetRanged(v) &&
  isNetMelee(v["melee"]) &&
  (v["melee"] === null ||
    (isStr(v["kit"]) && isBrawlerId(v["kit"]) && BRAWLERS[v["kit"]].attack.kind === "melee")) &&
  isNetLeap(v["leap"]) &&
  (v["leap"] === null ||
    (isStr(v["kit"]) && isBrawlerId(v["kit"]) && BRAWLERS[v["kit"]].super.kind === "leap"));

const isNetBullet = (v: JsonValue): v is NetBullet =>
  isObj(v) &&
  (v["style"] === "arrow" ||
    v["style"] === "bolt" ||
    v["style"] === "spear" ||
    v["style"] === "thorn") &&
  isNum(v["x"]) &&
  isNum(v["z"]) &&
  isNum(v["dx"]) &&
  isNum(v["dz"]) &&
  isNum(v["r"]) &&
  isNum(v["c"]) &&
  isBool(v["s"]) &&
  isBool(v["m"]) &&
  isNum(v["v"]) &&
  isNum(v["l"]);

const isNetBomb = (v: JsonValue): v is NetBomb =>
  isObj(v) &&
  (v["style"] === "fire" || v["style"] === "seed" || v["style"] === "potion") &&
  isNum(v["x"]) &&
  isNum(v["y"]) &&
  isNum(v["z"]) &&
  isNum(v["c"]) &&
  isBool(v["s"]) &&
  isBool(v["big"]) &&
  isNum(v["tx"]) &&
  isNum(v["tz"]) &&
  isNum(v["r"]) &&
  isNum(v["u"]);

const isNetBox = (v: JsonValue): v is NetBox => isObj(v) && isNum(v["i"]) && isNum(v["hp"]);
const isNetCube = (v: JsonValue): v is NetCube => isObj(v) && isNum(v["x"]) && isNum(v["z"]);
const isNetGas = (v: JsonValue | undefined): v is NetGas =>
  isObj(v) && isNum(v["half"]) && isNum(v["round"]) && isBool(v["active"]);
const isPhase = (v: JsonValue | undefined): v is NetPhase =>
  v === "countdown" || v === "playing" || v === "ended";

const allOf = <T extends JsonValue>(
  v: JsonValue | undefined,
  guard: (item: JsonValue) => item is T,
): v is T[] => Array.isArray(v) && v.every((item) => guard(item));

/** Field-by-field validation: a malformed room state must never reach the sim. */
export const isSnapshot = (v: Snapshot | JsonValue | undefined): v is Snapshot =>
  isObj(v) &&
  isNum(v["seq"]) &&
  isNum(v["gen"]) &&
  isPhase(v["phase"]) &&
  isNum(v["countdownT"]) &&
  isNum(v["matchTime"]) &&
  isNum(v["hour"]) &&
  isNum(v["seed"]) &&
  isNetGas(v["gas"]) &&
  allOf(v["brawlers"], isNetBrawler) &&
  allOf(v["bullets"], isNetBullet) &&
  allOf(v["bombs"], isNetBomb) &&
  allOf(v["boxes"], isNetBox) &&
  allOf(v["cubes"], isNetCube) &&
  allOf(v["broken"], isNum) &&
  (v["winner"] === null || isStr(v["winner"]));
