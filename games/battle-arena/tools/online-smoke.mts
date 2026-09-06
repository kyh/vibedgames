import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";
import { stripTypeScriptTypes } from "node:module";
import type { PlayerMap } from "@vibedgames/multiplayer";
import { humanRoster, reconcileHostHeroes, restoreHostState } from "../src/net/host-state.ts";
import { applySnapshot, emptyGuestWorld, encodeWorld, isSnapshot } from "../src/net/snapshot.ts";
import {
  createWorld,
  ensureBots,
  spawnHero,
  step,
  setHeroInput,
  buyItem,
  tryJump,
} from "../src/sim/world.ts";
import { requestCast, useItemActive } from "../src/sim/abilities.ts";
import { ALL_ABILITY_KEYS } from "../src/sim/types.ts";
import {
  ARENA_BOT_FILL,
  KILL_GOAL_FFA,
  SHOP_RADIUS,
  SIM_DT,
  SNAPSHOT_HZ,
} from "../src/data/config.ts";
import { CHAMP_BY_ID, DEFAULT_CHAMP, valAt } from "../src/data/champions.ts";
import { HALF, SPAWNS, isInThrone } from "../src/data/map.ts";
import { terrainHeight } from "../src/data/terrain.ts";
import { isJsonObject, isJsonNumber, isJsonString, type JsonObject } from "../src/data/json.ts";

function human(
  world: ReturnType<typeof createWorld>,
  ownerId: string,
  slot: number,
  champId = "knight",
) {
  return spawnHero(world, {
    id: `h-${ownerId}`,
    ownerId,
    team: ownerId,
    champId,
    name: ownerId,
    isBot: false,
    slot,
  });
}

function playingFixture() {
  const world = createWorld(91);
  const local = human(world, "local", 3, "mage");
  human(world, "peer", 1, "ranger");
  ensureBots(world);
  local.gold = 1700;
  local.hp = 137;
  local.kills = 6;
  local.abilities.Q.readyAt = 67000;
  world.now = 61000;
  world.gameTime = 61;
  world.nextCoinAt = 64;
  world.nextDeliveryAt = 76;
  world.campRespawnAt["held"] = 93;
  world.seq = 122;
  return world;
}

test("snapshot adoption retains world/maps and all combat/economy state; never aliases accepted cache", () => {
  const world = playingFixture();
  // Running the unchanged sim supplies real projectiles/strikes/coins/deliveries.
  for (let i = 0; i < 600; i++) step(world);
  const wire = structuredClone(encodeWorld(world));
  const promoted = emptyGuestWorld();
  const units = promoted.units;
  const projectiles = promoted.projectiles;
  const roster = restoreHostState(promoted, wire);
  assert.equal(promoted.units, units);
  assert.equal(promoted.projectiles, projectiles);
  assert.deepEqual(encodeWorld(promoted), wire);
  assert.deepEqual(roster.seats.local, { slot: 3, team: "local" });
  assert.deepEqual(roster.picks.local, { champId: "mage", name: "local" });
  const before = structuredClone(wire);
  for (let i = 0; i < 60; i++) {
    step(world);
    step(promoted);
  }
  assert.deepEqual(encodeWorld(promoted), encodeWorld(world));
  assert.deepEqual(wire, before);
});

test("empty room seeds once; an ended empty roster stays ended with winner and clock", () => {
  const world = emptyGuestWorld();
  restoreHostState(world, null);
  assert.deepEqual(encodeWorld(world), encodeWorld(createWorld(0xbada55)));
  world.phase = "ended";
  world.winner = "h-departed";
  world.gameTime = 950;
  world.units.clear();
  const terminal = structuredClone(encodeWorld(world));
  const target = emptyGuestWorld();
  assert.deepEqual(restoreHostState(target, terminal), { picks: {}, seats: {} });
  assert.deepEqual(encodeWorld(target), terminal);
});

