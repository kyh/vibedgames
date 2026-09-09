// Pure-logic checks: host roster reconciliation, objective/hint state, HUD
// readability helpers and the particle priority pools. No DOM, no renderer.
import assert from "node:assert/strict";
import { test } from "node:test";
import * as THREE from "three";
import type { PlayerMap } from "@vibedgames/multiplayer";
import { ARENA_BOT_FILL } from "../src/data/config.ts";
import { CHAMPIONS } from "../src/data/champions.ts";
import { humanRoster, reconcileHostHeroes, restoreHostState } from "../src/net/host-state.ts";
import { emptyGuestWorld, encodeWorld } from "../src/net/snapshot.ts";
import { castAbility, requestCast } from "../src/sim/abilities.ts";
import { ALL_ABILITY_KEYS } from "../src/sim/types.ts";
import type { Coin } from "../src/sim/types.ts";
import { createWorld, ensureBots, setHeroInput, spawnHero, step } from "../src/sim/world.ts";
import { abilityReadiness, readablePlates } from "../src/render/hud-readability.ts";
import { Hints } from "../src/render/hints.ts";
import { coinObjective, deliveryObjective } from "../src/render/objective-state.ts";
import { ParticlePools } from "../src/render/fx-particles.ts";
import type { ParticleKind, ParticlePriority } from "../src/render/fx-particles.ts";

// ── host state ──

const human = (
  world: ReturnType<typeof createWorld>,
  ownerId: string,
  slot: number,
  champId = "knight",
) =>
  spawnHero(world, {
    champId,
    id: `h-${ownerId}`,
    isBot: false,
    name: ownerId,
    ownerId,
    slot,
    team: ownerId,
  });

const playingFixture = () => {
  const world = createWorld(91);
  const local = human(world, "local", 3, "mage");
  human(world, "peer", 1, "ranger");
  ensureBots(world);
  local.gold = 1700;
  local.hp = 137;
  local.kills = 6;
  local.abilities.Q.readyAt = 67_000;
  world.now = 61_000;
  world.gameTime = 61;
  world.nextCoinAt = 64;
  world.nextDeliveryAt = 76;
  world.campRespawnAt["held"] = 93;
  world.seq = 122;
  return world;
};

test("host promotion adopts the snapshot in place and keeps stepping identically", () => {
  const world = playingFixture();
  for (let i = 0; i < 600; i += 1) {
    step(world);
  }
  const wire = structuredClone(encodeWorld(world));
  const promoted = emptyGuestWorld();
  const { units } = promoted;
  const roster = restoreHostState(promoted, wire);
  assert.equal(promoted.units, units);
  assert.deepEqual(encodeWorld(promoted), wire);
  assert.deepEqual(roster.seats.local, { slot: 3, team: "local" });
  assert.deepEqual(roster.picks.local, { champId: "mage", name: "local" });
  const before = structuredClone(wire);
  for (let i = 0; i < 60; i += 1) {
    step(world);
    step(promoted);
  }
  assert.deepEqual(encodeWorld(promoted), encodeWorld(world));
  assert.deepEqual(wire, before);
});

test("empty room seeds once; an ended empty roster stays ended", () => {
  const world = emptyGuestWorld();
  restoreHostState(world, null);
  assert.deepEqual(encodeWorld(world), encodeWorld(createWorld(0xba_da_55)));
  world.phase = "ended";
  world.winner = "h-departed";
  world.gameTime = 950;
  world.units.clear();
  const terminal = structuredClone(encodeWorld(world));
  const target = emptyGuestWorld();
  assert.deepEqual(restoreHostState(target, terminal), { picks: {}, seats: {} });
  assert.deepEqual(encodeWorld(target), terminal);
});

