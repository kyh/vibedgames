import { sfx } from "../audio/sfx";
import { BASE, RAMP, rampCss, tone } from "../pixel/palette";
import type { PixelStage } from "../pixel/stage";
import { Sparks } from "../render/fx";
import { specialName } from "../render/hud";
import type { Hud } from "../render/hud";
import type { LightMap } from "../render/light-map";
import { SPECIAL_RAMP } from "../render/props";
import type { Props } from "../render/props";
import type { HitHow } from "../sim/car";
import { DASH_REACH, SLAM_RADIUS, SPIN_RADIUS } from "../sim/kinds";
import type { AttackKind } from "../sim/kinds";
import type { Shot } from "../sim/shots";
import {
  MAGNET_RADIUS,
  MAGNET_STOP,
  MINE_BLAST,
  ROCKET_BLAST,
  SHOCK_RADIUS,
  STOMP_RADIUS,
  ZAP_RADIUS,
} from "../sim/specials";
import type { SpecialKind } from "../sim/specials";

interface Flash {
  x: number;
  z: number;
  radius: number;
  power: number;
  age: number;
  life: number;
}

interface Bolt {
  x0: number;
  z0: number;
  x1: number;
  z1: number;
  age: number;
}

/** Where something is and what colour it wears: all an effect needs to know of a car. */
export interface Spot {
  x: number;
  z: number;
  a: number;
  ramp: number;
}

/** One blow, as the effects see it. */
export interface Impact {
  x: number;
  z: number;
  dx: number;
  dz: number;
  how: HitHow;
  /** How far the car will fly. */
  reach: number;
  /** The attacker's colour, or the board's. */
  ramp: number;
  /** The player dealt it or took it. */
  involved: boolean;
  /** The player dealt it. */
  mine: boolean;
}

const EARSHOT = 34;
const LAID_BACK = 3.2;
const RING_LIFE = 0.42;
const HEAVY = new Set<HitHow>(["mine", "piston", "rocket", "shock", "slam", "sweeper"]);
const BLUNT = new Set<HitHow>(["land", "ram"]);
const SILENT = new Set<HitHow>(["magnet", "zap"]);

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

const behind = (car: Spot) => ({
  x: car.x - Math.cos(car.a) * LAID_BACK,
  z: car.z - Math.sin(car.a) * LAID_BACK,
});

const hitSound = (how: HitHow, power: number, involved: boolean) => {
  if (BLUNT.has(how)) {
    sfx.ram(involved);
  } else if (how === "bumper") {
    sfx.bounce(involved);
  } else if (how === "sweeper" || how === "piston") {
    sfx.sweep(involved);
  } else if (!SILENT.has(how)) {
    sfx.hit(power, involved);
  }
};

/**
 * Everything a round throws on screen and out of the speaker that is not a car
 * or a toy: sparks, flashes, bolts, and the shake and hit-stop they ask for.
 */
export class Effects {
  readonly sparks = new Sparks(1200);
  /** 0–1 and up: how hard the camera is shaking. The scene lets it die away. */
  shake = 0;
  /** Seconds the scene should hold still. */
  hitstop = 0;
  private readonly stage: PixelStage;
  private readonly hud: Hud;
  private readonly lights: LightMap;
  private readonly props: Props;
  private readonly flashes: Flash[] = [];
  private readonly bolts: Bolt[] = [];
  private earX = 0;
  private earZ = 0;

