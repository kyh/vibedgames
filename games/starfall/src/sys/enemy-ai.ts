import { Math as PhaserMath } from "phaser";
import type { GameScene } from "../scenes/game-scene";
import {
  BEACON_RETARGET_RANGE,
  BOSS_BROOD_CAP,
  BOSS_LANCE_SHOT_SPEED,
  BOSS_ORBIT_RADIUS,
  BOSS_P1_CYCLE_MS,
  BOSS_P1_SPREAD_COUNT,
  BOSS_P1_SPREAD_DEG,
  BOSS_P1_TELEGRAPH_MS,
  BOSS_P2_AIM_MS,
  BOSS_P2_CYCLE_MS,
  BOSS_P2_LANCES,
  BOSS_P3_CYCLE_MS,
  BOSS_P3_MITES,
  BOSS_P3_NOVA_COUNT,
  BOSS_P3_TELEGRAPH_MS,
  BOSS_SHOT_SPEED,
  BOSS_SPEED,
  DRONE_COOLDOWN_MS,
  DRONE_FIRE_CONE_DEG,
  DRONE_SHOT_SPEED,
  DRONE_SPEED,
  DRONE_TELEGRAPH_MS,
  DRONE_TURN_DEG_PER_S,
  ENEMY_FIRE_RANGE,
  ENEMY_SHOT_TTL_MS,
  LANCER_CHARGE_MS,
  LANCER_CHARGE_RANGE,
  LANCER_CHARGE_SPEED,
  LANCER_CRUISE_SPEED,
  LANCER_RECOVER_MS,
  LANCER_WINDUP_MS,
  MITE_GRACE_MS,
  SNIPER_AIM_MS,
  SNIPER_COOLDOWN_MS,
  SNIPER_FIRE_RANGE,
  SNIPER_KEEP_DIST,
  SNIPER_SHOT_SPEED,
  SNIPER_SPEED,
  SPAWNER_BROOD_CAP,
  SPAWNER_BROOD_PER_PULSE,
  SPAWNER_PULSE_MS,
  SPAWNER_SPEED,
  SPAWNER_TELEGRAPH_MS,
  SPLITTER_CHILD_SPEED,
  SPLITTER_SPEED,
  WARDEN_COOLDOWN_MS,
  WARDEN_FIRE_RANGE,
  WARDEN_SHOT_SPEED,
  WARDEN_SPEED,
  WARDEN_TELEGRAPH_MS,
  WARDEN_TURN_DEG_PER_S,
  WARDEN_VENT_MS,
  WASP_BURST_COUNT,
  WASP_BURST_GAP_MS,
  WASP_COOLDOWN_MS,
  WASP_ORBIT_RADIUS,
  WASP_SHOT_SPEED,
  WASP_SPEED,
  WASP_TELEGRAPH_MS,
  WASP_WOBBLE_AMP,
  WASP_WOBBLE_HZ,
  bossPhase,
  entityId,
  spawnEnemyState,
} from "../shared/constants";
import type { EnemyState, Vec } from "../shared/constants";
import { rand } from "../shared/rng";
import { DEG, nearestOf, nearestPlayers, rotateToward, wrapAngle } from "./geometry";

type AiScene = Pick<GameScene, "host" | "world">;

/** Host-private per-enemy AI bookkeeping (lost on migration — acceptable). */
export interface EnemySim {
  nextAttackAt: number;
  /** Telegraphed action lands at this time (0 = none pending). */
  fireAt: number;
  burstLeft: number;
  nextBurstShotAt: number;
  lancerPhase: "cruise" | "windup" | "charge" | "recover";
  phaseUntil: number;
  orbitDir: 1 | -1;
  wobblePhase: number;
  /** RAM/barrier knockback velocity. Steering rewrites e.vx/vy every tick, so
   *  impulses live here, decay, and ride on top (LANCER takes direct vx/vy). */
  kbVx: number;
  kbVy: number;
  /** SPAWNER/BOSS: live mites attributed to this parent (self-caps the brood). */
  broodCount: number;
  /** Mites: the spawner/boss they belong to (decrements broodCount on death). */
  broodParent: string | null;
  /** BOSS: last phase seen by the damage clamp (0 = none yet) + when the
   *  current phase's minimum-duration window ends. Host-local by design: a
   *  migrated host restarts the window from inherited HP, which can only
   *  lengthen the fight, never shorten or desync it (phase itself stays
   *  derived from HP). */
  bossPhaseSeen: 0 | 1 | 2 | 3;
  bossPhaseFloorUntil: number;
}

