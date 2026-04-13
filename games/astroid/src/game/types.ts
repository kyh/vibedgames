export type Point = {
  x: number;
  y: number;
};

export type Weapon = {
  name: string;
  power: number;
  speed: number;
  length: number;
  width: number;
  color: string;
  shootingInterval: number;
  through: boolean;
  explosion: false | { range: number; speed: number };
};

export type Ship = {
  position: Point;
  angle: number;
  size: number;
  path: Point[];
  referencePath: Point[];
  alive: boolean;
  invulnerable: boolean;
  invulnerableUntil: number;
  respawnAt: number;
};

export type Asteroid = {
  id: string;
  position: Point;
  velocity: Point;
  radius: number;
  vertices: Point[]; // jagged polygon offsets from center
  rotation: number;
};

export type Beam = {
  id: string;
  head: Point;
  tail: Point;
  angle: number;
  speed: number;
  weapon: Weapon;
  released: boolean; // tail has fully left the barrel
  exploding: boolean;
  explosionRadius: number;
  explosionMaxRadius: number;
  explosionSpeed: number;
  vanished: boolean;
  playerId: string;
};

export type UFO = {
  id: string;
  position: Point;
  velocity: Point;
  destination: Point;
  path: Point[];
  hp: number;
  damageBlink: number;
};

export type Item = {
  id: string;
  position: Point;
  velocity: Point;
  weapon: Weapon;
  path: Point[];
  lifetime: number; // ticks remaining
};

export type Splinter = {
  particles: Array<{
    x: number;
    y: number;
    angle: number;
    radius: number;
    speed: number;
  }>;
  origin: Point;
  createdAt: number;
};

export type SharedGameState = {
  asteroids: Asteroid[];
  ufo: UFO | null;
  items: Item[];
};

export type PlayerGameState = {
  x: number;
  y: number;
  angle: number;
  alive: boolean;
  score: number;
  weaponName: string;
  shooting: boolean;
  beams: SerializedBeam[];
};

/** Minimal beam data sent over the network */
export type SerializedBeam = {
  hx: number;
  hy: number;
  tx: number;
  ty: number;
  angle: number;
  color: string;
  width: number;
  exploding: boolean;
  explosionRadius: number;
};

export type Camera = {
  x: number;
  y: number;
};