  private readonly uses: Record<SpecialKind, (car: Spot, mine: boolean, near: boolean) => void> = {
    giant: (car, mine, near) => {
      this.morph(car, mine, near, RAMP.green);
    },
    magnet: (car, mine, near) => {
      this.magnet(car, mine, near);
    },
    mine: (car, mine, near) => {
      const at = behind(car);
      this.sparks.ring(at.x, at.z, RAMP.hazard, 6, 12);

      if (near) {
        sfx.set(mine);
      }
    },
    oil: (car, mine, near) => {
      const at = behind(car);

      for (let i = 0; i < 8; i += 1) {
        const a = (i / 8) * Math.PI * 2;
        this.sparks.puff(at.x + Math.cos(a) * 1.4, 0.3, at.z + Math.sin(a) * 1.4, RAMP.purple, 0.5);
      }

      if (near) {
        sfx.set(mine);
      }
    },
    rocket: (car, mine, near) => {
      this.launch(car, mine, near);
    },
    seeker: (car, mine, near) => {
      this.launch(car, mine, near);
    },
    shield: (car, mine, near) => {
      this.morph(car, mine, near, RAMP.blue);
    },
    shock: (car, mine, near) => {
      this.wave(car.x, car.z, SHOCK_RADIUS, RAMP.cyan, near ? 1 : 0, mine);
    },
    spring: (car, mine, near) => {
      this.sparks.ring(car.x, car.z, RAMP.cream, 9, 20);

      if (near) {
        sfx.spring(mine);
      }
    },
    turbo: (car, mine) => {
      this.sparks.burst(car.x, 1, car.z, RAMP.yellow, 18, 10);

      if (mine) {
        sfx.boost();
      }
    },
    wrench: (car, mine) => {
      this.mend(car, mine);
    },
    zap: (car, mine, near) => {
      this.sparks.ring(car.x, car.z, RAMP.yellow, ZAP_RADIUS / RING_LIFE, 36);
      this.flash(car.x, car.z, ZAP_RADIUS, 1, 0.25);

      if (near) {
        sfx.zap(mine);
        this.shake = Math.max(this.shake, 0.4);
      }
    },
  };

  private readonly swings: Record<AttackKind, (car: Spot, mine: boolean) => void> = {
    dash: (car, mine) => {
      sfx.dash(mine);
      this.streak(car, -1.2, -DASH_REACH * 0.5, car.ramp);
    },
    punch: (car, mine) => {
      sfx.punch(mine);
      this.streak(car, 2, 4.5, RAMP.white);
    },
    scoop: (car, mine) => {
      sfx.punch(mine);
      this.streak(car, 1.6, 3.2, RAMP.white);
    },
    shot: (car, mine) => {
      sfx.pop(mine);
      this.sparks.burst(
        car.x + Math.cos(car.a) * 2.2,
        1.3,
        car.z + Math.sin(car.a) * 2.2,
        RAMP.white,
        6,
        5,
      );
    },
    slam: (car, mine) => {
      sfx.slam(mine);
      this.sparks.ring(car.x, car.z, RAMP.cream, SLAM_RADIUS / RING_LIFE, 32);
      this.flash(car.x, car.z, SLAM_RADIUS + 1, 0.9, 0.25);
      this.shake = Math.max(this.shake, mine ? 0.7 : 0.3);
    },
    spin: (car, mine) => {
      sfx.whirl(mine);
      this.sparks.ring(car.x, car.z, car.ramp, SPIN_RADIUS / RING_LIFE, 22);

      for (let i = 0; i < 10; i += 1) {
        const a = car.a + (i / 10) * Math.PI * 2;
        const r = SPIN_RADIUS * 0.8;
        this.sparks.puff(car.x + Math.cos(a) * r, 0.9, car.z + Math.sin(a) * r, RAMP.white, 0.3);
      }
    },
  };

  constructor(stage: PixelStage, hud: Hud, lights: LightMap, props: Props) {
    this.stage = stage;
    this.hud = hud;
    this.lights = lights;
    this.props = props;
  }

  /** Where the camera is looking: what happens far from there makes no sound. */
  listen(x: number, z: number) {
    this.earX = x;
    this.earZ = z;
  }

  /** Near enough the camera to be worth a sound. */
  hears(x: number, z: number) {
    return Math.hypot(x - this.earX, z - this.earZ) < EARSHOT;
  }

  flash(x: number, z: number, radius: number, power: number, life: number) {
    this.flashes.push({ age: 0, life, power, radius, x, z });
  }

  /** Words that rise off a point on the board. */
  say(text: string, x: number, y: number, z: number, css: string) {
    const spot = this.stage.project(x, y, z);
    this.hud.pop(text, spot.x, spot.y, css);
  }

