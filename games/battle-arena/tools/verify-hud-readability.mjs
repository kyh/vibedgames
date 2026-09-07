import assert from "node:assert/strict";
import { test } from "node:test";
import { CHAMPIONS } from "../src/data/champions.ts";
import { ITEMS, MAX_ITEMS } from "../src/data/items.ts";
import { ALL_ABILITY_KEYS } from "../src/sim/types.ts";
import { createWorld, spawnHero } from "../src/sim/world.ts";
import { castAbility, requestCast } from "../src/sim/abilities.ts";
import { abilityReadiness, readablePlates } from "../src/render/hud-readability.ts";

function duel(champId = "knight") {
  const world = createWorld(41);
  world.units.clear();
  world.now = 5000;
  const me = spawnHero(world, {
    id: "local",
    ownerId: "local",
    team: "local",
    champId,
    name: "Local",
    slot: 0,
    isBot: false,
  });
  const enemy = spawnHero(world, {
    id: "enemy",
    ownerId: "enemy",
    team: "enemy",
    champId: "knight",
    name: "Enemy",
    slot: 1,
    isBot: false,
  });
  Object.assign(me, { x: 0, y: 16, aimX: 1, aimY: 0, facing: 0 });
  Object.assign(enemy, { x: 2, y: 16 });
  return { world, me, enemy };
}

test("all six kits: HUD availability agrees with actual cast admission gates", () => {
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
        if (["stun", "silence", "hex", "root"].includes(gate))
          me.statuses.push({ kind: gate, id: "gate", until: world.now + 1000 });
        const before = structuredClone(me);
        const readiness = abilityReadiness(me, key, world.now);
        assert.deepEqual(me, before, "presentation cannot consume casts or queued input");
        const accepted = castAbility(world, me, key, { dir: { x: 1, y: 0 } });
        assert.equal(readiness.kind === "available", accepted, `${champion.id}/${key}/${gate}`);
      }
    }
  }
});

