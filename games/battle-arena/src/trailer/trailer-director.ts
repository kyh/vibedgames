import * as THREE from "three";
import { CHAMP_BY_ID } from "../data/champions";
import { SIM_DT, XP_CURVE } from "../data/config";
import { BOSS_POS, CAMPS, SPAWNS } from "../data/map";
import { castAbility } from "../sim/abilities";
import { grantXp } from "../sim/economy";
import { groundHeight } from "../sim/elevation";
import { clamp, lerp, norm } from "../sim/math";
import { breakStealth, recomputeStats } from "../sim/stats";
import { ALL_ABILITY_KEYS, nextId } from "../sim/types";
import type { AbilityKey, Unit, World } from "../sim/types";
import {
  createWorld,
  setHeroInput,
  spawnCreep,
  spawnHero,
  step,
  syncAbilityRanks,
  tryJump,
} from "../sim/world";
import { Environment } from "../render/environment";
import { Fx } from "../render/fx";
import type { ModelLibrary } from "../render/models";
import type { View } from "../render/view";
import { WorldView } from "../render/world-view";
import { Cues } from "./cues";
import { runTrailer } from "./trailer-shell";
import type { TrailerScene } from "./trailer-shell";

const SEED = 0xba_77_1e;
const FAR_RESPAWN = 1e15;
const CAMP_NEVER = 1e8;
const COIN_FLIGHT_MS = 900;

const clamp01 = (t: number) => clamp(t, 0, 1);

const easeInOut = (t: number) => {
  const c = clamp01(t);

  return c < 0.5 ? 4 * c * c * c : 1 - (-2 * c + 2) ** 3 / 2;
};

const ramp = (t: number, t0: number, t1: number) => easeInOut((t - t0) / (t1 - t0));

const aimAt = (u: Unit, at: { x: number; y: number }, mx = 0, my = 0, attack = false) => {
  const d = norm(at.x - u.x, at.y - u.y);
  setHeroInput(u, mx, my, d.x, d.y, attack);
};

const nearestAlive = (list: Unit[], to: Unit) => {
  let best: Unit | null = null;
  let bestD = Infinity;

  for (const u of list) {
    if (!u.alive) {
      continue;
    }

    const d = (u.x - to.x) ** 2 + (u.y - to.y) ** 2;

    if (d < bestD) {
      bestD = d;
      best = u;
    }
  }

  return best;
};

interface SceneSpec {
  id: string;
  duration: number;
  burn?: number;
  setup: () => void;
  run?: (t: number) => void;
  teardown?: () => void;
}

class Director {
  private readonly world: World;
  private readonly worldView: WorldView;
  private readonly environment: Environment;
  private readonly fx: Fx;

  private readonly knight: Unit;
  private readonly ranger: Unit;
  private readonly mage: Unit;
  private readonly rogue: Unit;
  private readonly bk: Unit;
  private readonly witch: Unit;
  private readonly heroes: Unit[];
  private readonly warriors: Unit[] = [];
  private readonly minions: Unit[] = [];
  private readonly casters: Unit[] = [];
  private readonly golem: Unit;
  private readonly creeps: Unit[] = [];
  private readonly parkSpot = new Map<string, { x: number; y: number; f: number }>();

  private holding = true;
  private pending: (() => void) | null = null;
  private acc = 0;
  private focusId = "";
  private readonly camPos = new THREE.Vector3(0, 26, 34);
  private readonly camLook = new THREE.Vector3(0, 2, 0);
  private camFov = 52;
  private camMode: "cinematic" | "follow" = "cinematic";
  private musicLevel: 0 | 1 | 2 | 3 = 0;
  private readonly view: View;

  constructor(view: View, lib: ModelLibrary) {
    this.view = view;
    const w = createWorld(SEED);
    this.world = w;
    w.nextCoinAt = Number.MAX_SAFE_INTEGER;
    w.nextDeliveryAt = Number.MAX_SAFE_INTEGER;
    w.killGoal = Number.MAX_SAFE_INTEGER;
    w.matchTime = Number.MAX_SAFE_INTEGER;

    for (const camp of CAMPS) {
      w.campRespawnAt[camp.id] = CAMP_NEVER;
    }

    this.worldView = new WorldView(view.scene, lib);
    this.worldView.localId = "";
    this.worldView.setupBoss();
    this.environment = new Environment(view.scene, lib);
    this.environment.setup();
    view.refreshShadows();
    this.fx = new Fx(view.scene, view);
    this.worldView.fx = this.fx;

    this.knight = this.addHero("knight", 0);
    this.ranger = this.addHero("ranger", 1);
    this.mage = this.addHero("mage", 2);
    this.rogue = this.addHero("rogue", 3);
    this.bk = this.addHero("blackknight", 4);
    this.witch = this.addHero("witch", 5);
    this.heroes = [this.knight, this.ranger, this.mage, this.rogue, this.bk, this.witch];

    const camp0 = { x: 38.05, y: 0 };
    const camp2 = { x: -19.02, y: 32.95 };
    const camp5 = { x: 19.02, y: -32.95 };
    const lair = { x: 25.01, y: 43.33 };

    for (let i = 0; i < 4; i += 1) {
      const a = (i / 4) * Math.PI * 2;
      this.warriors.push(
        this.addCreep("skwarrior", camp0.x + Math.cos(a) * 2.2, camp0.y + Math.sin(a) * 2.2),
      );
    }

    for (let i = 0; i < 4; i += 1) {
      const a = (i / 4) * Math.PI * 2 + 0.7;
      this.minions.push(
        this.addCreep("skminion", camp2.x + Math.cos(a) * 2, camp2.y + Math.sin(a) * 2),
      );
    }

    for (let i = 0; i < 2; i += 1) {
      this.casters.push(this.addCreep("skmage", camp5.x + (i === 0 ? -1.6 : 1.6), camp5.y + 0.8));
    }

    this.golem = this.addCreep("frostgolem", lair.x, lair.y);
    this.parkAll();

    w.fx.length = 0;
    this.worldView.sync(w, 0);

    for (let i = 0; i < 30; i += 1) {
      this.fx.update(w, 0.1);
      this.worldView.sync(w, 0.1);
    }
  }