  /** A blow landing on a car at (x, z). */
  impact(hit: Impact) {
    const { dx, dz, how, involved, x, z } = hit;
    const power = clamp(hit.reach / 14, 0.15, 1);
    const near = involved || this.hears(x, z);
    this.flash(x, z, 4 + power * 5, 1, 0.22);

    if (how !== "land" && how !== "magnet") {
      this.sparks.ring(x - dx, z - dz, RAMP.white, 8 + power * 10, 14 + Math.round(power * 14));
    }

    const count = Math.round(8 + power * 22);

    for (let i = 0; i < count; i += 1) {
      const speed = (6 + Math.random() * 16) * (0.5 + power);
      const a = Math.atan2(dz, dx) + (Math.random() - 0.5) * 1.5;
      this.sparks.emit({
        gravity: 16,
        life: 0.25 + Math.random() * 0.4,
        ramp: i % 3 === 0 ? RAMP.white : hit.ramp,
        size: 0.18 + Math.random() * 0.22,
        vx: Math.cos(a) * speed,
        vy: 2 + Math.random() * 7,
        vz: Math.sin(a) * speed,
        x: x - dx * 0.8,
        y: 0.9,
        z: z - dz * 0.8,
      });
    }

    if (near) {
      hitSound(how, power, involved);
    }

    if (how === "bumper") {
      this.props.ring(x, z);
    }

    if (involved) {
      const heavy = HEAVY.has(how) || power > 0.6;
      const stop = power > 0.7 ? 0.133 : 0.083;
      this.hitstop = Math.max(this.hitstop, BLUNT.has(how) ? 0.04 : stop);
      this.shake = Math.max(this.shake, heavy ? 0.5 + power * 0.7 : 0.35);
    }

    if (hit.mine && !BLUNT.has(how) && !SILENT.has(how)) {
      this.say(power > 0.7 ? "SMASH!" : "POW!", x, 2.4, z, "#fff0c8");
    }
  }

  /** Two bumpers meeting. */
  clash(x: number, z: number, involved: boolean) {
    this.sparks.ring(x, z, RAMP.hazard, 14, 24);
    this.sparks.burst(x, 1, z, RAMP.white, 18, 12);
    this.flash(x, z, 7, 1, 0.25);

    if (involved) {
      sfx.clash();
      this.hitstop = Math.max(this.hitstop, 0.07);
      this.shake = Math.max(this.shake, 0.6);
      this.say("CLASH!", x, 2.4, z, "#f2c200");
    }
  }

  /** A shield taking a blow and going with it. */
  block(x: number, z: number, involved: boolean) {
    this.sparks.ring(x, z, RAMP.glass, 12, 22);
    this.sparks.burst(x, 1.4, z, RAMP.glass, 20, 11);
    this.flash(x, z, 5, 0.8, 0.2);

    if (involved || this.hears(x, z)) {
      sfx.block(involved);
    }

    if (involved) {
      this.say("BLOCKED", x, 2.6, z, rampCss(RAMP.glass, BASE + 3));
    }
  }

  /** A car's own attack going off. */
  swing(kind: AttackKind, car: Spot, mine: boolean) {
    if (mine || this.hears(car.x, car.z)) {
      this.swings[kind](car, mine);
    }
  }

  /** A special let go. */
  use(special: SpecialKind, car: Spot, mine: boolean) {
    const near = mine || this.hears(car.x, car.z);
    this.uses[special](car, mine, near);
    this.say(specialName(special), car.x, 3.4, car.z, rampCss(SPECIAL_RAMP[special], BASE + 2));
  }

  /** A stomp off a spring, where the car came down. */
  stomp(car: Spot, mine: boolean) {
    this.sparks.ring(car.x, car.z, RAMP.lime, STOMP_RADIUS / RING_LIFE, 26);
    this.flash(car.x, car.z, STOMP_RADIUS + 1, 0.9, 0.25);

    if (mine || this.hears(car.x, car.z)) {
      sfx.slam(mine);
      this.shake = Math.max(this.shake, mine ? 0.7 : 0.3);
    }
  }

  /** A bolt from one point to another: a zap finding its car. */
  bolt(x0: number, z0: number, x1: number, z1: number) {
    this.bolts.push({ age: 0, x0, x1, z0, z1 });
    this.sparks.burst(x1, 1.2, z1, RAMP.yellow, 10, 8);
  }

  /** What a shot in flight leaves behind it: call a few dozen times a second. */
  trail(shot: Shot, ramp: number) {
    const back = { x: shot.x - Math.cos(shot.a) * 1.1, z: shot.z - Math.sin(shot.a) * 1.1 };

    if (shot.kind === "rocket") {
      this.flame(back.x, back.z, Math.cos(shot.a), Math.sin(shot.a));
      this.sparks.puff(back.x, 1, back.z, RAMP.cream, 0.4);
    } else if (shot.kind === "seeker") {
      this.sparks.puff(back.x, 1, back.z, ramp, 0.34);
    } else if (shot.kind === "puck") {
      this.sparks.puff(back.x, 0.8, back.z, RAMP.white, 0.2);
    }
  }