/** One enemy's steering frame: the chosen target and the vector to it. */
export interface EnemyAim {
  target: Vec;
  dx: number;
  dy: number;
  dist: number;
  desired: number;
}

/** Host-side enemy steering and attack patterns per kind (drone, wasp, lancer, warden, sniper, spawner) and the three dreadnought phases. Per-enemy bookkeeping is host-private and rebuilt on migration. */
export class EnemyAi {
  // host-only director state (lost on migration — acceptable per design)
  enemySim = new Map<string, EnemySim>();

  private readonly scene: AiScene;

  constructor(scene: AiScene) {
    this.scene = scene;
  }

  simFor(id: string): EnemySim {
    let sim = this.enemySim.get(id);
    if (!sim) {
      sim = {
        bossPhaseFloorUntil: 0,
        bossPhaseSeen: 0,
        broodCount: 0,
        broodParent: null,
        burstLeft: 0,
        fireAt: 0,
        kbVx: 0,
        kbVy: 0,
        lancerPhase: "cruise",
        nextAttackAt: 0,
        nextBurstShotAt: 0,
        orbitDir: rand() < 0.5 ? 1 : -1,
        phaseUntil: 0,
        wobblePhase: rand() * Math.PI * 2,
      };
      this.enemySim.set(id, sim);
    }
    return sim;
  }

  private hostSpawnShot(enemy: EnemyState, angle: number, speed: number, now: number): void {
    enemy.attackAt = now;
    this.scene.host.dirty.enemies = true;
    this.scene.world.enemyShots.push({
      diesAt: now + ENEMY_SHOT_TTL_MS,
      id: entityId(),
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      x: enemy.x,
      y: enemy.y,
    });
    this.scene.host.dirty.enemyShots = true;
  }

  /** Host AI: steering, telegraphs and firing for every enemy (§6.1). */
  hostSimEnemies(now: number, dt: number, players: Vec[]): void {
    for (const e of this.scene.world.enemies) {
      const sim = this.simFor(e.id);
      // Knockback decays independently of steering (≈ gone in a second).
      const kbDecay = Math.exp(-4 * dt);
      sim.kbVx *= kbDecay;
      sim.kbVy *= kbDecay;
      const target = this.enemyTarget(e, players);
      if (!target) {
        e.vx *= Math.exp(-1 * dt);
        e.vy *= Math.exp(-1 * dt);
        continue;
      }
      const dx = target.x - e.x;
      const dy = target.y - e.y;
      const dist = Math.hypot(dx, dy) || 1;
      const aim: EnemyAim = { desired: Math.atan2(dy, dx), dist, dx, dy, target };
      this.simEnemyKind(e, sim, aim, players, now, dt);
      // Steering set vx/vy absolutely — ride the decaying knockback on top.
      // LANCER (mid-charge) and the BOSS own their velocity directly.
      if (e.kind !== "lancer" && e.kind !== "dreadnought") {
        e.vx += sim.kbVx;
        e.vy += sim.kbVy;
      }
    }
    // Garbage-collect sims for enemies that no longer exist.
    if (this.enemySim.size > this.scene.world.enemies.length + 8) {
      const live = new Set(this.scene.world.enemies.map((e) => e.id));
      for (const id of this.enemySim.keys()) {
        if (!live.has(id)) {
          this.enemySim.delete(id);
        }
      }
    }
  }

  /** Nearest living player — except fodder near a BEACON, which steers for
   *  the zone's center instead (nearest-of semantics, so a player inside the
   *  zone is closer and wins). */
  private enemyTarget(e: EnemyState, players: Vec[]): Vec | null {
    const target = nearestOf(players, e.x, e.y);
    const { beacon } = this.scene.world;
    if (beacon && (e.kind === "drone" || e.kind === "wasp")) {
      const bd = Math.hypot(beacon.x - e.x, beacon.y - e.y);
      if (
        bd < BEACON_RETARGET_RANGE &&
        (!target || bd < Math.hypot(target.x - e.x, target.y - e.y))
      ) {
        return { x: beacon.x, y: beacon.y };
      }
    }
    return target;
  }