  private addHero(champId: string, slot: number) {
    const u = spawnHero(this.world, {
      champId,
      id: `star-${champId}`,
      isBot: false,
      name: CHAMP_BY_ID[champId]?.name ?? champId,
      ownerId: `star-${champId}`,
      slot,
      team: `star-${champId}`,
    });

    grantXp(this.world, u, 1e6);

    return u;
  }

  private addCreep(type: string, x: number, y: number) {
    spawnCreep(this.world, type, x, y, { id: "troupe", x, y });
    const u = this.world.units.get(`c${this.world.seq}`);

    if (!u) {
      throw new Error("unreachable: spawnCreep always inserts a unit");
    }

    this.parkSpot.set(u.id, { f: Math.atan2(-y, -x), x, y });
    this.creeps.push(u);

    return u;
  }

  private place(u: Unit, x: number, y: number, facing: number) {
    u.alive = true;
    u.hp = u.maxHp;
    u.respawnAt = 0;
    u.statuses = [];
    u.pendingAttack = null;
    u.queuedCast = null;
    u.kbx = 0;
    u.kby = 0;
    u.kbUntil = 0;
    u.dashUntil = 0;
    u.dashVx = 0;
    u.dashVy = 0;
    u.jumpUntil = 0;
    u.empowerNext = 0;
    u.ambush = false;
    u.steerVx = 0;
    u.steerVy = 0;
    u.vx = 0;
    u.vy = 0;
    u.moveX = 0;
    u.moveY = 0;
    u.attackHeld = false;
    u.x = x;
    u.y = y;
    u.facing = facing;
    u.aimX = Math.cos(facing);
    u.aimY = Math.sin(facing);
    u.swingCount = 0;
    u.lastAttackAt = this.world.now - 9999;

    for (const key of ALL_ABILITY_KEYS) {
      u.abilities[key].readyAt = 0;
    }

    if (u.kind === "creep") {
      u.homeX = x;
      u.homeY = y;
    }
  }

  private parkAll() {
    for (const h of this.heroes) {
      const sp = SPAWNS[h.slot % SPAWNS.length];

      if (sp) {
        this.place(h, sp.x, sp.y, sp.facing);
      }
    }

    for (const c of this.creeps) {
      const p = this.parkSpot.get(c.id);

      if (p) {
        this.place(c, p.x, p.y, p.f);
      }
    }
  }

  private restage() {
    const w = this.world;
    w.projectiles.clear();
    w.grounds = [];
    w.strikes = [];
    w.coins = [];
    w.deliveries = [];
    w.fx.length = 0;
    this.fx.clearNumbers();

    for (const u of w.units.values()) {
      if (u.kind === "prop" && !u.alive) {
        u.alive = true;
        u.hp = u.maxHp;
        u.respawnAt = 0;
        u.statuses = [];
      }
    }

    this.parkAll();
  }

  private pinDeadTroupe() {
    for (const c of this.creeps) {
      if (!c.alive && c.respawnAt < FAR_RESPAWN) {
        c.respawnAt = FAR_RESPAWN;
      }
    }

    for (const h of this.heroes) {
      if (!h.alive && h.respawnAt < FAR_RESPAWN) {
        h.respawnAt = FAR_RESPAWN;
      }
    }
  }

  private focus(u: Unit) {
    this.focusId = u.id;
    this.fx.localId = u.id;
    this.fx.localOwnerId = u.ownerId;
  }

  private music(level: 0 | 1 | 2 | 3) {
    this.musicLevel = level;
    this.fx.audio.music?.setIntensity(level);
  }

  private expose(stops: number) {
    this.view.renderer.toneMappingExposure = stops;
  }

  private damp(gain: number) {
    this.fx.setFlashGain(gain);
    this.view.bloomScale = gain;
  }

  private cast(u: Unit, key: AbilityKey, px: number, py: number) {
    u.abilities[key].readyAt = 0;
    const d = norm(px - u.x, py - u.y);
    castAbility(this.world, u, key, { dir: d, point: { x: px, y: py } });
  }