  /** A lick of flame out of the back of something pointing along (cos, sin). */
  flame(x: number, z: number, cos: number, sin: number) {
    for (const ramp of [RAMP.yellow, RAMP.orange]) {
      const speed = 5 + Math.random() * 6;
      const side = (Math.random() - 0.5) * 3;
      this.sparks.emit({
        grow: 0.2,
        hot: 4,
        life: 0.14 + Math.random() * 0.12,
        ramp,
        size: 0.3 + Math.random() * 0.14,
        vx: -cos * speed - sin * side,
        vy: 0.6,
        vz: -sin * speed + cos * side,
        x,
        y: 0.9,
        z,
      });
    }
  }

  /** A shot ending: `burst` if it went off, not if it only ran out. */
  pop(shot: Shot, burst: boolean, ramp: number, mine: boolean) {
    const { x, z } = shot;
    const near = this.hears(x, z);

    if (shot.kind === "puck") {
      this.sparks.burst(x, 0.9, z, ramp, burst ? 10 : 4, burst ? 8 : 3);
    } else if (shot.kind === "oil" || !burst) {
      this.sparks.puff(x, 0.5, z, RAMP.iron, 0.5);
    } else if (shot.kind === "seeker") {
      this.wave(x, z, 2.4, RAMP.orange, near ? 0.5 : 0, mine);
    } else {
      const radius = shot.kind === "mine" ? MINE_BLAST : ROCKET_BLAST;
      this.wave(x, z, radius, shot.kind === "mine" ? RAMP.hazard : RAMP.orange, near ? 1 : 0, mine);
    }
  }

  /** A car slipping onto oil. */
  slip(car: Spot, mine: boolean) {
    for (let i = 0; i < 8; i += 1) {
      this.sparks.puff(
        car.x + (Math.random() - 0.5) * 2,
        0.3,
        car.z + (Math.random() - 0.5) * 2,
        RAMP.purple,
        0.5,
      );
    }

    if (mine || this.hears(car.x, car.z)) {
      sfx.slip(mine);
    }
  }

  /** A cube taken off its pad, or a special picked up. */
  sparkle(x: number, z: number, ramp: number) {
    this.sparks.ring(x, z, ramp, 9, 18);
    this.sparks.burst(x, 1.4, z, RAMP.white, 12, 8);
  }

  /** A car gone from the board with no fall: a bot making room for a player. */
  poof(x: number, z: number, ramp: number) {
    this.sparks.confetti(x, 0.8, z, [ramp, RAMP.white], 16);

    for (let i = 0; i < 8; i += 1) {
      const a = (i / 8) * Math.PI * 2;
      this.sparks.puff(x + Math.cos(a) * 1.2, 0.6, z + Math.sin(a) * 1.2, RAMP.cream, 0.6);
    }
  }

  /** Advance and draw everything still going. */
  draw(dt: number) {
    for (const flash of this.flashes) {
      flash.age += dt;
      const k = 1 - flash.age / flash.life;

      if (k > 0) {
        this.lights.pool(flash.x, flash.z, flash.radius * (1.2 - k * 0.4), flash.power * k);
      }
    }

    while (this.flashes.length > 0 && (this.flashes[0]?.age ?? 0) >= (this.flashes[0]?.life ?? 0)) {
      this.flashes.shift();
    }

    for (const bolt of this.bolts) {
      bolt.age += dt;
      this.zig(bolt);
    }

    while (this.bolts.length > 0 && (this.bolts[0]?.age ?? 0) >= 0.22) {
      this.bolts.shift();
    }

    this.sparks.update(dt);
    this.sparks.draw(this.stage.dabs);
  }