test("late humans replace the specific bot seat, preserving grace humans, teams and all unique slots", () => {
  const world = playingFixture();
  const roster = humanRoster(world);
  const players: PlayerMap = {
    local: { id: "local", connected: true },
    peer: { id: "peer", connected: false },
    newcomer: { id: "newcomer", connected: true },
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

// Execute actual scene/keyboard/touch/pad source with DOM/render/transport
// adapters only. No duplicate authority implementation and no WebGL required.
function compiled(relative: string): string {
  const path = new URL(relative, import.meta.url);
  const source = readFileSync(path, "utf8").replace(/^import[\s\S]*?from "[^"]+";$/gm, "");
  return stripTypeScriptTypes(source, { mode: "transform" })
    .replace(/^export (class|function|const) /gm, "$1 ")
    .replace(/^export \{\};?$/gm, "");
}
const source = [
  compiled("../../../packages/gamepad/src/physical.ts"),
  compiled("../src/input/controls.ts"),
  compiled("../src/input/touch.ts"),
  compiled("../src/scenes/game-scene.ts"),
].join("\n");

function sceneHarness(host = true, ended = false) {
  const world = playingFixture();
  if (ended) {
    world.phase = "ended";
    world.winner = "h-peer";
  }
  const wire = structuredClone(encodeWorld(world));
  const context = vm.createContext({
    structuredClone,
    console,
    performance: { now: () => 1000 },
    humanRoster,
    reconcileHostHeroes,
    restoreHostState,
    applySnapshot,
    emptyGuestWorld,
    encodeWorld,
    isSnapshot,
    createWorld,
    ensureBots,
    spawnHero,
    step,
    setHeroInput,
    buyItem,
    tryJump,
    requestCast,
    useItemActive,
    ALL_ABILITY_KEYS,
    ARENA_BOT_FILL,
    KILL_GOAL_FFA,
    SHOP_RADIUS,
    SIM_DT,
    SNAPSHOT_HZ,
    CHAMP_BY_ID,
    DEFAULT_CHAMP,
    valAt,
    HALF,
    SPAWNS,
    isInThrone,
    terrainHeight,
    isJsonObject,
    isJsonNumber,
    isJsonString,
    wire,
    host,
  });
  vm.runInContext(
    `
    const INTENT_EVENT='intent', MULTIPLAYER_HOST='', PARTY='';
    class Element {
      style={setProperty(){}}; children=[]; listeners=new Map();
      classList={add(){},remove(){},toggle(){},contains(){return false}};
      append(...v){this.children.push(...v)} appendChild(v){this.children.push(v)}
      addEventListener(k,f){const a=this.listeners.get(k)||[];a.push(f);this.listeners.set(k,a)}
      removeEventListener(){} remove(){} closest(){return null} requestPointerLock(){}
    }
    const document={body:new Element(),head:new Element(),createElement(){return new Element()},pointerLockElement:null,exitPointerLock(){}};
    const window=new Element();window.innerWidth=1200;window.innerHeight=800;window.matchMedia=()=>({matches:false});
    const navigator={getGamepads:()=>pads}; let pads=[];
    const abilityIcon=()=>'';
    class MultiplayerClient {
      connectionStatus='connecting';playerId=null;hostId=null;players={};sharedState={};sent=[];writes=[];listeners=[];
      constructor(opts){this.onEvent=opts.onEvent}
      get isHost(){return this.hostId!==null&&this.hostId===this.playerId}
      subscribe(f){this.listeners.push(f);return()=>{}}
      notify(){for(const f of this.listeners)f()}
      sendEvent(e,p){this.sent.push([e,p])}
      updateSharedState(s){this.sharedState={...this.sharedState,...s};this.writes.push(structuredClone(s));this.notify()}
      destroy(){}
    }
    class WorldView {resets=0;setupBoss(){} resetCharacters(){this.resets++} sync(){}}
    class Environment {setup(){} setLocalPos(){}setHomeSlot(){}update(){}}
    class Fx {
      resets=0; bestStreak=0;lastDeath=null;
      audio={begins:0,beginMatch(){this.begins++},suspend(){},resume(){},setListener(){},diagnostics(){return {}}};
      warm(){} resetMatch(){this.resets++} scaleNow(){return 1} update(w){w.fx.length=0}
    }
    class Hud {
      isShopOpen=false;unassigned=0;paused=false;items=[];resets=0;
      resetMatch(w,me){this.resets++;this.resetNow=w.now;this.resetPlayer=me?.id}
      consumeItemTaps(){const a=this.items;this.items=[];return a}
      setPaused(v){this.paused=v} updateUnassigned(){this.unassigned++}update(){}showHint(){}
      toggleShop(){this.isShopOpen=!this.isShopOpen}
    }
    class Hints {resets=0;resetMatch(){this.resets++}update(){}notifyShopOpened(){}}
    ${source}
    const view={scene:{},renderer:{},camera:{},refreshShadows(){},startIntro(){},samplePerf(){},follow(){},tickAura(){},render(){}};
    const controls=new Controls(new Element());const touch=new TouchControls();
    const h=new GameScene(view,{},controls,{online:true,room:'fixture',name:'local',champId:'mage'},touch);
    h.driveIntro=()=>{};h.driveMusic=()=>{};h.feedTouchCooldowns=()=>{};
    h.net.connectionStatus='connected';h.net.playerId='local';h.net.hostId=host?'local':'peer';
    h.net.players={local:{id:'local',connected:true},peer:{id:'peer',connected:true}};
    h.net.sharedState={snap:wire,fx:[],fxSeq:19,matchGeneration:4};h.net.notify();
  `,
    context,
  );
  const run = (code: string): void => {
    vm.runInContext(code, context);
  };
  const equal = (code: string, expected: boolean | number | string | undefined): void => {
    assert.equal(vm.runInContext(code, context), expected);
  };
  const event = (payload: JsonObject, from = "peer") => {
    Object.assign(context, { payload, from });
    run("h.onNetEvent('intent',payload,from)");
  };
  return { context, run, equal, event, wire };
}

test("actual scene: election/adoption precede remote/local commands and direct purchases", () => {
  const { run, equal, event, wire } = sceneHarness();
  event({ kind: "input", mx: 1, my: 0, ax: 0, ay: 1, attack: true });
  equal("h.hostReady", true);
  equal("h.world.units.get('h-peer').moveX", 1);
  equal("h.world.units.get('h-local').gold", 1700);
  assert.equal(wire.units["h-peer"]?.moveX, 0);
  // Purchase is a separate DOM callback: it must adopt before reading its hero.
  run(
    "h.net.connectionStatus='disconnected';h.net.notify();h.world.units.get('h-local').gold=0;h.requestBuy('boots')",
  );
  equal("h.world.units.get('h-local').gold", 0);
  run("h.net.connectionStatus='connected';h.net.notify();h.requestBuy('boots')");
  equal("h.world.units.get('h-local').gold", 1250);
  equal("h.world.units.get('h-local').items.includes('boots')", true);
  assert.equal(wire.units["h-local"]?.gold, 1700);
});

test("actual scene: guests never step/write, promotion baselines inherited FX, own batches never replay", () => {
  const { run, equal } = sceneHarness(false);
  run("h.tickOnline(1);h.world.fx.length=0");
  equal("h.world.gameTime", 61);
  equal("h.net.writes.length", 0);
  run(
    "h.net.sharedState.fx=[{t:'count',n:1}];h.world.fx.push({t:'count',n:2});h.netFx.push({t:'count',n:3});h.net.hostId='local';h.net.notify();h.prepareOnline()",
  );
  equal("h.world.fx.length+h.netFx.length", 0);
  equal("h.fxSeqOut", 19);
  run("h.world.fx.push({t:'count',n:4});h.tickOnline(1/SNAPSHOT_HZ);h.world.fx.length=0");
  equal("h.net.writes[0].fxSeq", 20);
  equal("h.net.writes[0].fx.filter(e=>e.t==='count').length", 1);
  run(
    "h.net.connectionStatus='disconnected';h.net.notify();h.net.connectionStatus='connected';h.net.notify();h.prepareOnline()",
  );
  equal("h.world.fx.length", 0);
  equal("h.worldView.resets", 0);
  equal("h.hud.resets+h.hints.resets", 0);
  run("h.net.hostId='peer';h.net.notify();h.tickOnline(0)");
  equal("h.world.fx.length", 0);
  equal("h.amHost", false);
});

test("actual scene: every terminal intent/reconciliation/step is silent; unassigned result remains reachable", () => {
  const { run, equal, event, wire } = sceneHarness(true, true);
  run("h.prepareOnline()");
  for (const payload of [
    { kind: "input", mx: 1, my: 1, attack: true },
    { kind: "cast", key: "Q", px: 0, py: 0 },
    { kind: "buy", itemId: "boots" },
    { kind: "useItem", slot: 0, px: 0, py: 0 },
    { kind: "jump" },
  ])
    event(payload);
  run("h.requestBuy('boots');h.tickOnline(2);h.net=null;h.introTime=4;h.tickLocal(2)");
  equal("JSON.stringify(encodeWorld(h.world))", JSON.stringify(wire));
  const spectator = sceneHarness(true, true);
  spectator.run("delete h.net.sharedState.snap.units['h-local'];h.update(0.03)");
  spectator.equal("h.hud.unassigned", 1);
  spectator.equal("h.statusEl.textContent", "");
  spectator.equal("controls.inMouseMode", true);
});

test("actual scene: only connected elected host rematches, restoring picks/seats and resetting once per generation", () => {
  const { run, equal, event } = sceneHarness(true, true);
  run("h.prepareOnline();h.net.players.late={id:'late',connected:true}");
  event({ kind: "join", champId: "witch", name: "Late" }, "late");
  equal("h.world.units.has('h-late')", false);
  run("h.rematch()");
  equal("h.world.phase", "playing");
  equal("h.world.gameTime", 0);
  equal("h.world.units.get('h-local').slot", 3);
  equal("h.world.units.get('h-peer').slot", 1);
  equal("h.world.units.get('h-late').champId", "witch");
  equal("h.matchGeneration", 5);
  equal("h.net.writes[0].matchGeneration", 5);
  equal("h.worldView.resets+h.fx.resets+h.fx.audio.begins", 3);
  equal("h.hud.resets", 1);
  equal("h.hints.resets", 1);
  equal("h.hud.resetNow", 0);
  equal("h.hud.resetPlayer", "h-local");
  run("h.rematch();h.prepareOnline()");
  equal("h.matchGeneration", 5);
  equal("h.worldView.resets", 1);
  equal("h.hud.resets+h.hints.resets", 2);
  const guest = sceneHarness(false, true);
  guest.run("h.prepareOnline();h.rematch()");
  guest.equal("h.net.writes.length", 0);
  guest.equal("h.world.phase", "ended");
  guest.run(
    "h.net.sharedState.snap.phase='playing';h.net.sharedState.matchGeneration=5;h.prepareOnline();h.prepareOnline()",
  );
  guest.equal("h.worldView.resets", 1);
  guest.equal("h.fx.resets", 1);
  guest.equal("h.hud.resets", 1);
  guest.equal("h.hints.resets", 1);
});

test("actual inputs: loss clears stale holds, keeps fresh gap movement, drops queued actions and reannounces current identity", () => {
  for (const host of [true, false]) {
    const { run, equal } = sceneHarness(host);
    run(
      "h.tickOnline(0);controls.onKeyDown({code:'KeyW',repeat:false});h.tickOnline(0);h.net.sent=[];h.net.connectionStatus='disconnected';h.net.notify()",
    );
    equal("controls.moveAxes().fwd", 0);
    run(
      "controls.onKeyDown({code:'KeyD',repeat:false});controls.onKeyDown({code:'Digit1',repeat:false});h.tickOnline(0)",
    );
    equal("h.net.sent.length", 0);
    run("h.net.connectionStatus='connected';h.net.notify();h.tickOnline(0)");
    equal("controls.moveAxes().strafe", 1);
    equal("h.net.sent.some(e=>e[1].kind==='cast')", false);
    equal("h.net.sent.some(e=>e[1].kind==='join')", true);
    equal(
      host
        ? "Math.hypot(h.localUnit().moveX,h.localUnit().moveY)>0"
        : "h.net.sent.some(e=>e[1].kind==='input'&&Math.hypot(e[1].mx,e[1].my)>0)",
      true,
    );
    run(
      "h.net.connectionStatus='disconnected';h.net.notify();controls.onKeyUp({code:'KeyD'});h.net.connectionStatus='connected';h.net.notify();h.tickOnline(0)",
    );
    equal(
      host
        ? "Math.hypot(h.localUnit().moveX,h.localUnit().moveY)"
        : "Math.hypot(h.net.sent.at(-1)[1].mx,h.net.sent.at(-1)[1].my)",
      0,
    );
  }
});

test("actual pause/controls/touch/pad: release once, reject local commands, preserve live remote simulation and drain resume edges", () => {
  const { run, equal, event } = sceneHarness();
  run(
    "h.tickOnline(0);controls.onKeyDown({code:'KeyW',repeat:false});controls.lmb=true;touch.move={id:1,baseX:0,baseY:0,dx:1,dy:0};touch.aim={id:2,baseX:0,baseY:0,dx:1,dy:0};h.pauseAudio()",
  );
  equal("controls.moveAxes().fwd", 0);
  equal("touch.attackDown()", false);
  equal("h.localUnit().attackHeld", false);
  event({ kind: "input", mx: 1, my: 0, ax: 0, ay: 1, attack: false });
  equal("h.world.units.get('h-peer').moveX", 1);
  run("h.requestBuy('boots');h.tickOnline(0.05)");
  equal("h.localUnit().items.length", 0);
  equal("h.world.gameTime>61", true);
  run(
    "pads=[{connected:true,axes:[0,0,0,0],buttons:[{pressed:true,value:1}]}];h.resumeAudio();controls.update(0.03)",
  );
  equal("controls.consumeJump()", false);
  run(
    "pads[0].buttons[0]={pressed:false,value:0};controls.update(0.03);pads[0].buttons[0]={pressed:true,value:1};controls.update(0.03)",
  );
  equal("controls.consumeJump()", true);
  const guest = sceneHarness(false);
  guest.run(
    "h.tickOnline(0);h.net.connectionStatus='disconnected';h.net.notify();h.pauseAudio();h.net.sent=[];h.net.connectionStatus='connected';h.net.playerId='replacement';h.net.players.replacement={id:'replacement',connected:true};h.net.sharedState.snap.units['h-replacement']=structuredClone(h.net.sharedState.snap.units['h-local']);h.net.sharedState.snap.units['h-replacement'].id='h-replacement';h.net.notify();h.tickOnline(0);h.tickOnline(0)",
  );
  guest.equal("h.net.sent.filter(e=>e[1].kind==='input').length", 1);
  guest.equal("h.localId", "h-replacement");
});

test("actual scene rejects disconnected/spoofed events and malformed snapshots without seeding", () => {
  const { run, equal, event } = sceneHarness();
  run("h.prepareOnline();h.net.players.peer.connected=false");
  event({ kind: "input", mx: 1, my: 1, attack: true });
  event({ kind: "join", champId: "mage", name: "Spoof" }, "outsider");
  equal("h.world.units.get('h-peer').moveX", 0);
  equal("h.picks.outsider", undefined);
  run(
    "h.net.connectionStatus='disconnected';h.net.notify();h.net.sharedState.snap={broken:true};h.net.connectionStatus='connected';h.net.notify();h.tickOnline(1)",
  );
  equal("h.hostReady", false);
  equal("h.world.gameTime", 61);
  equal("h.net.writes.length", 0);
});

test("authored Q/leaping strikes and live projectile outcomes survive promotion exactly", () => {
  let pendingStrikes = 0;
  let pendingProjectiles = 0;
  const keys: ("Q" | "JUMP")[] = ["Q", "JUMP"];
  for (const champId of Object.keys(CHAMP_BY_ID))
    for (const key of keys) {
      const host = createWorld(42);
      const caster = human(host, "caster", 0, champId);
      const victim = human(host, "victim", 1);
      caster.x = 0;
      caster.y = 0;
      victim.x = 2;
      victim.y = 0;
      host.now = 1000;
      host.gameTime = 1;
      assert.equal(
        requestCast(host, caster, key, { point: { x: 2, y: 0 }, dir: { x: 1, y: 0 } }),
        true,
        champId + key,
      );
      pendingStrikes += host.strikes.length;
      const promoted = emptyGuestWorld();
      restoreHostState(promoted, encodeWorld(host));
      host.fx.length = 0;
      let testedFlight = false;
      for (let i = 0; i < 60; i++) {
        step(host);
        step(promoted);
        if (!testedFlight && host.projectiles.size > 0) {
          pendingProjectiles += host.projectiles.size;
          restoreHostState(promoted, encodeWorld(host));
          host.fx.length = 0;
          testedFlight = true;
        }
      }
      assert.deepEqual(encodeWorld(promoted), encodeWorld(host), champId + key);
      assert.deepEqual(promoted.fx, host.fx, champId + key);
    }
  assert.ok(pendingStrikes > 0);
  assert.ok(pendingProjectiles > 0);
});

test("actual scene accepted remote cast emits once; cooldown tail remains buffered across handoff", () => {
  const { run, equal, event } = sceneHarness();
  run("h.prepareOnline();h.world.units.get('h-peer').abilities.Q.readyAt=0");
  event({ kind: "cast", key: "Q", px: 0, py: 0, ax: 1, ay: 0 });
  equal("h.world.fx.filter(e=>e.t==='cast').length", 1);
  run("const acceptedCooldown = h.world.units.get('h-peer').abilities.Q.readyAt");
  event({ kind: "cast", key: "Q", px: 0, py: 0, ax: 1, ay: 0 });
  equal("h.world.fx.filter(e=>e.t==='cast').length", 1);
  equal("h.world.units.get('h-peer').abilities.Q.readyAt === acceptedCooldown", true);
  run("h.world.units.get('h-peer').abilities.Q.readyAt=h.world.now+100");
  event({ kind: "cast", key: "Q", px: 0, py: 0, ax: 1, ay: 0 });
  equal("h.world.units.get('h-peer').queuedCast.key", "Q");
  run(
    "h.net.sharedState.snap=structuredClone(encodeWorld(h.world));h.world.fx.length=0;h.net.connectionStatus='disconnected';h.net.notify();h.net.connectionStatus='connected';h.net.notify();h.prepareOnline();for(let i=0;i<10;i++)step(h.world)",
  );
  equal("h.world.units.get('h-peer').queuedCast === null", true);
  equal("h.world.fx.filter(e=>e.t==='cast'&&e.champId==='ranger').length", 1);
});