  private throwCoin(tx: number, ty: number, gold: number) {
    const w = this.world;
    w.coins.push({
      expireAt: w.now + 600_000,
      fromX: BOSS_POS.x,
      fromY: BOSS_POS.y,
      gold,
      id: nextId(w, "coin"),
      landAt: w.now + COIN_FLIGHT_MS,
      x: tx,
      y: ty,
    });
    w.fx.push({ t: "coinThrow", tx, ty, x: BOSS_POS.x, y: BOSS_POS.y });
  }

  private burnFx(ms: number) {
    const dt = 1 / 60;

    for (let i = Math.round(ms / 1000 / dt); i > 0; i -= 1) {
      this.fx.update(this.world, dt);
      this.worldView.sync(this.world, dt * this.fx.scaleNow());
    }
  }

  private preRoll(n: number) {
    for (let i = 0; i < n; i += 1) {
      step(this.world);
      this.pinDeadTroupe();
    }
  }

  private setCam(px: number, ph: number, py: number, lx: number, lh: number, ly: number, fov = 52) {
    this.camPos.set(px, ph, py);
    this.camLook.set(lx, lh, ly);
    this.camFov = fov;
  }

  private scene(spec: SceneSpec) {
    const out: TrailerScene = {
      duration: spec.duration,
      id: spec.id,
      run: (t) => {
        this.holding = false;
        this.pending = spec.run ? () => spec.run?.(t) : null;
      },
      setup: () => {
        this.holding = true;
        this.pending = null;
        this.camMode = "cinematic";
        this.expose(1);
        this.damp(1);
        spec.setup();

        if (spec.burn !== undefined) {
          this.burnFx(spec.burn);
        }

        this.fx.update(this.world, 0);
        this.worldView.sync(this.world, 0);
      },
    };

    if (spec.teardown) {
      out.teardown = spec.teardown;
    }

    return out;
  }

  start() {
    const timer = new THREE.Timer();
    this.view.renderer.setAnimationLoop((t) => {
      timer.update(t);
      const frameDt = Math.min(timer.getDelta(), 1 / 30);

      if (this.holding) {
        this.acc = 0;
      } else {
        this.acc += frameDt;
        let n = 0;

        while (this.acc >= SIM_DT && n < 5) {
          step(this.world);
          this.pinDeadTroupe();
          this.acc -= SIM_DT;
          n += 1;
        }
      }

      const { pending } = this;
      this.pending = null;
      pending?.();
      this.fx.update(this.world, frameDt);
      this.fx.feed.length = 0;
      this.fx.toasts.length = 0;
      this.fx.localHits.length = 0;
      const rdt = frameDt * this.fx.scaleNow();
      this.worldView.sync(this.world, rdt);
      const focus = this.world.units.get(this.focusId);

      if (focus) {
        this.environment.setLocalPos(focus.x, focus.y);
      }

      this.environment.update(this.world.gameTime);
      this.view.tickAura(this.world.gameTime);

      if (this.camMode === "follow" && focus) {
        this.view.follow(
          focus.x,
          focus.y,
          focus.aimX,
          focus.aimY,
          0,
          rdt,
          groundHeight(focus.x, focus.y),
        );
      } else {
        this.view.cinematic(this.camPos, this.camLook, rdt, this.camFov);
      }

      this.view.render();
    });

    runTrailer({
      onGesture: () => {
        this.fx.audio.setMutedEphemeral(false);
        this.fx.audio.music?.setIntensity(this.musicLevel);
      },
      scenes: [
        this.sceneColdOpen(),
        this.sceneHallReveal(),
        this.sceneSignature(),
        this.scenePlayersEye(),
        this.sceneRosterRogue(),
        this.sceneRosterRanger(),
        this.sceneRosterWitch(),
        this.sceneRosterMage(),
        this.sceneDestruction(),
        this.sceneLootPop(),
        this.sceneGolemBoss(),
        this.sceneFrenzy(),
        this.sceneFourWay(),
        this.sceneHeroPose(),
      ],
    });
  }

  private sceneColdOpen() {
    const cues = new Cues();

    return this.scene({
      duration: 3000,
      id: "cold-open-clash",
      run: (t) => {
        cues.at(t >= 320, "q", () => this.cast(this.knight, "Q", 16.5, -5.5));
        const w3 = this.warriors.at(2);

        if (t >= 600 && w3 && w3.alive) {
          aimAt(this.knight, w3, 0, 0, true);
        } else if (t >= 600) {
          setHeroInput(this.knight, 0, 0, this.knight.aimX, this.knight.aimY, false);
        }

        const kp = ramp(t, 0, 3000);
        const kl = ramp(t, 500, 1300);
        this.camPos.set(lerp(20.9, 22.4, kp), lerp(2.55, 2.35, kp), lerp(-0.2, -2.2, kp));
        this.camLook.set(lerp(18.4, 20.2, kl), lerp(1.25, 1.15, kl), lerp(-5.6, -7.6, kl));
        this.camFov = 50;
      },
      setup: () => {
        cues.reset();
        this.restage();
        this.focus(this.knight);
        this.music(1);
        this.damp(0.5);
        this.place(this.knight, 20, -6, Math.atan2(1.4, -3.1));
        const [w1, w2, w3] = this.warriors;

        if (w1) {
          this.place(w1, 16.9, -4.6, 0);
          w1.hp = 180;
        }

        if (w2) {
          this.place(w2, 16.2, -7.2, 0);
          w2.hp = 180;
        }

        if (w3) {
          this.place(w3, 21.3, -10.1, Math.PI / 2);
          w3.hp = 300;
        }

        aimAt(this.knight, { x: 16.5, y: -5.5 });
        this.preRoll(8);
        this.setCam(20.9, 2.55, -0.2, 18.4, 1.25, -5.6, 50);
      },
    });
  }