  private zig(bolt: Bolt) {
    const length = Math.hypot(bolt.x1 - bolt.x0, bolt.z1 - bolt.z0) || 1;
    const steps = Math.max(4, Math.round(length / 0.7));
    const nx = -(bolt.z1 - bolt.z0) / length;
    const nz = (bolt.x1 - bolt.x0) / length;

    for (let i = 0; i <= steps; i += 1) {
      const k = i / steps;
      const off = i === 0 || i === steps ? 0 : (Math.random() - 0.5) * 1.6;
      this.stage.dabs.push(
        bolt.x0 + (bolt.x1 - bolt.x0) * k + nx * off,
        1.3,
        bolt.z0 + (bolt.z1 - bolt.z0) * k + nz * off,
        i % 2 === 0 ? 0.32 : 0.22,
        tone(i % 2 === 0 ? RAMP.white : RAMP.yellow, 7),
      );
    }
  }

  private streak(car: Spot, from: number, to: number, ramp: number) {
    const cos = Math.cos(car.a);
    const sin = Math.sin(car.a);

    for (let i = 0; i < 6; i += 1) {
      const along = from + ((to - from) * i) / 5;
      this.sparks.puff(car.x + cos * along, 0.7, car.z + sin * along, ramp, 0.34);
    }
  }

  private launch(car: Spot, mine: boolean, near: boolean) {
    this.streak(car, -1, -3, RAMP.white);
    this.flash(car.x, car.z, 4, 0.7, 0.2);

    if (near) {
      sfx.launch(mine);
    }
  }

  private morph(car: Spot, mine: boolean, near: boolean, ramp: number) {
    this.sparks.ring(car.x, car.z, ramp, 10, 22);
    this.sparks.burst(car.x, 1.4, car.z, ramp, 14, 8);

    if (near) {
      sfx.morph(mine);
    }
  }

  private mend(car: Spot, mine: boolean) {
    for (let i = 0; i < 16; i += 1) {
      const a = (i / 16) * Math.PI * 2;
      this.sparks.emit({
        grow: 0.3,
        life: 0.6 + Math.random() * 0.3,
        ramp: i % 2 === 0 ? RAMP.lime : RAMP.white,
        size: 0.22,
        vx: Math.cos(a) * 1.5,
        vy: 5 + Math.random() * 3,
        vz: Math.sin(a) * 1.5,
        x: car.x + Math.cos(a) * 1.4,
        y: 0.5,
        z: car.z + Math.sin(a) * 1.4,
      });
    }

    if (mine) {
      sfx.repair();
    }
  }

  private magnet(car: Spot, mine: boolean, near: boolean) {
    const tx = car.x + Math.cos(car.a) * MAGNET_STOP;
    const tz = car.z + Math.sin(car.a) * MAGNET_STOP;

    for (let i = 0; i < 36; i += 1) {
      const a = (i / 36) * Math.PI * 2;
      const r = MAGNET_RADIUS * (0.45 + (i % 3) * 0.27);
      const life = 0.3 + (i % 3) * 0.06;
      this.sparks.emit({
        grow: 0.4,
        life,
        ramp: i % 2 === 0 ? RAMP.pink : RAMP.white,
        size: 0.24,
        vx: (-Math.cos(a) * r) / life,
        vy: 0,
        vz: (-Math.sin(a) * r) / life,
        x: tx + Math.cos(a) * r,
        y: 0.8,
        z: tz + Math.sin(a) * r,
      });
    }

    this.flash(tx, tz, 6, 0.8, 0.3);

    if (near) {
      sfx.magnet(mine);
    }
  }

  private wave(x: number, z: number, radius: number, ramp: number, loud: number, mine: boolean) {
    this.sparks.ring(x, z, ramp, radius / RING_LIFE, 40);
    this.sparks.ring(x, z, RAMP.white, (radius * 0.6) / RING_LIFE, 24);
    this.sparks.burst(x, 1, z, ramp, 26, 14);
    this.sparks.burst(x, 1, z, RAMP.white, 12, 9);
    this.flash(x, z, radius + 2, 1, 0.3);

    for (let i = 0; i < 6; i += 1) {
      const a = (i / 6) * Math.PI * 2;
      this.sparks.emit({
        grow: 1.6,
        hot: 6,
        life: 0.7 + Math.random() * 0.3,
        ramp: RAMP.steel,
        rim: true,
        size: 0.6,
        vx: Math.cos(a) * 2,
        vy: 2.5 + Math.random() * 2,
        vz: Math.sin(a) * 2,
        x,
        y: 1,
        z,
      });
    }

    if (loud > 0) {
      sfx.boom(loud, mine);
      this.shake = Math.max(this.shake, loud * (mine ? 0.9 : 0.5));
    }
  }
}