  private simEnemyKind(
    e: EnemyState,
    sim: EnemySim,
    aim: EnemyAim,
    players: Vec[],
    now: number,
    dt: number,
  ): void {
    switch (e.kind) {
      case "drone": {
        this.simDrone(e, sim, aim, now, dt);
        break;
      }
      case "wasp": {
        this.simWasp(e, sim, aim, now);
        break;
      }
      case "lancer": {
        this.simLancer(e, sim, aim, now, dt);
        break;
      }
      case "splitter": {
        e.angle = rotateToward(e.angle, aim.desired, 60 * DEG * dt);
        e.vx = Math.cos(e.angle) * SPLITTER_SPEED;
        e.vy = Math.sin(e.angle) * SPLITTER_SPEED;
        break;
      }
      case "warden": {
        this.simWarden(e, sim, aim, now, dt);
        break;
      }
      case "sniper": {
        this.simSniper(e, sim, aim, now);
        break;
      }
      case "spawner": {
        this.simSpawner(e, sim, aim, now, dt);
        break;
      }
      case "dreadnought": {
        this.hostSimBoss(e, sim, players, aim.desired, now, dt);
        break;
      }
      default: {
        e.kind satisfies never;
      }
    }
  }

  private simDrone(e: EnemyState, sim: EnemySim, aim: EnemyAim, now: number, dt: number): void {
    const { desired, dist } = aim;
    e.angle = rotateToward(e.angle, desired, DRONE_TURN_DEG_PER_S * DEG * dt);
    e.vx = Math.cos(e.angle) * DRONE_SPEED;
    e.vy = Math.sin(e.angle) * DRONE_SPEED;
    if (sim.fireAt > 0) {
      if (now >= sim.fireAt) {
        sim.fireAt = 0;
        sim.nextAttackAt = now + DRONE_COOLDOWN_MS;
        if (dist < ENEMY_FIRE_RANGE) {
          this.hostSpawnShot(e, desired, DRONE_SHOT_SPEED, now);
        }
      }
    } else if (
      now >= sim.nextAttackAt &&
      e.graceUntil <= now &&
      dist < ENEMY_FIRE_RANGE &&
      Math.abs(wrapAngle(desired - e.angle)) < DRONE_FIRE_CONE_DEG * DEG
    ) {
      e.telegraphUntil = now + DRONE_TELEGRAPH_MS;
      sim.fireAt = e.telegraphUntil;
    }
  }

  private simWasp(e: EnemyState, sim: EnemySim, aim: EnemyAim, now: number): void {
    const { desired, dist, dx, dy } = aim;
    e.angle = desired;
    if (dist > WASP_ORBIT_RADIUS + 80) {
      e.vx = (dx / dist) * WASP_SPEED;
      e.vy = (dy / dist) * WASP_SPEED;
    } else {
      // Perpendicular strafe around the orbit ring + sin wobble.
      const wobble =
        Math.sin((now / 1000) * WASP_WOBBLE_HZ * Math.PI * 2 + sim.wobblePhase) * WASP_WOBBLE_AMP;
      const radialErr = dist - (WASP_ORBIT_RADIUS + wobble);
      const inX = dx / dist;
      const inY = dy / dist;
      let mx = -inY * sim.orbitDir + inX * PhaserMath.Clamp(radialErr / 80, -1, 1);
      let my = inX * sim.orbitDir + inY * PhaserMath.Clamp(radialErr / 80, -1, 1);
      const mlen = Math.hypot(mx, my) || 1;
      mx /= mlen;
      my /= mlen;
      e.vx = mx * WASP_SPEED;
      e.vy = my * WASP_SPEED;
    }
    if (sim.burstLeft > 0) {
      if (now >= sim.nextBurstShotAt) {
        this.hostSpawnShot(e, desired, WASP_SHOT_SPEED, now);
        sim.burstLeft -= 1;
        sim.nextBurstShotAt = now + WASP_BURST_GAP_MS;
        if (sim.burstLeft === 0) {
          sim.nextAttackAt = now + WASP_COOLDOWN_MS;
        }
      }
    } else if (sim.fireAt > 0) {
      if (now >= sim.fireAt) {
        sim.fireAt = 0;
        sim.burstLeft = WASP_BURST_COUNT;
        sim.nextBurstShotAt = now;
      }
    } else if (now >= sim.nextAttackAt && dist < ENEMY_FIRE_RANGE) {
      e.telegraphUntil = now + WASP_TELEGRAPH_MS;
      sim.fireAt = e.telegraphUntil;
    }
  }