  private sceneHallReveal() {
    const cues = new Cues();
    const COIN = { x: -12.38, y: -7.15 };

    return this.scene({
      duration: 3400,
      id: "hall-reveal",
      run: (t) => {
        cues.at(t >= 150, "coin", () => this.throwCoin(COIN.x, COIN.y, 300));

        for (const h of this.heroes) {
          const d = norm(-h.x, -h.y);
          setHeroInput(h, d.x, d.y, d.x, d.y, false);
        }

        const k = ramp(t, 0, 3400);
        this.camPos.set(lerp(33, 14.5, k), lerp(19, 6.2, k), lerp(27, 13.5, k));
        this.camLook.set(lerp(2, 0.5, k), lerp(4.5, 3.2, k), lerp(2, 0.5, k));
        this.camFov = lerp(56, 50, k);
      },
      setup: () => {
        cues.reset();
        this.restage();
        this.focus(this.rogue);
        this.music(1);

        for (const h of this.heroes) {
          const sp = SPAWNS[h.slot % SPAWNS.length];

          if (!sp) {
            continue;
          }

          const a = Math.atan2(sp.y, sp.x);
          this.place(h, Math.cos(a) * 27, Math.sin(a) * 27, a + Math.PI);
        }

        this.preRoll(6);
        this.setCam(33, 19, 27, 2, 4.5, 2, 56);
      },
    });
  }

  private sceneSignature() {
    const cues = new Cues();

    return this.scene({
      duration: 2200,
      id: "signature-clean",
      run: (t) => {
        cues.at(t >= 300, "r", () => this.cast(this.bk, "R", this.bk.x, this.bk.y));
        const k = ramp(t, 0, 2200);
        const az = lerp(2.238, 1.885, k);
        this.camPos.set(-16 + Math.cos(az) * 6.8, lerp(2.7, 2.3, k), -14 + Math.sin(az) * 6.8);
        this.camLook.set(-15.5, 1.4, -13.3);
        this.camFov = 48;
      },
      setup: () => {
        cues.reset();
        this.restage();
        this.focus(this.bk);
        this.music(1);
        this.expose(0.88);
        this.damp(0.5);
        this.place(this.bk, -16, -14, Math.atan2(2.2, 2.8));
        const [w] = this.warriors;

        if (w) {
          this.place(w, -13.2, -11.8, Math.atan2(-2.2, -2.8));
        }

        this.preRoll(6);
        this.setCam(-20.2, 2.7, -8.7, -15.4, 1.4, -13.2, 48);
      },
    });
  }

  private scenePlayersEye() {
    const cues = new Cues();

    return this.scene({
      duration: 2800,
      id: "players-eye",
      run: (t) => {
        const k = this.knight;
        cues.at(t >= 620, "hop", () => tryJump(this.world, k));
        const target = nearestAlive(this.warriors, k);

        if (t < 1700 || !target) {
          const inward = norm(-k.x, -k.y);
          const swing = Math.sin(clamp01((t - 800) / 700) * Math.PI) * -0.6;
          const a = Math.atan2(inward.y, inward.x) + swing;
          setHeroInput(k, inward.x, inward.y, Math.cos(a), Math.sin(a), false);
        } else {
          const gap = Math.hypot(target.x - k.x, target.y - k.y);
          const d = norm(target.x - k.x, target.y - k.y);
          const close = gap > 2.6;
          setHeroInput(k, close ? d.x : 0, close ? d.y : 0, d.x, d.y, true);
        }
      },
      setup: () => {
        cues.reset();
        this.restage();
        this.focus(this.knight);
        this.music(2);
        this.place(this.knight, 38, 22, Math.atan2(-22, -38));
        const [w1, w2] = this.warriors;

        if (w1) {
          this.place(w1, 27, 14.6, Math.atan2(7.4, 11));
          w1.hp = 70;
        }

        if (w2) {
          this.place(w2, 29.2, 17, Math.atan2(5, 8.8));
        }

        this.preRoll(3);
        this.camMode = "follow";
        this.view.follow(
          this.knight.x,
          this.knight.y,
          this.knight.aimX,
          this.knight.aimY,
          0,
          1,
          groundHeight(this.knight.x, this.knight.y),
        );
      },
    });
  }