test("late humans replace one bot seat; grace humans keep their hero and go neutral", () => {
  const world = playingFixture();
  const roster = humanRoster(world);
  const players: PlayerMap = {
    local: { connected: true, id: "local" },
    newcomer: { connected: true, id: "newcomer" },
    peer: { connected: false, id: "peer" },
  };
  const grace = world.units.get("h-peer");
  assert.ok(grace);
  setHeroInput(grace, 1, 0, 0, 1, true);
  roster.picks.newcomer = { champId: "witch", name: "New" };
  reconcileHostHeroes(world, players, roster.picks, roster.seats);
  assert.equal(world.units.get("h-newcomer")?.slot, 0);
  assert.equal(world.units.get("h-newcomer")?.champId, "witch");
  assert.equal(world.units.has("bot:0"), false);
  assert.equal(world.units.get("h-peer"), grace);
  assert.equal(grace.slot, 1);
  assert.equal(grace.moveX, 0);
  assert.equal(grace.attackHeld, false);
  const heroes = [...world.units.values()].filter((u) => u.kind === "hero");
  assert.equal(heroes.length, ARENA_BOT_FILL);
  assert.equal(new Set(heroes.map((u) => u.slot)).size, heroes.length);
  const unaffected = world.units.get("bot:2");
  delete players.newcomer;
  reconcileHostHeroes(world, players, roster.picks, roster.seats);
  assert.equal(world.units.has("h-newcomer"), false);
  assert.equal(world.units.get("bot:2"), unaffected);
  assert.equal(world.units.has("bot:0"), true);
  world.phase = "ended";
  const terminal = structuredClone(encodeWorld(world));
  reconcileHostHeroes(world, {}, {}, {});
  assert.deepEqual(encodeWorld(world), terminal);
});

// ── objectives + hints ──

const soloFixture = () => {
  const world = createWorld(724);
  const me = spawnHero(world, {
    champId: "knight",
    id: "local",
    isBot: false,
    name: "Player",
    ownerId: "local",
    slot: 0,
    team: "local",
  });
  return { me, world };
};
const coin = (id: string, x = 0): Coin => ({
  expireAt: 9900,
  fromX: 0,
  fromY: 0,
  gold: 300,
  id,
  landAt: 900,
  x,
  y: 0,
});

test("loot never becomes the boss objective; landing and expiry follow the sim clock", () => {
  const { world, me } = soloFixture();
  world.coins.push({ ...coin("loot"), loot: true });
  assert.equal(coinObjective(world, me).target, null);
  assert.equal(coinObjective(world, me).text, "◈ COIN 8s");
  world.coins.push(coin("boss", 5));
  assert.equal(coinObjective(world, me).text, "◈ COIN LANDING 1s");
  assert.equal(coinObjective(world, me).live, false);
  world.now = 900;
  assert.equal(coinObjective(world, me).text, "◈ COIN 9s LEFT");
  assert.equal(coinObjective(world, me).live, true);
  world.now = 9900;
  assert.equal(coinObjective(world, me).target, null);
});

test("nearest objective stays retained until removed; snapshot order cannot flip it", () => {
  const { world, me } = soloFixture();
  me.y = 0;
  me.x = 0;
  const close = coin("a", 2);
  const far = coin("b", 8);
  world.coins = [far, close];
  assert.equal(coinObjective(world, me).target?.id, "a");
  assert.equal(coinObjective(world, me, "b").target?.id, "b");
  world.coins.reverse();
  assert.equal(coinObjective(world, me, "b").target?.id, "b");
  world.coins = [close];
  assert.equal(coinObjective(world, me, "b").target?.id, "a");
});

test("full belt explains delivery gold; expired and claimed drops lose their target", () => {
  const { world, me } = soloFixture();
  world.deliveries.push({ expireAt: 30_000, id: "drop", x: 0, y: 0 });
  assert.equal(deliveryObjective(world, me).text, "▣ ITEM 30s LEFT");
  me.items = ["one", "two", "three", "four", "five", "six"];
  assert.equal(deliveryObjective(world, me).text, "▣ GOLD 30s LEFT");
  world.now = 30_000;
  assert.equal(deliveryObjective(world, me).target, null);
  world.deliveries = [];
  assert.equal(deliveryObjective(world, me).target, null);
});

test("creep loot does not retire the first boss-coin lesson; rematch keeps it learned", () => {
  const { world, me } = soloFixture();
  me.y = 100;
  me.x = 100;
  me.gold = 0;
  me.lastCastAt = 1;
  me.lastAttackAt = 1;
  const messages: string[] = [];
  const hints = new Hints(
    () => false,
    (message) => messages.push(message),
  );
  hints.update(world, me);
  me.x += 6;
  world.gameTime = 1;
  world.now = 1000;
  world.coins = [{ ...coin("loot"), loot: true }];
  hints.update(world, me);
  assert.equal(
    messages.some((message) => message.includes("Golem")),
    false,
  );
  world.gameTime = 8.1;
  world.now = 8100;
  world.coins = [{ ...coin("boss"), expireAt: 17_900, landAt: 8900 }];
  hints.update(world, me);
  assert.equal(messages.filter((message) => message.includes("Golem")).length, 1);
  world.coins = [];
  hints.update(world, me);
  assert.equal(messages.at(-1), "");
  world.gameTime = 20;
  world.now = 20_000;
  world.coins = [{ ...coin("boss2"), expireAt: 29_900, landAt: 20_900 }];
  hints.update(world, me);
  assert.equal(messages.filter((message) => message.includes("Golem")).length, 1);
  hints.resetMatch();
  world.gameTime = 8.1;
  world.now = 8100;
  hints.update(world, me);
  assert.equal(messages.filter((message) => message.includes("Golem")).length, 1);
});

