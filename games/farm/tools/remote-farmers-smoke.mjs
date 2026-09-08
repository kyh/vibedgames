// Actual sender/receiver contract. Rendering doubles record clip seeks, never
// simulate inventory, world edits, tool impacts or network authority.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { fileURLToPath } from "node:url";
const read = (name) =>
  readFileSync(fileURLToPath(new URL(`../src/${name}`, import.meta.url)), "utf8");
const boot = read("scenes/boot-scene.ts");
const declaration = boot.match(/export const CHAR_FRAMES = \{[^]*?\} as const;/)?.[0];
assert.ok(declaration);
const CHAR_FRAMES = new Function(
  `${stripTypeScriptTypes(declaration.replace("export ", ""))};return CHAR_FRAMES`,
)();
const source = read("net/remote-farmers.ts")
  .replace(/^import[^]*?;\n/gm, "")
  .replace(/^export /gm, "");
const json = new Function(
  `${stripTypeScriptTypes(read("json.ts")).replace(/^export /gm, "")};return {isJsonNumber,isJsonObject,isJsonString}`,
)();
const { RemoteFarmers, readFarmer, readFarmerPose, farmerPose } = new Function(
  "Phaser",
  "CHAR_FRAMES",
  "CHAR_ORIGIN_Y",
  "DEPTH",
  ...Object.keys(json),
  `${stripTypeScriptTypes(source, { mode: "transform" })};return {RemoteFarmers,readFarmer,readFarmerPose,farmerPose}`,
)(
  { Math: { Linear: (a, b, k) => a + (b - a) * k } },
  CHAR_FRAMES,
  39.5 / 64,
  { entityBase: 10 },
  ...Object.values(json),
);
const pose = { clip: "dig", frame: 6, elapsed: 12, playing: true, revision: 7 };
for (const patch of [
  { clip: "foreign-texture" },
  { frame: -1 },
  { frame: 13 },
  { frame: 1.2 },
  { elapsed: NaN },
  { elapsed: Infinity },
  { elapsed: -1 },
  { elapsed: 1001 },
  { playing: "true" },
  { revision: -1 },
  { revision: 1.5 },
  { revision: Number.MAX_SAFE_INTEGER + 1 },
])
  assert.equal(readFarmerPose({ ...pose, ...patch }), null);
for (const invalid of [null, {}, [], { x: NaN, y: 0 }, { x: 0, y: Infinity }])
  assert.equal(readFarmer(invalid), null);
assert.deepEqual(readFarmer({ x: 3, y: 4, m: true }), {
  x: 3,
  y: 4,
  m: true,
  f: false,
  pose: null,
});
console.log(
  "ok malformed optional poses cannot select arbitrary textures; legacy positions remain valid",
);
const frames = Object.fromEntries(
  Object.entries(CHAR_FRAMES).map(([key, count]) => [
    `p-${key}`,
    {
      key: `p-${key}`,
      frames: Array.from({ length: count }, (_, i) => ({ index: i + 1, textureFrame: i })),
    },
  ]),
);
function sprite(x, y) {
  const s = {
    x,
    y,
    depth: 0,
    destroyed: false,
    seeks: [],
    plays: [],
    anims: {
      currentAnim: null,
      currentFrame: null,
      isPlaying: false,
      accumulator: 0,
      setCurrentFrame(f) {
        this.currentFrame = f;
        s.seeks.push(f.index);
      },
      pause() {
        this.isPlaying = false;
      },
    },
    play(key) {
      this.anims.currentAnim = frames[key];
      this.anims.isPlaying = true;
      this.plays.push(key);
      return this;
    },
    destroy() {
      this.destroyed = true;
    },
  };
  for (const key of ["setOrigin", "setScale", "setAlpha"]) s[key] = () => s;
  s.setDepth = (n) => ((s.depth = n), s);
  s.setPosition = (x, y) => ((s.x = x), (s.y = y), s);
  s.setFlipX = (f) => ((s.flipX = f), s);
  return s;
}
const scene = { anims: { get: (key) => frames[key] }, add: { sprite, text: sprite } };
const remote = new RemoteFarmers(scene),
  players = { other: { id: "other", state: { x: 12, y: 20, f: true, m: true, pose } } };