  private sceneRosterRogue() {
    const cues = new Cues();

    return this.scene({
      duration: 950,
      id: "roster-1",
      run: (t) => {
        cues.at(t >= 0, "q", () => this.cast(this.rogue, "Q", 22.6, 9.4));
        const k = ramp(t, 150, 700);
        this.camLook.set(lerp(22, 22.9, k), lerp(1.05, 1.15, k), lerp(9.3, 9, k));
      },
      setup: () => {
        cues.reset();
        this.restage();
        this.focus(this.rogue);
        this.music(2);
        this.damp(0.5);
        this.place(this.rogue, 26, 8, Math.atan2(1.4, -3.4));
        const [m] = this.minions;

        if (m) {
          this.place(m, 22.6, 9.4, Math.atan2(-1.4, 3.4));
          m.hp = 150;
        }

        this.preRoll(4);
        this.setCam(17.7, 2.2, 8.6, 22, 1.05, 9.3, 44);
      },
    });
  }

  private sceneRosterRanger() {
    const cues = new Cues();

    return this.scene({
      burn: 320,
      duration: 950,
      id: "roster-3",
      run: (t) => {
        const k = ramp(t, 0, 950);
        this.camPos.set(lerp(-6.4, -5.4, k), lerp(2.2, 2.5, k), lerp(-30.6, -31.8, k));
      },
      setup: () => {
        cues.reset();
        this.restage();
        this.focus(this.ranger);
        this.expose(0.92);
        this.damp(0.45);
        this.place(this.ranger, 0, -38, Math.PI / 2);

        const ring = [
          { x: 3.2, y: -36.8 },
          { x: -0.6, y: -34.6 },
          { x: -3.2, y: -39.2 },
          { x: 1.2, y: -41.2 },
        ];

        for (const [i, m] of this.minions.entries()) {
          const p = ring[i];

          if (!p) {
            continue;
          }

          this.place(m, p.x, p.y, Math.atan2(-38 - p.y, -p.x));
          m.hp = 100;
        }

        this.preRoll(6);
        this.cast(this.ranger, "JUMP", 0, -32);
        this.preRoll(9);
        this.setCam(-6.4, 2.2, -30.6, 1.2, 3.2, -37, 50);
      },
    });
  }

  private sceneRosterWitch() {
    const cues = new Cues();

    return this.scene({
      duration: 1200,
      id: "roster-5",
      run: (t) => {
        cues.at(t >= 60, "r", () => this.cast(this.witch, "R", 15.4, -19.2));
        const k = ramp(t, 550, 1050);
        this.camPos.set(lerp(8.4, 10, k), lerp(3.2, 1.6, k), lerp(-24.4, -23, k));
      },
      setup: () => {
        cues.reset();
        this.restage();
        this.focus(this.witch);
        this.damp(0.75);
        this.place(this.witch, 12.4, -20.2, Math.atan2(0.8, 3.3));

        const pack = [
          { u: this.warriors[0], x: 15.2, y: -17.9 },
          { u: this.minions[0], x: 16.6, y: -19.2 },
          { u: this.minions[1], x: 15.4, y: -21 },
        ];

        for (const p of pack) {
          if (p.u) {
            this.place(p.u, p.x, p.y, Math.atan2(-20.2 - p.y, 12.4 - p.x));
          }
        }

        this.preRoll(5);
        this.setCam(8.4, 3.2, -24.4, 15, 1.2, -19.6);
      },
    });
  }

  private sceneRosterMage() {
    return this.scene({
      burn: 350,
      duration: 1400,
      id: "roster-6",
      run: (t) => {
        const k = ramp(t, 0, 1400);
        this.camPos.set(lerp(6.6, 5.6, k), lerp(2.6, 2.8, k), lerp(19.6, 18.2, k));
      },
      setup: () => {
        this.restage();
        this.focus(this.mage);
        this.expose(0.84);
        this.place(this.mage, 0, 17, -Math.PI / 2);

        const pack = [
          { u: this.warriors[0], x: -1.4, y: 8.6 },
          { u: this.warriors[1], x: 1.5, y: 9.4 },
          { u: this.minions[0], x: -0.2, y: 7.2 },
          { u: this.minions[1], x: 1.9, y: 7.8 },
        ];

        for (const p of pack) {
          if (p.u) {
            this.place(p.u, p.x, p.y, -Math.PI / 2);
          }
        }

        this.cast(this.mage, "R", 0, 9);
        this.preRoll(14);
        this.setCam(6.6, 2.6, 19.6, 1, 2.4, 12.6, 56);
      },
    });
  }

  private sceneDestruction() {
    const cues = new Cues();

    return this.scene({
      duration: 2050,
      id: "destruction",
      run: (t) => {
        cues.at(t >= 120, "r", () => this.cast(this.knight, "R", this.knight.x - 1, this.knight.y));

        if (t < 1100) {
          setHeroInput(this.knight, -1, 0.12, -1, 0.12, false);
        } else {
          setHeroInput(this.knight, -1, -0.25, -1, -0.25, false);
        }

        const k = this.knight;
        this.camPos.set(k.x + 3.5, 1.75, k.y + 4.3);
        this.camLook.set(k.x - 2.4, 1, k.y - 0.3);
        this.camFov = 52;
      },
      setup: () => {
        cues.reset();
        this.restage();
        this.focus(this.knight);
        this.music(2);
        this.place(this.knight, -32, 1.4, Math.PI);
        setHeroInput(this.knight, -1, 0.1, -1, 0.1, false);
        this.preRoll(4);
        this.setCam(-28.5, 1.75, 5.7, -33.2, 1, 1.1);
      },
    });
  }