test("observing the economy never alters coin schedules or payouts", () => {
  const observed = soloFixture();
  const control = soloFixture();
  const hints = new Hints(
    () => false,
    () => {
      /* empty */
    },
  );
  let lastCoin: string | null = null;
  for (let i = 0; i < 1200; i += 1) {
    step(observed.world);
    step(control.world);
    lastCoin = coinObjective(observed.world, observed.me, lastCoin).target?.id ?? null;
    deliveryObjective(observed.world, observed.me);
    hints.update(observed.world, observed.me);
    assert.deepEqual(encodeWorld(observed.world), encodeWorld(control.world));
  }
});

// ── HUD readability ──

const duel = (champId = "knight") => {
  const world = createWorld(41);
  world.units.clear();
  world.now = 5000;
  const me = spawnHero(world, {
    champId,
    id: "local",
    isBot: false,
    name: "Local",
    ownerId: "local",
    slot: 0,
    team: "local",
  });
  const enemy = spawnHero(world, {
    champId: "knight",
    id: "enemy",
    isBot: false,
    name: "Enemy",
    ownerId: "enemy",
    slot: 1,
    team: "enemy",
  });
  Object.assign(me, { aimX: 1, aimY: 0, facing: 0, x: 0, y: 16 });
  Object.assign(enemy, { x: 2, y: 16 });
  return { me, world };
};

test("all six kits: HUD availability agrees with the sim's cast admission gates", () => {
  for (const champion of CHAMPIONS) {
    for (const key of ALL_ABILITY_KEYS) {
      for (const gate of [
        "ready",
        "dead",
        "locked",
        "cooldown",
        "stun",
        "silence",
        "hex",
        "root",
      ]) {
        const { world, me } = duel(champion.id);
        me.abilities[key].rank = gate === "locked" ? 0 : 1;
        me.abilities[key].readyAt = world.now + (gate === "cooldown" ? 1 : 0);
        me.alive = gate !== "dead";
        if (["stun", "silence", "hex", "root"].includes(gate)) {
          me.statuses.push({ id: "gate", kind: gate, until: world.now + 1000 });
        }
        const before = structuredClone(me);
        const readiness = abilityReadiness(me, key, world.now);
        assert.deepEqual(me, before, "presentation cannot consume casts or queued input");
        const accepted = castAbility(world, me, key, { dir: { x: 1, y: 0 } });
        assert.equal(readiness.kind === "available", accepted, `${champion.id}/${key}/${gate}`);
      }
    }
  }
});

test("queued overlay follows requestCast admission and the inclusive buffer deadline", () => {
  const { world, me } = duel();
  me.abilities.Q.rank = 1;
  me.abilities.Q.readyAt = world.now + 200;
  assert.equal(requestCast(world, me, "Q", {}), false);
  assert.equal(abilityReadiness(me, "Q", world.now).queued, true);
  assert.equal(abilityReadiness(me, "W", world.now).queued, false);
  assert.equal(abilityReadiness(me, "Q", world.now + 300).queued, true);
  assert.equal(abilityReadiness(me, "Q", world.now + 301).queued, false);
  me.alive = false;
  assert.deepEqual(abilityReadiness(me, "Q", world.now), {
    kind: "blocked",
    label: "DEAD",
    queued: false,
  });
});

test("plate placement is iteration-independent, prioritizes local, never moves anchors", () => {
  const local = { compact: false, distance: 0, id: "local", priority: 0, x: 320, y: 240 };
  const overlap = { compact: false, distance: 4, id: "near", priority: 1, x: 323, y: 242 };
  const far = { compact: true, distance: 30, id: "far", priority: 2, x: 410, y: 242 };
  const behindHud = { compact: false, distance: 8, id: "hud", priority: 1, x: 600, y: 600 };
  const candidates = [overlap, far, behindHud, local];
  const before = structuredClone(candidates);
  const keepOut = [{ bottom: 700, left: 500, right: 700, top: 570 }];
  assert.deepEqual(readablePlates(candidates, keepOut), [local, far]);
  assert.deepEqual(readablePlates(candidates.toReversed(), keepOut), [local, far]);
  assert.deepEqual(candidates, before);
  assert.equal(readablePlates(candidates, keepOut)[0], local, "uses original anchor record");
});

