// Actual farm/mine HUDs and shared inventory, keys and touch-pick contract.
// Display plumbing records labels/geometry; text legibility remains native QA.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire, stripTypeScriptTypes } from "node:module";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { HOTBAR } from "../src/systems/inventory.ts";
import { store } from "../src/systems/store.ts";
import { itemIcon, itemName } from "../src/data/items.ts";
import { hotbarGrid, hotbarKey, slotIconScale } from "../src/render/hotbar-layout.ts";
import { skillPerk } from "../src/render/skill-readout.ts";
import { onSceneExit } from "../src/render/scene-lifetime.ts";
import { isPick } from "../src/systems/touch.ts";
import { seasonName, seasonIcon } from "../src/data/calendar.ts";
import { WEATHER_NAME, WEATHER_ICON } from "../src/systems/weather.ts";
import { SKILL_NAMES } from "../src/systems/skills.ts";
import { MAX_ENERGY, CAN_MAX } from "../src/config.ts";
import { CONTROLS } from "../src/controls.ts";

const root = process.env.FARM_HUD_SOURCE_ROOT ?? fileURLToPath(new URL("..", import.meta.url));
function load(relative, name, context) {
  const code = stripTypeScriptTypes(readFileSync(resolve(root, relative), "utf8"), {
    mode: "transform",
  })
    .replace(/^import\b[^;]*;\s*/gm, "")
    .replace(/^export /gm, "");
  return new Function(...Object.keys(context), `${code}; return ${name};`)(
    ...Object.values(context),
  );
}
const require = createRequire(import.meta.url);
const EventEmitter = require("../node_modules/phaser/src/events/EventEmitter.js");
const KeyCodes = require("../node_modules/phaser/src/input/keyboard/keys/KeyCodes.js");
const bindings = load("src/systems/keys.ts", "NUM_KEY_NAMES", {});
const expectedKeys = bindings.map((name) => String.fromCharCode(KeyCodes[name]));
assert.deepEqual(expectedKeys, ["1", "2", "3", "4", "5", "6", "7", "8", "9", "0"]);
assert.deepEqual(
  Array.from({ length: HOTBAR }, (_, i) => hotbarKey(i)),
  [...expectedKeys, "", ""],
);
assert.ok(CONTROLS.some((entry) => entry.method === "keys" && entry.input === "1–9 / 0"));