  private sceneLootPop() {
    const cues = new Cues();

    return this.scene({
      duration: 2400,
      id: "loot-pop",
      run: (t) => {
        const [sm] = this.casters;

        if (t < 520 && sm && sm.alive) {
          aimAt(this.ranger, sm, 0, 0, true);
        } else if (t < 780) {
          setHeroInput(this.ranger, 0, 0, this.ranger.aimX, this.ranger.aimY, false);
        }

        cues.at(t >= 780, "dash", () => {
          const [c] = this.world.coins;

          if (c) {
            this.cast(this.ranger, "DASH", c.x, c.y);
          }
        });
        cues.at(t >= 1250, "lvl", () => grantXp(this.world, this.ranger, 400));

        if (t >= 700) {
          const k = ramp(t, 700, 1200);
          this.camLook.set(
            lerp(21.4, this.ranger.x, k),
            lerp(1, 1.15, k),
            lerp(-12.6, this.ranger.y, k),
          );
        }
      },
      setup: () => {
        cues.reset();
        this.restage();
        this.focus(this.ranger);
        this.expose(0.88);
        this.damp(0.5);
        this.ranger.level = 11;
        this.ranger.xp = (XP_CURVE[11] ?? 4000) - 200;
        syncAbilityRanks(this.ranger);
        recomputeStats(this.ranger);
        this.ranger.hp = this.ranger.maxHp;
        this.place(this.ranger, 24, -14, Math.atan2(2.2, -5.5));
        const [sm] = this.casters;

        if (sm) {
          this.place(sm, 18.5, -11.8, Math.atan2(-2.2, 5.5));
          sm.hp = 40;
        }

        this.preRoll(3);
        this.setCam(15.6, 2.6, -8.4, 21.4, 1, -12.6);
      },
    });
  }

  private sceneGolemBoss() {
    const cues = new Cues();
    let dodgedAt = -1;
    let mark: { x: number; y: number } | null = null;

    return this.scene({
      duration: 4400,
      id: "golem-boss",
      run: (t) => {
        const g = this.golem;
        const r = this.rogue;

        if (dodgedAt < 0) {
          const away = norm(r.x - g.x, r.y - g.y);
          const gap = Math.hypot(r.x - g.x, r.y - g.y);

          if (t < 1200 && gap < 5.2) {
            setHeroInput(r, away.x - away.y, away.y + away.x, -away.x, -away.y, false);
          } else {
            aimAt(r, g, 0, 0, false);
          }
        }

        const pending = g.pendingAttack;

        const dodgeNow =
          dodgedAt < 0 &&
          ((pending !== null && this.world.now >= pending.resolveAt - 220) || t >= 2600);

        cues.at(dodgeNow, "dodge", () => {
          dodgedAt = t;
          this.cast(r, "DASH", g.x + (g.x - r.x), g.y + (g.y - r.y));
        });
        cues.at(dodgedAt >= 0 && t >= dodgedAt + 450, "execute", () => {
          aimAt(r, g, 0, 0, false);
          this.cast(r, "R", g.x, g.y);
        });

        if (mark === null && !g.alive) {
          mark = { x: g.x, y: g.y };
        }

        const m = mark ?? g;
        const lensX = m.x + 2.8;
        const lensY = m.y - 4.6;

        if (dodgedAt >= 0 && t >= dodgedAt + 1300) {
          const [c] = this.world.coins;

          if (c) {
            const d = norm(c.x - r.x, c.y - r.y);
            setHeroInput(r, d.x * 0.5, d.y * 0.5, d.x, d.y, false);
          } else {
            const toLens = norm(lensX - r.x, lensY - r.y);
            setHeroInput(r, 0, 0, toLens.x, toLens.y, false);
          }
        }

        const kA = ramp(t, 0, 1400);
        const kB = ramp(t, 1400, 2400);
        const kC = ramp(t, 3000, 3800);
        const px = lerp(lerp(17.5, 19.2, kA), 24, kB);
        const ph = lerp(lerp(7.5, 6.6, kA), 2.6, kB);
        const py = lerp(lerp(11.5, 13.2, kA), 16.5, kB);
        this.camPos.set(lerp(px, lensX, kC), lerp(ph, 2.3, kC), lerp(py, lensY, kC));
        const lx = lerp(28.5, 29.5, kB);
        const lh = lerp(lerp(2.6, 2.3, kA), 1.5, kB);
        const ly = 22.5;
        this.camLook.set(lerp(lx, r.x, kC), lerp(lh, 1.15, kC), lerp(ly, r.y, kC));
        this.camFov = lerp(lerp(55, 50, kB), 46, kC);
      },
      setup: () => {
        cues.reset();
        dodgedAt = -1;
        mark = null;
        this.restage();
        this.focus(this.rogue);
        this.music(3);
        this.place(this.golem, 28, 22, Math.atan2(4.5, 5.5));
        this.golem.hp = 620;
        this.golem.swingCount = 1;
        this.place(this.rogue, 32, 26, Math.atan2(-4.5, -5.5));
        this.preRoll(6);
        this.setCam(17.5, 7.5, 11.5, 28.5, 2.6, 22.5, 55);
      },
    });
  }