// ── particle priority pools ──

const meshFor = (scene: THREE.Scene, kind: ParticleKind): THREE.InstancedMesh => {
  const mesh = scene.children.find(
    (child): child is THREE.InstancedMesh =>
      child instanceof THREE.InstancedMesh && child.renderOrder === (kind === "add" ? 11 : 10),
  );
  if (!mesh) {
    throw new Error("particle mesh missing");
  }
  return mesh;
};

const visiblePositions = (mesh: THREE.InstancedMesh): number[] => {
  const matrix = new THREE.Matrix4();
  const xs: number[] = [];
  for (let i = 0; i < mesh.count; i += 1) {
    mesh.getMatrixAt(i, matrix);
    if (matrix.determinant() > 0) {
      xs.push(matrix.elements[12] ?? 0);
    }
  }
  return xs;
};

for (const { kind, cap, reserve } of [
  { cap: 512, kind: "add", reserve: 96 },
  { cap: 160, kind: "normal", reserve: 32 },
] satisfies { kind: ParticleKind; cap: number; reserve: number }[]) {
  test(`${kind} pool: reserve, replace in place, expire and refill without duplicate slots`, () => {
    const scene = new THREE.Scene();
    const pools = new ParticlePools(scene);
    const spawn = (n: number, priority: ParticlePriority, x: number) => {
      for (let i = 0; i < n; i += 1) {
        pools.spawn(kind, { life: 1, priority, size: 1, x, y: 1, z: 0 });
      }
    };
    spawn(cap * 2, "ambient", 1);
    assert.equal(pools.counts()[kind].active, cap - reserve);
    spawn(reserve, "impact", 2);
    assert.equal(pools.counts()[kind].active, cap);
    spawn(23, "major", 3);
    assert.deepEqual(pools.counts()[kind], {
      active: cap,
      ambient: cap - reserve - 23,
      capacity: cap,
      impact: reserve,
      major: 23,
    });
    const mesh = meshFor(scene, kind);
    assert.equal(visiblePositions(mesh).filter((x) => x === 3).length, 23);
    spawn(cap, "ambient", 4);
    assert.equal(pools.counts()[kind].major, 23);
    for (let cycle = 0; cycle < 4; cycle += 1) {
      pools.update(2);
      assert.equal(pools.counts()[kind].active, 0);
      assert.equal(visiblePositions(mesh).length, 0);
      for (let i = 0; i < cap; i += 1) {
        pools.spawn(kind, { life: 1, priority: "impact", size: 1, x: i + 100, y: 0, z: 0 });
      }
      assert.equal(pools.counts()[kind].active, cap);
      assert.equal(new Set(visiblePositions(mesh)).size, cap);
      spawn(31, "major", -1);
      assert.equal(pools.counts()[kind].active, cap);
      assert.equal(visiblePositions(mesh).filter((x) => x === -1).length, 31);
    }
    pools.dispose();
    assert.equal(scene.children.length, 0);
  });
}

test("equal-priority saturation keeps the active major particles", () => {
  const scene = new THREE.Scene();
  const pools = new ParticlePools(scene);
  for (let i = 0; i < 512; i += 1) {
    pools.spawn("add", { life: 2, priority: "major", size: 1, x: i, y: 0, z: 0 });
  }
  pools.spawn("add", { life: 2, priority: "major", size: 1, x: 9999, y: 0, z: 0 });
  assert.equal(pools.counts().add.major, 512);
  assert.equal(visiblePositions(meshFor(scene, "add")).includes(9999), false);
  pools.dispose();
});

test("burst scratch resets priority between calls", () => {
  const pools = new ParticlePools(new THREE.Scene());
  const burst = { color: 0xff_ff_ff, life: 1, speed: 1, x: 0, y: 0, z: 0 };
  pools.burst("add", 3, { ...burst, priority: "major" });
  pools.burst("add", 4, { ...burst, priority: "ambient" });
  pools.burst("add", 5, burst);
  assert.deepEqual(pools.counts().add, {
    active: 12,
    ambient: 4,
    capacity: 512,
    impact: 5,
    major: 3,
  });
  pools.dispose();
});