remote.sync(players, "local");
remote.update(1 / 60);
const body = remote.farmers.get("other").sprite;
assert.equal(body.anims.currentAnim.key, "p-dig");
assert.equal(body.anims.currentFrame.index, 7);
assert.equal(body.anims.accumulator, 12);
assert.equal(body.x, 12);
for (let n = 0; n < 30; n++) {
  remote.sync(players, "local");
  remote.update(1 / 60);
}
assert.equal(body.seeks.length, 1);
assert.equal(body.plays.filter((v) => v === "p-dig").length, 1);
players.other.state.pose = { ...pose, revision: 6, frame: 1 };
remote.sync(players, "local");
assert.equal(body.seeks.length, 1);
for (const [clip, count] of Object.entries(CHAR_FRAMES)) {
  players.other.state.pose = {
    ...pose,
    clip,
    frame: count - 1,
    revision: ++pose.revision,
    playing: false,
  };
  remote.sync(players, "local");
  remote.update(1 / 60);
  assert.equal(body.anims.currentAnim.key, `p-${clip}`);
  assert.equal(body.anims.currentFrame.index, count);
  assert.equal(body.anims.isPlaying, false);
}
const heldPlays = body.plays.length;
players.other.state.pose = { ...players.other.state.pose, revision: ++pose.revision };
remote.sync(players, "local");
assert.equal(body.plays.length, heldPlays, "new held-pose packets must not restart a stopped clip");
console.log(
  "ok late pose joins seek the accepted frame; repeated/stale updates do not restart; all14 strips seek and hold",
);
players.other.state.pose = {
  ...pose,
  clip: "reeling",
  frame: 2,
  playing: true,
  revision: ++pose.revision,
};
remote.sync(players, "local");
assert.equal(body.anims.isPlaying, true);
players.other.state = { x: 30, y: 40, m: true };
remote.sync(players, "local");
remote.update(0.1);
assert.equal(body.anims.currentAnim.key, "p-walk");
remote.sync({}, "local");
assert.equal(body.destroyed, true);
assert.equal(remote.count(), 0);
console.log(
  "ok resumed fishing, legacy walking and disconnect cleanup preserve original interpolation",
);
const actual = read("scenes/game-scene.ts").match(/^  private updateNet\([^]*?^  }/m)?.[0];
assert.ok(actual);
const Scene = new Function(
    "farmerPose",
    "NET_TICK_HZ",
    "CLOCK_TICK_HZ",
    `${stripTypeScriptTypes(`class Scene {${actual}}`)};return Scene`,
  )(farmerPose, 12, 2),
  sent = [];
const localSprite = sprite(16, 32);
localSprite.flipX = false;
localSprite.play("p-casting");
localSprite.anims.setCurrentFrame(frames["p-casting"].frames[8]);
localSprite.anims.accumulator = 9;
const owner = Object.assign(new Scene(), {
  net: { offline: false, updateMyState: (v) => sent.push(v), players: {}, playerId: "local" },
  netAcc: 0,
  poseRevision: 0,
  player: localSprite,
  moving: false,
  amHost: false,
});
owner.updateNet(1 / 24);
assert.equal(sent.length, 0);
owner.updateNet(1 / 24);
assert.equal(sent.length, 1);
assert.deepEqual(sent[0].pose, {
  clip: "casting",
  frame: 8,
  elapsed: 9,
  playing: true,
  revision: 1,
});
owner.netAcc = 0;
owner.updateNet(1 / 12);
assert.equal(sent[1].pose.revision, 2);
assert.equal(localSprite.seeks.length, 1);
assert.equal(localSprite.plays.length, 1);
console.log(
  "ok actual12Hz sender reads authored frame/subframe without changing local animation or resetting scene revision",
);