  private sceneFrenzy() {
    const cues = new Cues();
    const horde: Unit[] = [];
    const BLINK_MS = 2600;
    const JUMP_MS = 3300;
    const anchor = new THREE.Vector2();
    const preBlink = new THREE.Vector2();

    return this.scene({
      duration: 4400,
      id: "arena-frenzy",
      run: (t) => {
        const m = this.mage;
        const target = nearestAlive(horde, m);
        const sway = Math.sin(t * 0.003) * 0.35;

        if (target) {
          const d = norm(target.x - m.x, target.y - m.y);
          setHeroInput(m, -d.y * sway, d.x * sway, d.x, d.y, false);
        }

        cues.at(t >= 100, "e", () => this.cast(m, "E", -4, -23.5));
        cues.at(t >= 800, "q1", () => {
          const at = nearestAlive(this.warriors, m);
          this.cast(m, "Q", at ? at.x : -4.5, at ? at.y : -24);
        });
        cues.at(t >= 1800, "w", () => this.cast(m, "W", -3, -22));
        cues.at(t >= BLINK_MS, "blink", () => this.cast(m, "DASH", m.x - 8, m.y + 1.5));
        cues.at(t >= JUMP_MS, "jump", () => this.cast(m, "JUMP", m.x, m.y - 4));
        cues.at(t >= 3900, "q2", () => {
          const at = nearestAlive(horde, m);
          this.cast(m, "Q", at ? at.x : m.x, at ? at.y : m.y - 6);
        });
        const az = Math.PI / 3 + (Math.PI / 2) * (t / 4400);
        const air = clamp01((t - JUMP_MS + 50) / 260) * (1 - clamp01((t - JUMP_MS - 820) / 260));

        if (t < BLINK_MS) {
          preBlink.set(m.x, m.y);
        }

        const kBlink = ramp(t, BLINK_MS, BLINK_MS + 450);
        anchor.set(lerp(preBlink.x, m.x, kBlink), lerp(preBlink.y, m.y, kBlink));
        this.camPos.set(
          anchor.x + Math.cos(az) * 7.6,
          3 + air * 2.1,
          anchor.y + Math.sin(az) * 7.6,
        );
        this.camLook.set(
          anchor.x + Math.cos(az + Math.PI / 2) * 1.2,
          1.9 + air * 2,
          anchor.y + Math.sin(az + Math.PI / 2) * 1.2,
        );
        this.camFov = 52;
      },
      setup: () => {
        cues.reset();
        this.restage();
        this.focus(this.mage);
        this.music(3);
        this.expose(0.78);
        this.damp(0.55);
        this.place(this.mage, -4, -18, -Math.PI / 2);
        anchor.set(-4, -18);
        preBlink.set(-4, -18);

        const staging = [
          { u: this.warriors[0], x: -7.5, y: -24.5 },
          { u: this.warriors[1], x: -1, y: -25.5 },
          { u: this.warriors[2], x: -4.5, y: -26.5 },
          { u: this.minions[0], x: -9.5, y: -22.5 },
          { u: this.minions[1], x: 1.5, y: -23 },
          { u: this.casters[0], x: -10, y: -26 },
          { u: this.casters[1], x: -1.5, y: -28.6 },
          { u: this.warriors[3], x: -12.5, y: -22 },
          { u: this.minions[2], x: 3.5, y: -26 },
          { u: this.minions[3], x: -6.5, y: -28.5 },
        ];

        horde.length = 0;

        for (const h of staging) {
          if (!h.u) {
            continue;
          }

          this.place(h.u, h.x, h.y, Math.atan2(-18 - h.y, -4 - h.x));
          horde.push(h.u);
        }

        this.preRoll(12);
        this.setCam(1.5, 3.2, -12, -4.5, 1.5, -19.5, 52);
      },
    });
  }