  private simLancer(e: EnemyState, sim: EnemySim, aim: EnemyAim, now: number, dt: number): void {
    const { desired, dist } = aim;
    switch (sim.lancerPhase) {
      case "cruise": {
        e.angle = rotateToward(e.angle, desired, 120 * DEG * dt);
        e.vx = Math.cos(e.angle) * LANCER_CRUISE_SPEED;
        e.vy = Math.sin(e.angle) * LANCER_CRUISE_SPEED;
        if (dist < LANCER_CHARGE_RANGE + 80 && now >= sim.nextAttackAt) {
          sim.lancerPhase = "windup";
          sim.phaseUntil = now + LANCER_WINDUP_MS;
          e.telegraphUntil = sim.phaseUntil;
          // the locked charge vector
          e.angle = desired;
          e.vx = 0;
          e.vy = 0;
        }
        break;
      }
      case "windup": {
        if (now >= sim.phaseUntil) {
          sim.lancerPhase = "charge";
          sim.phaseUntil = now + LANCER_CHARGE_MS;
          e.chargeUntil = sim.phaseUntil;
          e.vx = Math.cos(e.angle) * LANCER_CHARGE_SPEED;
          e.vy = Math.sin(e.angle) * LANCER_CHARGE_SPEED;
        }
        break;
      }
      case "charge": {
        // Locked vector — it can't turn while charging.
        if (
          now >= sim.phaseUntil ||
          e.x <= 0 ||
          e.x >= this.scene.world.playW ||
          e.y <= 0 ||
          e.y >= this.scene.world.playH
        ) {
          sim.lancerPhase = "recover";
          sim.phaseUntil = now + LANCER_RECOVER_MS;
          e.chargeUntil = 0;
        }
        break;
      }
      case "recover": {
        const decay = Math.exp(-3 * dt);
        e.vx *= decay;
        e.vy *= decay;
        if (now >= sim.phaseUntil) {
          sim.lancerPhase = "cruise";
          // recovery IS the cooldown
          sim.nextAttackAt = now;
        }
        break;
      }
      default: {
        sim.lancerPhase satisfies never;
      }
    }
  }

  /** Slow advance. Shield up except during the post-mortar vent window. */
  private simWarden(e: EnemyState, sim: EnemySim, aim: EnemyAim, now: number, dt: number): void {
    const { desired, dist } = aim;
    e.angle = rotateToward(e.angle, desired, WARDEN_TURN_DEG_PER_S * DEG * dt);
    e.vx = Math.cos(e.angle) * WARDEN_SPEED;
    e.vy = Math.sin(e.angle) * WARDEN_SPEED;
    if (sim.fireAt > 0) {
      if (now >= sim.fireAt) {
        sim.fireAt = 0;
        // vent: shield down
        sim.nextBurstShotAt = now + WARDEN_VENT_MS;
        sim.nextAttackAt = now + WARDEN_COOLDOWN_MS;
        e.shielded = false;
        if (dist < WARDEN_FIRE_RANGE) {
          this.hostSpawnShot(e, desired, WARDEN_SHOT_SPEED, now);
        }
      }
    } else if (now < sim.nextBurstShotAt) {
      // venting
      e.shielded = false;
    } else if (now >= sim.nextAttackAt && dist < WARDEN_FIRE_RANGE) {
      e.telegraphUntil = now + WARDEN_TELEGRAPH_MS;
      sim.fireAt = e.telegraphUntil;
      // shield up through the windup
      e.shielded = true;
    } else {
      e.shielded = true;
    }
  }

