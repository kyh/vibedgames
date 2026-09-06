import assert from "node:assert/strict";
import { test } from "node:test";
import { Hints } from "../src/render/hints.ts";
import { createWorld, spawnHero } from "../src/sim/world.ts";
import { encodeWorld } from "../src/net/snapshot.ts";
import { ALL_ABILITY_KEYS } from "../src/sim/types.ts";

// Actual HUD methods with explicit DOM/audio collaborators. These checks prove
// world-clock behavior and ownership; they make no browser/layout/audio claim.
function element() {
  const classes = new Set();
  return {
    hidden: false,
    textContent: "old",
    innerHTML: "old",
    offsetWidth: 10,
    removed: 0,
    remove() {
      this.removed++;
    },
    style: {
      opacity: "1",
      setProperty(key, value) {
        this[key] = value;
      },
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
Object.assign(globalThis, {
  window: { matchMedia: () => ({ matches: false }) },
  document: { body: element(), pointerLockElement: {}, hidden: false },
  localStorage: { setItem: () => assert.fail("reset must not record another result") },
});
const { Hud } = await import("../src/render/hud.ts");

function fixture() {
  const world = createWorld(77);
  const me = spawnHero(world, {
    id: "h-local",
    ownerId: "local",
    team: "local",
    champId: "mage",
    name: "Local",
    slot: 0,
    isBot: false,
  });
  const cues = [];
  const feedRow = element();
  const toastRow = element();
  const plate = element();
  const abilityEls = new Map(
    ALL_ABILITY_KEYS.map((key) => [
      key,
      {
        wrap: element(),
        img: element(),
        pips: element(),
        cdText: element(),
        lastRank: -1,
        lastCd: -1,
        lastText: "old",
        wasOnCd: true,
      },
    ]),
  );
  const hud = Object.assign(Object.create(Hud.prototype), {
    disposed: false,
    presentationPaused: false,
    presentationHidden: false,
    presentationNow: 400000,
    feedRows: [{ el: feedRow, until: 401000 }],
    visibleToasts: [{ el: toastRow, until: 401000 }],
    pendingToasts: [{ text: "old" }],
    confetti: [{ at: 401000 }],
    plates: new Map([["old-hero", { wrap: plate }]]),
    arrowCoin: { el: element(), on: true, lastTf: "old" },
    arrowDelivery: { el: element(), on: true, lastTf: "old" },
    fx: {
      feed: [{}],
      toasts: [{}],
      localHits: [],
      lastDeath: null,
      audio: {
        identity: "same-owner",
        abilityReady: () => cues.push("ready"),
        respawnTick: () => cues.push("tick"),
        respawnGo: () => cues.push("respawn"),
      },
    },
    view: { worldToScreen: (x, y) => ({ x, y, visible: true }) },
    shownEnd: true,
    endEl: element(),
    root: element(),
    shopOpen: true,
    shopEl: element(),
    boardTapped: true,
    boardForced: true,
    boardSig: "old",
    boardEl: element(),
    itemTaps: [1],
    itemSig: "old-item",
    bestStreak: 8,
    sawSuddenDeath: true,
    lastMe: me,
    lastNow: 400000,
    lastReadySoundAt: 399999,
    lastAttackSeen: 399990,
    lastHitSeen: 399900,
    fireUntil: 400110,
    hitFlashUntil: 400140,
    hitDirUntil: 400500,
    hitFlashCrit: true,
    reticleVisible: true,
    reticleEl: element(),
    lastHitDirDeg: 40,
    lastHitDirOp: 30,
    hitDirEl: element(),
    lowHpEl: element(),
    lowHpEl2: element(),
    lastLowOp: 30,
    lastLowOp2: 30,
    hbPhase: 1,
    lastLevel: 20,
    lvlBadge: element(),
    lvlEl: element(),
    hpGhost: 0.3,
    hpFill: element(),
    hpGhostEl: element(),
    hpText: element(),
    hpTicksEl: element(),
    xpFill: element(),
    goldEl: element(),
    respawnShown: true,
    respawnFor: 402000,
    lastRespawnCeil: 2,
    respawnEl: element(),
    respawnSlain: element(),
    respawnTip: element(),
    respawnRing: element(),
    respawnTimer: element(),
    buffSeen: new Map([["haste", { seenAt: 399000, until: 402000 }]]),
    buffEls: new Map([["haste", {}]]),
    buffScratch: [{}],
    buffSig: "haste",
    buffsEl: element(),
    abilityEls,
    champBound: "mage",
    hintText: "old hint",
    hintEl: element(),
    introText: "old intro",
    introEl: element(),
  });
  hud.root.classList.add("ba-ended");
  hud.reticleEl.classList.add("show", "fire", "hit", "hitcrit");
  hud.lvlBadge.classList.add("lvlup");
  for (const el of abilityEls.values()) el.wrap.classList.add("ready");
  return { world, me, hud, cues, feedRow, toastRow, plate };
}

test("actual HUD: 400s→0 removes prior-world UI/cursors without changing world, audio or records", () => {
  const { world, me, hud, cues, feedRow, toastRow, plate } = fixture();
  const before = structuredClone(encodeWorld(world));
  const owner = hud.fx.audio;
  hud.resetMatch(world, me);
  hud.updateHitDir(world, me);
  hud.updateReticle(world, me);
  hud.updateRespawn(world, me);
  hud.updateVitals(world, me);
  hud.updateAbilities(world, me);
  assert.deepEqual(encodeWorld(world), before);
  assert.equal(hud.fx.audio, owner);
  assert.deepEqual(cues, []);
  assert.equal(hud.hitDirEl.style.opacity, "0");
  assert.equal(hud.fireUntil + hud.hitFlashUntil + hud.hitDirUntil, 0);
  assert.equal(hud.respawnEl.hidden, true);
  assert.equal(hud.endEl.hidden, true);
  assert.equal(hud.shopEl.hidden, true);
  assert.equal(hud.boardTapped || hud.boardForced || hud.shownEnd, false);
  assert.equal(hud.root.classList.contains("ba-ended"), false);
  assert.equal(hud.lvlBadge.classList.contains("lvlup"), false);
  assert.equal(hud.lvlEl.textContent, "1");
  assert.equal(hud.hpGhost, 1);
  assert.equal(hud.hintText + hud.introText, "");
  assert.equal(hud.itemSig, "old-item", "normal item diff must still clear the old belt");
  assert.equal(hud.itemTaps.length + hud.buffSeen.size + hud.buffEls.size + hud.plates.size, 0);
  assert.equal(hud.feedRows.length + hud.visibleToasts.length + hud.pendingToasts.length, 0);
  assert.equal(hud.confetti.length + hud.fx.feed.length + hud.fx.toasts.length, 0);
  assert.equal(hud.arrowCoin.on || hud.arrowDelivery.on, false);
  assert.deepEqual([feedRow.removed, toastRow.removed, plate.removed], [1, 1, 1]);
  hud.resetMatch(world, null);
  assert.equal(hud.lastMe, null);
  assert.equal(hud.hpGhost, 1);
  assert.deepEqual([feedRow.removed, toastRow.removed, plate.removed], [1, 1, 1]);
  hud.disposed = true;
  hud.lastNow = 123;
  hud.resetMatch(world, me);
  assert.equal(hud.lastNow, 123);
});

test("actual HUD: fresh hit, cooldown, level and respawn edges work immediately after rewind", () => {
  const { world, me, hud, cues } = fixture();
  hud.resetMatch(world, me);
  hud.updateAbilities(world, me);
  world.now = 100;
  me.lastAttackAt = 100;
  me.lastHitAt = 100;
  me.lastHitDx = 1;
  hud.updateReticle(world, me);
  hud.updateHitDir(world, me);
  assert.equal(hud.fireUntil, 220);
  assert.equal(hud.hitDirUntil, 700);
  assert.equal(hud.hitDirEl.style.opacity, "0.90");
  me.abilities.Q.readyAt = 300;
  hud.updateAbilities(world, me);
  world.now = 400;
  hud.updateAbilities(world, me);
  assert.deepEqual(cues, ["ready"]);
  hud.updateAbilities(world, me);
  assert.deepEqual(cues, ["ready"]);
  hud.updateVitals(world, me);
  me.level = 2;
  hud.updateVitals(world, me);
  assert.equal(hud.lvlBadge.classList.contains("lvlup"), true);
  world.now = 1000;
  hud.updateHitDir(world, me);
  hud.updateReticle(world, me);
  assert.equal(hud.hitDirEl.style.opacity, "0.00");
  assert.equal(hud.reticleEl.classList.contains("fire"), false);
  me.alive = false;
  me.respawnAt = 3000;
  hud.updateRespawn(world, me);
  assert.equal(hud.respawnEl.hidden, false);
  world.now = 3000;
  me.alive = true;
  hud.updateRespawn(world, me);
  hud.updateRespawn(world, me);
  assert.deepEqual(cues, ["ready", "tick", "respawn"]);
});

test("actual HUD: nonzero accepted observations baseline silently and retain pause intent", () => {
  const { world, me, hud, cues } = fixture();
  world.now = 500;
  me.lastAttackAt = 490;
  me.lastHitAt = 480;
  hud.presentationPaused = true;
  hud.resetMatch(world, me);
  assert.equal(hud.presentationPaused, true);
  assert.equal(hud.lastNow, 500);
  assert.equal(hud.lastReadySoundAt, 500);
  hud.updateHitDir(world, me);
  hud.updateReticle(world, me);
  assert.equal(hud.fireUntil + hud.hitDirUntil, 0);
  assert.deepEqual(cues, []);
});

test("actual Hints: rematch clears visible/gap deadlines, keeps learning and rebinds spawn", () => {
  for (const expired of [false, true]) {
    const { world, me } = fixture();
    const messages = [];
    const hints = new Hints(
      () => false,
      (text) => messages.push(text),
    );
    world.now = 400000;
    world.gameTime = 400;
    hints.update(world, me);
    assert.equal(hints.visible?.id, "move");
    if (expired) {
      world.gameTime = 405;
      hints.update(world, me);
      assert.equal(hints.nextAt, 410);
    }
    const learned = hints.shown;
    hints.st.shopRearmed = true;
    hints.st.everInThrone = true;
    hints.resetMatch();
    assert.equal(hints.shown, learned);
    assert.equal(learned.has("move"), true);
    assert.equal(hints.visible, null);
    assert.equal(hints.visibleUntil + hints.nextAt + hints.lastT, 0);
    assert.equal(hints.st.spawnSet, false);
    assert.equal(hints.st.shopRearmed && hints.st.everInThrone, true);
    assert.equal(messages.at(-1), "");
    world.now = world.gameTime = 0;
    me.x = -40;
    me.y = -40;
    me.gold = 0; // keep the unrelated starting-gold shop hint ineligible
    hints.update(world, me);
    assert.equal(hints.visible, null);
    assert.equal(hints.st.spawnX, -40);
    assert.equal(hints.st.spawnY, -40);
    world.now = 13000;
    world.gameTime = 13;
    hints.update(world, me);
    assert.equal(hints.visible?.id, "ability");
    assert.equal(hints.visibleUntil, 17);
    assert.equal(messages.filter((text) => text === "WASD move · mouse aim").length, 1);
    assert.equal(messages.at(-1), "Press 1 — ability");
  }
});