  private sceneFourWay() {
    const cues = new Cues();

    return this.scene({
      duration: 4300,
      id: "four-way",
      run: (t) => {
        const a = this.bk;
        const rv = this.ranger;
        const mg = this.mage;
        const vp = this.rogue;

        cues.at(t >= 0, "volley", () => this.cast(rv, "Q", a.x, a.y));

        if (t < 700) {
          aimAt(rv, a, -Math.SQRT1_2, -Math.SQRT1_2, false);
        } else if (t < 2500) {
          aimAt(rv, a, 0, 0, false);
        }

        cues.at(t >= 350, "bastion", () => this.cast(a, "E", a.x, a.y));
        const stepOut = t >= 1600 && t < 1900;

        if (t < 2400) {
          aimAt(a, rv, stepOut ? Math.SQRT1_2 : 0, stepOut ? Math.SQRT1_2 : 0, false);
        }

        cues.at(t >= 900, "blink", () => this.cast(mg, "DASH", 11.5, 12.5));
        cues.at(t >= 1400, "nova", () => this.cast(mg, "W", rv.x, rv.y));

        if (t >= 1000) {
          aimAt(mg, rv, 0, 0, false);
        }

        cues.at(t >= 1900, "smoke", () => this.cast(vp, "E", vp.x, vp.y));

        cues.at(t >= 2400, "brace", () => {
          rv.hp = rv.maxHp;
        });
        cues.at(t >= 2500, "slam", () => this.cast(a, "R", a.x, a.y));

        if (t >= 2600 && t < 3100) {
          const d = norm(rv.x - vp.x, rv.y - vp.y);
          setHeroInput(vp, d.x, d.y, d.x, d.y, false);
        }

        cues.at(t >= 3050, "focus", () => this.focus(vp));
        cues.at(t >= 3100, "execute", () => {
          rv.hp = 60;
          setHeroInput(vp, 0, 0, vp.aimX, vp.aimY, false);
          aimAt(vp, rv, 0, 0, false);
          this.cast(vp, "R", rv.x, rv.y);
        });
        cues.at(t >= 3350, "reveal", () => breakStealth(vp));

        const p = 0.34 * ramp(t, 0, 1400) + 0.14 * ramp(t, 1400, 2400) + 0.52 * ramp(t, 2400, 4300);
        const az = lerp(-0.904, -0.175, p);
        const rad = lerp(9.6, 10.4, p);
        const kC = ramp(t, 3200, 4300);
        const sx = (vp.x + rv.x) / 2;
        const sy = (vp.y + rv.y) / 2;
        this.camPos.set(
          lerp(10.2 + Math.cos(az) * rad, sx + 5.4, kC),
          lerp(lerp(2.6, 4.4, ramp(t, 600, 2000)) - 1.4 * ramp(t, 2400, 4300), 5.3, kC),
          lerp(10.2 + Math.sin(az) * rad, sy - 6.4, kC),
        );
        this.camLook.set(
          lerp(lerp(9.4, 11.2, p), sx, kC),
          lerp(lerp(2, 1.7, p), 1.5, kC),
          lerp(lerp(9.6, 11.4, p), sy, kC),
        );
        this.camFov = 50;
      },
      setup: () => {
        cues.reset();
        this.restage();
        this.focus(this.bk);
        this.music(3);
        this.expose(0.8);
        this.place(this.bk, 6.36, 6.36, Math.PI / 4);
        this.place(this.ranger, 12.37, 12.37, (5 * Math.PI) / 4);
        this.place(this.mage, 7, 17, -Math.PI / 4);
        this.place(this.rogue, 12.6, 16.4, (5 * Math.PI) / 4);
        this.preRoll(4);
        this.setCam(16.13, 2.6, 2.66, 9.4, 2, 9.6, 50);
      },
    });
  }

  private sceneHeroPose() {
    const cues = new Cues();
    const LIP = { x: 7.35, y: -7.35 };
    const COIN = { x: 10.47, y: -10.47 };
    const ORBIT = { x: 8.9, y: -8.9 };

    return this.scene({
      duration: 3000,
      id: "hero-pose",
      run: (t) => {
        if (t >= 950) {
          const [c] = this.world.coins;

          if (c) {
            aimAt(this.bk, c, c.x - this.bk.x, c.y - this.bk.y, false);
          } else {
            setHeroInput(this.bk, 0, 0, this.bk.aimX, this.bk.aimY, false);
          }
        }

        cues.at(t >= 2050, "stop", () => {
          setHeroInput(this.bk, 0, 0, this.bk.aimX, this.bk.aimY, false);
        });
        const k = ramp(t, 0, 1900);
        const kS = ramp(t, 1500, 2450);
        const az = lerp(-1.9, -Math.PI / 4, k);
        const gh = groundHeight(this.bk.x, this.bk.y);
        const rad = lerp(6.4, 4.3, kS);
        const lat = lerp(1.8, 0, kS);
        this.camPos.set(
          lerp(ORBIT.x, this.bk.x, kS) + Math.cos(az) * rad,
          gh + lerp(2.35, 1.95, kS),
          lerp(ORBIT.y, this.bk.y, kS) + Math.sin(az) * rad,
        );
        this.camLook.set(
          this.bk.x + Math.cos(az + Math.PI / 2) * lat,
          gh + lerp(1.25, 1, kS),
          this.bk.y + Math.sin(az + Math.PI / 2) * lat,
        );
        this.camFov = 45;
      },
      setup: () => {
        cues.reset();
        this.restage();
        this.focus(this.bk);
        this.music(1);
        this.place(this.bk, LIP.x, LIP.y, -Math.PI / 4);
        this.throwCoin(COIN.x, COIN.y, 300);
        this.setCam(6.83, 4.35, -14.96, LIP.x, 3.25, LIP.y, 45);
      },
      teardown: () => {
        this.holding = true;
      },
    });
  }
}

/** Boot trailer mode: assets are already loaded by main(); this owns the
 *  render loop and hands scene control to the shell. */
export const runBattleArenaTrailer = (view: View, lib: ModelLibrary) => {
  const director = new Director(view, lib);

  if (import.meta.env.DEV) {
    Object.assign(window, { __baTrailer: director });
  }

  director.start();
};