  /** Kite to keep distance; charge a laser sight; fire one fast bolt. */
  private simSniper(e: EnemyState, sim: EnemySim, aim: EnemyAim, now: number): void {
    const { desired, dist, dx, dy, target } = aim;
    e.angle = desired;
    const err = dist - SNIPER_KEEP_DIST;
    if (Math.abs(err) > 40) {
      // in if too far, out if too close
      const sgn = err > 0 ? 1 : -1;
      e.vx = (dx / dist) * SNIPER_SPEED * sgn;
      e.vy = (dy / dist) * SNIPER_SPEED * sgn;
    } else {
      // strafe at range
      e.vx = -(dy / dist) * SNIPER_SPEED * sim.orbitDir;
      e.vy = (dx / dist) * SNIPER_SPEED * sim.orbitDir;
    }
    if (sim.fireAt > 0) {
      if (now >= sim.fireAt) {
        sim.fireAt = 0;
        sim.nextAttackAt = now + SNIPER_COOLDOWN_MS;
        const [lance] = e.lances;
        e.lances = [];
        if (lance && dist < SNIPER_FIRE_RANGE) {
          this.hostSpawnShot(e, Math.atan2(lance.y - e.y, lance.x - e.x), SNIPER_SHOT_SPEED, now);
        }
      } else {
        // plant while aiming
        e.vx *= 0.2;
        e.vy *= 0.2;
      }
    } else if (now >= sim.nextAttackAt && dist < SNIPER_FIRE_RANGE) {
      e.telegraphUntil = now + SNIPER_AIM_MS;
      sim.fireAt = e.telegraphUntil;
      // lock current pos (no lead)
      e.lances = [{ x: target.x, y: target.y }];
    }
  }

  /** Drift slowly; birth a brood on a telegraphed pulse, self-capped. */
  private simSpawner(e: EnemyState, sim: EnemySim, aim: EnemyAim, now: number, dt: number): void {
    e.angle = rotateToward(e.angle, aim.desired, 30 * DEG * dt);
    e.vx = Math.cos(e.angle) * SPAWNER_SPEED;
    e.vy = Math.sin(e.angle) * SPAWNER_SPEED;
    if (sim.fireAt > 0) {
      if (now >= sim.fireAt) {
        sim.fireAt = 0;
        sim.nextAttackAt = now + SPAWNER_PULSE_MS;
        this.hostBirthMites(e, SPAWNER_BROOD_PER_PULSE, now);
      }
    } else if (now >= sim.nextAttackAt && sim.broodCount < SPAWNER_BROOD_CAP) {
      e.telegraphUntil = now + SPAWNER_TELEGRAPH_MS;
      sim.fireAt = e.telegraphUntil;
    }
  }

  /** DREADNOUGHT boss AI: HP-derived 3-phase pattern. Owns its own velocity. */
  private hostSimBoss(
    e: EnemyState,
    sim: EnemySim,
    players: Vec[],
    desired: number,
    now: number,
    dt: number,
  ): void {
    const phase = bossPhase(e.hp, e.maxHp);
    // turret faces nearest
    e.angle = rotateToward(e.angle, desired, 60 * DEG * dt);
    // Centroid of the living crowd (the boss orbits the group, not one ship).
    let cx = 0;
    let cy = 0;
    for (const p of players) {
      cx += p.x;
      cy += p.y;
    }
    if (players.length > 0) {
      cx /= players.length;
      cy /= players.length;
    }
    const dC = Math.hypot(cx - e.x, cy - e.y) || 1;
    const inX = (cx - e.x) / dC;
    const inY = (cy - e.y) / dC;
    if (phase === 1) {
      this.simBossPhase1(e, sim, desired, dC, inX, inY, now);
    } else if (phase === 2) {
      this.simBossPhase2(e, sim, players, inX, inY, now);
    } else {
      this.simBossPhase3(e, sim, now, dt);
    }
  }

  /** Phase 1: orbit at BOSS_ORBIT_RADIUS, broadside a spread fan. */
  private simBossPhase1(
    e: EnemyState,
    sim: EnemySim,
    desired: number,
    dC: number,
    inX: number,
    inY: number,
    now: number,
  ): void {
    const radial = PhaserMath.Clamp((dC - BOSS_ORBIT_RADIUS) / 200, -1, 1);
    const mx = -inY * sim.orbitDir + inX * radial;
    const my = inX * sim.orbitDir + inY * radial;
    const ml = Math.hypot(mx, my) || 1;
    e.vx = (mx / ml) * BOSS_SPEED;
    e.vy = (my / ml) * BOSS_SPEED;
    if (sim.fireAt > 0) {
      if (now >= sim.fireAt) {
        sim.fireAt = 0;
        sim.nextAttackAt = now + BOSS_P1_CYCLE_MS;
        const base = desired - (BOSS_P1_SPREAD_DEG * DEG) / 2;
        const step = (BOSS_P1_SPREAD_DEG * DEG) / (BOSS_P1_SPREAD_COUNT - 1);
        for (let i = 0; i < BOSS_P1_SPREAD_COUNT; i += 1) {
          this.hostSpawnShot(e, base + step * i, BOSS_SHOT_SPEED, now);
        }
      }
    } else if (now >= sim.nextAttackAt) {
      e.telegraphUntil = now + BOSS_P1_TELEGRAPH_MS;
      sim.fireAt = e.telegraphUntil;
    }
  }