class Drawable extends EventEmitter {
  x = 0;
  y = 0;
  width = 0;
  height = 0;
  text = "";
  visible = true;
  destroyed = false;
  scaleX = 1;
  scaleY = 1;
  fills = [];
  setPosition(x, y) {
    this.x = x;
    this.y = y;
    return this;
  }
  setText(text) {
    this.text = text;
    return this;
  }
  setVisible(visible) {
    this.visible = visible;
    return this;
  }
  setTexture(key, frame) {
    this.key = key;
    this.frame = frame;
    // Intrinsic sizes measured from the original WebP files; other UI frames are16px.
    const sizes = {
      "obj-ore-coal": [21, 25],
      "obj-ore-copper": [21, 32],
      "obj-ore-crystal": [21, 25],
      "obj-stone": [10, 10],
      "obj-wood": [11, 11],
      "ui-shovel": [14, 14],
    };
    [this.width, this.height] = sizes[key] ?? [16, 16];
    return this;
  }
  setScale(scale) {
    this.scaleX = scale;
    this.scaleY = scale;
    return this;
  }
  setAlpha(alpha) {
    this.alpha = alpha;
    return this;
  }
  fillStyle(color) {
    this.color = color;
    return this;
  }
  fillRoundedRect(x, y, width, height) {
    this.fills.push({ x, y, width, height, color: this.color });
    return this;
  }
  clear() {
    this.fills = [];
    return this;
  }
  destroy() {
    this.destroyed = true;
    this.removeAllListeners();
  }
}
function draw(x = 0, y = 0, width = 0, height = 0) {
  const node = new Drawable();
  Object.assign(node, { x, y, width, height });
  return new Proxy(node, {
    get(target, key, receiver) {
      return key in target ? target[key] : () => receiver;
    },
  });
}
class GameScene {
  events = new EventEmitter();
  controlsPaused = false;
  uiOpen = false;
  canCharge = CAN_MAX;
  day = 1;
  timeMin = 360;
  weather = "sunny";
  season() {
    return "spring";
  }
  actionHint() {
    return null;
  }
}
class MineScene {
  depth = 1;
  savePending = false;
  onLadder() {
    return false;
  }
}
const Phaser = {
  Scene: EventEmitter,
  Scenes: { Events: { SHUTDOWN: "shutdown" } },
  BlendModes: { NORMAL: 0 },
  Math: { Clamp: (n, lo, hi) => Math.min(hi, Math.max(lo, n)) },
};
let releasedPads = 0;
const dependencies = {
  Phaser,
  store,
  HOTBAR,
  itemIcon,
  itemName,
  hotbarGrid,
  hotbarKey,
  slotIconScale,
  skillPerk,
  onSceneExit,
  isPick,
  isTouchDevice: () => false,
  seasonName,
  seasonIcon,
  WEATHER_NAME,
  WEATHER_ICON,
  SKILL_NAMES,
  MAX_ENERGY,
  CAN_MAX,
  GameScene,
  MineScene,
  safeAreaInset: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
  attachVirtualGamepad: () => ({
    update() {},
    destroy() {
      releasedPads++;
    },
  }),
  Sound: { click() {} },
};
const Hud = load("src/scenes/hud-scene.ts", "HudScene", dependencies);
const MineHud = load("src/scenes/mine-hud-scene.ts", "MineHudScene", dependencies);
function fixture(Class, game, width, height) {
  const scene = new Class();
  scene.add = {
    graphics: draw,
    image: draw,
    text: (x, y, text) => draw(x, y).setText(text),
    zone: draw,
    container: draw,
  };
  scene.scale = Object.assign(new EventEmitter(), { width, height });
  scene.events = new EventEmitter();
  scene.input = Object.assign(new EventEmitter(), { keyboard: new EventEmitter() });
  scene.scene = { get: () => game };
  scene.textures = { exists: () => true };
  scene.create();
  return scene;
}
const tap = { wasTouch: true, x: 0, y: 0, downX: 0, downY: 0, getDuration: () => 100 };
for (const [width, height] of [
  [1280, 720],
  [390, 844],
  [667, 375],
  [844, 390],
]) {
  store.initNew();
  store.skills.get("combat").level = 10;
  store.hp = 137;
  store.energy = 26.4;
  store.inv.slots[9] = { item: { kind: "resource", res: "copper" }, qty: 99 };
  store.inv.slots[10] = { item: { kind: "resource", res: "coal" }, qty: 17 };
  store.inv.slots[11] = { item: { kind: "resource", res: "wood" }, qty: 8 };
  store.inv.select(9);
  const before = JSON.stringify(store.inv.toJSON());
  const farm = fixture(Hud, new GameScene(), width, height);
  farm.update();
  assert.deepEqual(
    farm.slotNodes.map((node) => node.key.text),
    [...expectedKeys, "", ""],
  );
  assert.equal(farm.slotNodes[9].qty.text, "99");
  assert.equal(farm.toolTip.text, "Copper");
  assert.equal(farm.vitals.hp.text, "HP 137/160");
  assert.equal(farm.vitals.energy.text, "Energy 26/100");
  assert.equal(farm.slotNodes[10].key.visible, false);
  assert.equal(farm.slotNodes[11].key.visible, false);
  for (const node of farm.slotNodes) assert.ok(node.zone.width >= 44 && node.zone.height >= 44);

  const mine = fixture(MineHud, new MineScene(), width, height);
  mine.update();
  assert.deepEqual(
    mine.slotLabels.map((node) => node.key.text),
    [...expectedKeys, "", ""],
  );
  assert.equal(mine.slotLabels[9].qty.text, "99");
  assert.equal(mine.toolTip.text, "Copper");
  assert.equal(mine.vitals.hp.text, "HP 137/160");
  assert.equal(mine.vitals.energy.text, "Energy 26/100");
  for (const icons of [farm.slotNodes.map((node) => node.icon), mine.icons]) {
    for (const index of [0, 9, 10, 11]) {
      const icon = icons[index];
      assert.ok(
        icon.width * icon.scaleX <= 32 && icon.height * icon.scaleY <= 32,
        "large world-object textures fit the existing content box",
      );
      assert.equal(icon.scaleX, icon.scaleY, "original aspect ratio retained");
    }
    assert.equal(icons[0].scaleX, 2, "original UI tool scale retained");
    assert.equal(icons[11].scaleX, 2, "small wood icon is not enlarged beyond its original scale");
  }
  assert.equal(
    JSON.stringify(store.inv.toJSON()),
    before,
    "both views read the same carried inventory",
  );
  for (const zone of mine.zones) assert.ok(zone.width >= 44 && zone.height >= 44);
  const farmEnergy = farm.bars.fills.find((fill) => fill.height === 10 && fill.color === 0xffcf4d);
  const mineEnergy = mine.g.fills.find((fill) => fill.height === 10 && fill.color === 0xffcf4d);
  assert.ok(farmEnergy && mineEnergy, "same low-energy warning in both locations");

  for (const scene of [farm, mine]) {
    const zones = scene === farm ? farm.slotNodes.map((node) => node.zone) : mine.zones;
    zones[11].emit("pointerup", { ...tap, x: 40 });
    assert.equal(store.inv.selected, 9, "movement drag does not select a hotbar slot");
    zones[11].emit("pointerup", tap);
    assert.equal(store.inv.selected, 11, "last unbound slot remains reachable by tap");
    store.inv.select(9);
  }
  store.inv.consumeSlot(9, 1);
  mine.update();
  farm.update();
  assert.equal(mine.slotLabels[9].qty.text, "98");
  assert.equal(farm.slotNodes[9].qty.text, "98");
  mine.trailerHideUi = true;
  mine.update();
  assert.equal(mine.toolTip.visible, false);
  assert.equal(
    mine.slotLabels.every((node) => !node.qty.visible && !node.key.visible),
    true,
  );
  mine.trailerHideUi = false;
  mine.update();
  assert.equal(mine.toolTip.visible, true);
  for (const scene of [farm, mine]) {
    scene.events.emit("shutdown");
    scene.events.emit("destroy");
    assert.equal(scene.scale.listenerCount("resize"), 0);
  }
}
assert.equal(releasedPads, 8);
assert.equal(slotIconScale({ width: 16, height: 16 }, 32), 2);
assert.equal(slotIconScale({ width: 16, height: 16 }, 24), 1.5);
assert.equal(slotIconScale({ width: 21, height: 32 }, 24), 0.75);
console.log("PASS actual keyboard labels match all ten bindings; last two slots stay unlabelled");
console.log(
  "PASS actual farm/mine views preserve quantities, selection and vitals at four geometries",
);
console.log(
  "PASS existing touch drag/tap distinction and 44px targets; hidden trailer UI and scene cleanup",
);
console.log(
  "PASS mixed intrinsic icon sizes stay bounded; original UI and smaller-item scales retained",
);