test("queued overlay follows actual requestCast admission and original inclusive deadline", () => {
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

test("crowded plate placement is iteration-independent, prioritizes local, and never displaces anchors", () => {
  const local = { id: "local", x: 320, y: 240, priority: 0, distance: 0, compact: false };
  const overlap = { id: "near", x: 323, y: 242, priority: 1, distance: 4, compact: false };
  const far = { id: "far", x: 410, y: 242, priority: 2, distance: 30, compact: true };
  const behindHud = { id: "hud", x: 600, y: 600, priority: 1, distance: 8, compact: false };
  const candidates = [overlap, far, behindHud, local];
  const before = structuredClone(candidates);
  const keepOut = [{ left: 500, top: 570, right: 700, bottom: 700 }];
  assert.deepEqual(readablePlates(candidates, keepOut), [local, far]);
  assert.deepEqual(readablePlates(candidates.toReversed(), keepOut), [local, far]);
  assert.deepEqual(candidates, before);
  assert.equal(readablePlates(candidates, keepOut)[0], local, "uses original anchor record");
});

function element() {
  const classes = new Set();
  return {
    hidden: false,
    textContent: "",
    innerHTML: "",
    className: "",
    offsetWidth: 10,
    children: [],
    style: {
      setProperty(key, value) {
        this[key] = value;
      },
    },
    append(...nodes) {
      this.children.push(...nodes);
    },
    appendChild(node) {
      this.children.push(node);
    },
    remove() {
      this.removed = true;
    },
    classList: {
      contains: (name) => classes.has(name),
      add: (...names) => names.forEach((name) => classes.add(name)),
      remove: (...names) => names.forEach((name) => classes.delete(name)),
      toggle(name, on) {
        if (on ?? !classes.has(name)) classes.add(name);
        else classes.delete(name);
      },
    },
  };
}
const plateRoot = element();
Object.assign(globalThis, {
  window: { matchMedia: () => ({ matches: false }), innerWidth: 1280, innerHeight: 720 },
  document: {
    body: element(),
    hidden: false,
    createElement: () => element(),
    getElementById: (id) => (id === "ba-plates" ? plateRoot : null),
  },
});
const { Hud } = await import("../src/render/hud.ts");

test("actual HUD labels queued/blocked states without false ready cues; world remains untouched", () => {
  const { world, me } = duel();
  const cues = [];
  const hud = Object.assign(Object.create(Hud.prototype), {
    abilityEls: new Map(
      ALL_ABILITY_KEYS.map((key) => [
        key,
        {
          wrap: element(),
          img: element(),
          pips: element(),
          cdText: element(),
          lastRank: -1,
          lastCd: -1,
          lastText: "",
          wasOnCd: false,
        },
      ]),
    ),
    champBound: me.champId,
    presentationPaused: false,
    presentationHidden: false,
    lastReadySoundAt: 0,
    fx: { audio: { abilityReady: () => cues.push("ready") } },
  });
  me.abilities.Q.rank = 1;
  me.abilities.Q.readyAt = world.now + 200;
  hud.updateAbilities(world, me);
  requestCast(world, me, "Q", {});
  hud.updateAbilities(world, me);
  const q = hud.abilityEls.get("Q");
  assert.equal(q.cdText.textContent, "QUEUED\n0.2");
  me.queuedCast = null;
  me.statuses.push({ kind: "silence", id: "silence", until: world.now + 2000 });
  world.now += 200;
  const before = structuredClone(me);
  hud.updateAbilities(world, me);
  assert.equal(q.cdText.textContent, "SILENCE");
  assert.equal(q.wrap.classList.contains("blocked"), true);
  assert.deepEqual(cues, []);
  assert.deepEqual(me, before);
  me.statuses = [];
  hud.updateAbilities(world, me);
  assert.equal(q.cdText.textContent, "");
  assert.deepEqual(cues, [], "status removal does not replay an old cooldown edge");
  me.abilities.Q.readyAt = world.now + 100;
  hud.updateAbilities(world, me);
  world.now += 100;
  hud.updateAbilities(world, me);
  assert.deepEqual(cues, ["ready"], "a fresh legal cooldown edge still announces once");
});

test("actual belt hides vacant slots while retaining socket identity and original item keys", () => {
  const { world, me } = duel();
  const sockets = Array.from({ length: MAX_ITEMS }, () => ({
    chip: element(),
    img: element(),
    cd: element(),
  }));
  const hud = Object.assign(Object.create(Hud.prototype), {
    itemSockets: sockets,
    itemSig: "",
    shopOpen: false,
  });
  hud.updateItems(world, me);
  assert.ok(sockets.every((socket) => socket.chip.hidden));
  me.items = [ITEMS[0].id, ITEMS[1].id];
  hud.updateItems(world, me);
  assert.deepEqual(
    sockets.map((socket) => socket.chip.hidden),
    [false, false, true, true, true, true],
  );
  hud.shopOpen = true;
  hud.updateItems(world, me);
  assert.ok(sockets.every((socket) => !socket.chip.hidden));
  assert.equal(hud.itemSockets, sockets);
  assert.deepEqual(me.items, [ITEMS[0].id, ITEMS[1].id]);
});

test("actual objective text and arrows retain the same boss coin; ordinary loot cannot become an objective", () => {
  const { world, me } = duel();
  const arrowCalls = [];
  const hud = Object.assign(Object.create(Hud.prototype), {
    lastMe: me,
    coinState: null,
    deliveryState: null,
    timerEl: element(),
    goalEl: element(),
    objCoinEl: element(),
    objDropEl: element(),
    arrowCoin: "coin",
    arrowDelivery: "drop",
    placeArrow: (...args) => arrowCalls.push(args),
  });
  world.coins = [
    { id: "loot", x: 0, y: 16, loot: true, landAt: 0, expireAt: 15000 },
    { id: "boss", x: 4, y: 16, landAt: 6000, expireAt: 15000 },
  ];
  hud.updateTop(world);
  hud.updateArrows();
  assert.equal(hud.objCoinEl.textContent, "◈ COIN LANDING 1s");
  assert.deepEqual(arrowCalls[0], ["coin", 4, 16]);
  world.coins.push({ id: "closer", x: 1, y: 16, landAt: 0, expireAt: 12000 });
  world.now = 6000;
  hud.updateTop(world);
  hud.updateArrows();
  assert.equal(hud.coinState.target.id, "boss");
  assert.equal(hud.objCoinEl.textContent, "◈ COIN 9s LEFT");
  world.deliveries = [{ id: "drop", x: 8, y: 16, expireAt: 11000 }];
  me.items = ITEMS.slice(0, MAX_ITEMS).map((item) => item.id);
  hud.updateTop(world);
  hud.updateArrows();
  assert.equal(hud.objDropEl.textContent, "▣ GOLD 5s LEFT");
  assert.deepEqual(arrowCalls.at(-1), ["drop", 8, 16]);
  world.now = 16000;
  hud.updateTop(world);
  hud.updateArrows();
  assert.equal(hud.coinState.target, null);
  assert.equal(hud.deliveryState.target, null);
  assert.deepEqual(arrowCalls.at(-2), ["coin", undefined, undefined]);
});

test("actual plates project render-owned height/root and cull stale, stealth and crowded labels", () => {
  const { world, me, enemy } = duel();
  const projections = [];
  const hud = Object.assign(Object.create(Hud.prototype), {
    plates: new Map(),
    plateKeepOutAt: Infinity,
    plateKeepOut: [],
    plateAnchors: (id) => ({ x: id === me.id ? 11 : 12, y: 7, z: 19 }),
    view: {
      worldToScreen: (...point) => {
        projections.push(point);
        return { x: 640, y: 300, visible: true };
      },
    },
  });
  const before = structuredClone(me);
  hud.updatePlates(world, me);
  assert.deepEqual(projections[0], [11, 19, 7]);
  assert.deepEqual(me, before);
  assert.equal(hud.plates.get(me.id).wrap.style.display, "block");
  assert.equal(hud.plates.get(enemy.id).wrap.style.display, "none");
  const enemyWrap = hud.plates.get(enemy.id).wrap;
  enemy.statuses.push({ kind: "stealth", id: "stealth", until: 9000 });
  hud.updatePlates(world, me);
  assert.equal(hud.plates.has(enemy.id), false);
  assert.equal(enemyWrap.removed, true);
  hud.plateKeepOut = [{ left: 560, top: 250, right: 700, bottom: 330 }];
  hud.updatePlates(world, me);
  assert.equal(
    hud.plates.get(me.id).wrap.style.display,
    "none",
    "actual HUD rectangles win over labels",
  );
});