  /** Phase 2: strafe faster; lock + fire triple sniper-speed lances at the
   *  nearest players. */
  private simBossPhase2(
    e: EnemyState,
    sim: EnemySim,
    players: Vec[],
    inX: number,
    inY: number,
    now: number,
  ): void {
    e.vx = -inY * BOSS_SPEED * 1.4 * sim.orbitDir;
    e.vy = inX * BOSS_SPEED * 1.4 * sim.orbitDir;
    if (sim.fireAt > 0) {
      if (now >= sim.fireAt) {
        sim.fireAt = 0;
        sim.nextAttackAt = now + BOSS_P2_CYCLE_MS;
        for (const aim of e.lances) {
          this.hostSpawnShot(
            e,
            Math.atan2(aim.y - e.y, aim.x - e.x),
            // distinct speed → BOSS_LANCE damage (70), not sniper 55
            BOSS_LANCE_SHOT_SPEED,
            now,
          );
        }
        e.lances = [];
      }
    } else if (now >= sim.nextAttackAt) {
      e.lances = nearestPlayers(players, e, BOSS_P2_LANCES);
      e.telegraphUntil = now + BOSS_P2_AIM_MS;
      sim.fireAt = e.telegraphUntil;
    }
  }

  /** Phase 3 enrage: plant, vent a radial nova + birth a mite wave. */
  private simBossPhase3(e: EnemyState, sim: EnemySim, now: number, dt: number): void {
    e.vx *= Math.exp(-3 * dt);
    e.vy *= Math.exp(-3 * dt);
    if (sim.fireAt > 0) {
      if (now >= sim.fireAt) {
        sim.fireAt = 0;
        sim.nextAttackAt = now + BOSS_P3_CYCLE_MS;
        for (let i = 0; i < BOSS_P3_NOVA_COUNT; i += 1) {
          this.hostSpawnShot(e, (Math.PI * 2 * i) / BOSS_P3_NOVA_COUNT, BOSS_SHOT_SPEED, now);
        }
        // Cap the brood so a long phase-3 can't balloon enemies[] unbounded.
        if (sim.broodCount < BOSS_BROOD_CAP) {
          this.hostBirthMites(e, BOSS_P3_MITES, now);
        }
      }
    } else if (now >= sim.nextAttackAt) {
      e.telegraphUntil = now + BOSS_P3_TELEGRAPH_MS;
      sim.fireAt = e.telegraphUntil;
    }
  }

  /** SPAWNER / BOSS: birth `n` mites (grace'd drones) around the parent. They
   *  bypass enemyCap like splitter children; broodCount self-caps the spawner. */
  private hostBirthMites(parent: EnemyState, n: number, now: number): void {
    const w = this.scene.world;
    const psim = this.simFor(parent.id);
    if (n > 0) {
      parent.attackAt = now;
    }
    for (let i = 0; i < n; i += 1) {
      const ang = parent.angle + (Math.PI * 2 * i) / Math.max(1, n) + rand() * 0.4;
      const m = spawnEnemyState(
        "drone",
        parent.x + Math.cos(ang) * 18,
        parent.y + Math.sin(ang) * 18,
      );
      m.angle = ang;
      m.vx = Math.cos(ang) * SPLITTER_CHILD_SPEED;
      m.vy = Math.sin(ang) * SPLITTER_CHILD_SPEED;
      m.graceUntil = now + MITE_GRACE_MS;
      const msim = this.simFor(m.id);
      msim.nextAttackAt = m.graceUntil + 400;
      msim.broodParent = parent.id;
      w.enemies.push(m);
      psim.broodCount += 1;
    }
    this.scene.host.dirty.enemies = true;
  }
}
